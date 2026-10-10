import PushToken from "../../model/push-token.model";
import type { IPushToken, PushPlatform } from "../../types";

export interface PushTokenFields {
  token: string;
  userId: string;
  authSessionId: string;
  platform: PushPlatform;
  locale: string;
}

/**
 * Binds a push token to a user and login session, taking it over from any
 * previous owner of the same device.
 *
 * @param fields Token and the owner/session/device fields to store with it
 * @returns The stored token document
 */
export async function upsertPushToken(
  fields: PushTokenFields,
): Promise<IPushToken> {
  const stored = await PushToken.findOneAndUpdate(
    { token: fields.token },
    { $set: fields },
    { upsert: true, returnDocument: "after" },
  ).lean<IPushToken>();
  return stored as IPushToken;
}

/**
 * Removes one of a user's push tokens.
 *
 * @param userId Owner's user id; a token owned by someone else is left alone
 * @param token The Expo push token
 * @returns Whether a token was removed
 */
export async function deletePushTokenForUser(
  userId: string,
  token: string,
): Promise<boolean> {
  const result = await PushToken.deleteOne({ userId, token });
  return result.deletedCount > 0;
}

/**
 * Lists every push token registered to a user.
 *
 * @param userId Owner's user id
 * @returns The user's token documents
 */
export async function findPushTokensByUserId(
  userId: string,
): Promise<IPushToken[]> {
  return PushToken.find({ userId }).lean<IPushToken[]>();
}

/**
 * Removes push tokens by value, e.g. after Expo reports them unregistered. Each
 * entry only matches while it is still bound to the same login session, so a
 * device that re-registered in the meantime keeps its fresh registration.
 *
 * @param entries Tokens with the session they were read under
 * @returns How many tokens were removed
 */
export async function deletePushTokens(
  entries: Pick<IPushToken, "token" | "authSessionId">[],
  options: { maxTimeMS?: number; timeoutMS?: number } = {},
): Promise<number> {
  if (!entries.length) return 0;
  const result = await PushToken.deleteMany(
    {
      $or: entries.map(({ token, authSessionId }) => ({
        token,
        authSessionId,
      })),
    },
    options,
  );
  return result.deletedCount;
}
