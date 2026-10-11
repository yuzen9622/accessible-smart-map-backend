import { randomUUID } from "node:crypto";
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
    { $set: { ...fields, registrationVersion: randomUUID() } },
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
  entries: Pick<
    IPushToken,
    "token" | "authSessionId" | "registrationVersion"
  >[],
  options: { maxTimeMS?: number; timeoutMS?: number } = {},
): Promise<number> {
  if (!entries.length) return 0;
  const result = await PushToken.deleteMany(
    {
      $or: entries.map(({ token, authSessionId, registrationVersion }) => ({
        token,
        authSessionId,
        // A re-registration rotates the version, so a delayed cleanup of the old
        // registration cannot remove the fresh one even in the same session. A
        // snapshot without a version matches only a still-unversioned row.
        registrationVersion: registrationVersion ?? null,
      })),
    },
    options,
  );
  return result.deletedCount;
}

const REGISTRATION_DB_OPTIONS = { maxTimeMS: 5_000, timeoutMS: 5_000 };

/**
 * Gives a registration created before receipt tracking a version, atomically
 * and only if the very same registration (id, token, owner, session) still has
 * none, then returns the stored version. A concurrent re-registration changes
 * the identity or rotates the version, so a stale snapshot never adopts it.
 *
 * @param token The registration as read
 * @returns The registration's version, or null when it no longer matches
 */
export async function ensureRegistrationVersion(
  token: Pick<
    IPushToken,
    "_id" | "token" | "userId" | "authSessionId" | "registrationVersion"
  >,
): Promise<string | null> {
  if (token.registrationVersion) return token.registrationVersion;
  const identity = {
    _id: token._id,
    token: token.token,
    userId: token.userId,
    authSessionId: token.authSessionId,
  };
  const version = randomUUID();
  await PushToken.updateOne(
    { ...identity, registrationVersion: null },
    { $set: { registrationVersion: version } },
    REGISTRATION_DB_OPTIONS,
  );
  const stored = await PushToken.findOne(
    { ...identity, registrationVersion: { $ne: null } },
    "registrationVersion",
    REGISTRATION_DB_OPTIONS,
  ).lean<Pick<IPushToken, "registrationVersion">>();
  return stored?.registrationVersion ?? null;
}

/**
 * Deletes exactly one registration generation. Matches id, version, owner and
 * session so a re-registration, ownership transfer or recreation is preserved.
 *
 * @returns Whether the registration was deleted
 */
export async function deleteRegistrationGeneration(
  target: Pick<
    import("../../types/push-receipt").IPushReceipt,
    "tokenId" | "registrationVersion" | "userId" | "authSessionId"
  >,
): Promise<boolean> {
  const result = await PushToken.deleteOne(
    {
      _id: target.tokenId,
      registrationVersion: target.registrationVersion,
      userId: target.userId,
      authSessionId: target.authSessionId,
    },
    REGISTRATION_DB_OPTIONS,
  );
  return result.deletedCount > 0;
}
