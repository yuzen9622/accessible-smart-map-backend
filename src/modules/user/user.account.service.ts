import crypto from "crypto";
import { revokeAllSessionsByUserId } from "./user.auth-session.repository";
import {
  anonymizeHazardReports,
  deleteOwnedRecords,
  deleteUserAndSessions,
  findAccountForDeletion,
  findSessionSignedInAt,
} from "./user.account.repository";
import {
  deleteDocumentsWhere,
  getOrCreateCollection,
} from "../../adapters/chroma.adapter";
import {
  AppleTokenRequestError,
  exchangeAppleAuthorizationCode,
  revokeAppleRefreshToken,
} from "../../adapters/apple-auth.adapter";
import { getAppleSigningConfig } from "../../config/apple";
import { redisDel } from "../../config/redis";
import { MEMORY_CACHE_PREFIX, MEMORY_COLLECTION } from "../../constants/memory";

export const ACCOUNT_DELETION_REAUTH_WINDOW_MS = 5 * 60 * 1000;

export type DeleteAccountFailure =
  | "REAUTH_REQUIRED"
  | "NOT_FOUND"
  | "APPLE_AUTHORIZATION_REQUIRED"
  | "APPLE_AUTHORIZATION_INVALID"
  | "APPLE_REVOKE_UNAVAILABLE";

export type DeleteAccountResult =
  { ok: true } | { ok: false; reason: DeleteAccountFailure };

async function deleteMemoryVectors(userId: string): Promise<void> {
  try {
    const collection = await getOrCreateCollection(MEMORY_COLLECTION);
    await deleteDocumentsWhere(collection, { userId });
  } catch (error) {
    console.warn("[account] memory vector delete unavailable:", error);
  }
}

/**
 * Revokes the app's Sign in with Apple authorization for the account, as App
 * Store rules require on account deletion. Skipped (with an error log) when the
 * Apple signing key is not configured, so deletion itself is never blocked by
 * missing server config.
 *
 * @param appleUserId The account's Apple subject
 * @param authorizationCode A fresh authorizationCode from the client
 * @returns null on success or skip, otherwise why deletion must stop
 */
async function revokeAppleAuthorization(
  appleUserId: string,
  authorizationCode: string | undefined,
): Promise<DeleteAccountFailure | null> {
  const config = getAppleSigningConfig();
  if (!config) {
    console.error(
      "[account] APPLE_TEAM_ID / APPLE_KEY_ID / APPLE_PRIVATE_KEY 未設定，略過 Apple token 撤銷",
    );
    return null;
  }
  if (!authorizationCode) return "APPLE_AUTHORIZATION_REQUIRED";

  try {
    const { refreshToken, sub } = await exchangeAppleAuthorizationCode(
      authorizationCode,
      config,
    );
    if (sub !== appleUserId) return "APPLE_AUTHORIZATION_INVALID";
    await revokeAppleRefreshToken(refreshToken, config);
    return null;
  } catch (error) {
    if (error instanceof AppleTokenRequestError) {
      console.error("[account] Apple token 撤銷失敗:", error.message);
      return error.kind === "rejected"
        ? "APPLE_AUTHORIZATION_INVALID"
        : "APPLE_REVOKE_UNAVAILABLE";
    }
    throw error;
  }
}

/**
 * Permanently deletes an account.
 *
 * The caller's session must have signed in within the re-auth window. An
 * account linked to Sign in with Apple must also supply a fresh Apple
 * authorizationCode, which is exchanged and revoked before anything is
 * deleted. All sessions are then revoked, so a failure part-way leaves the
 * account signed out everywhere but still present: signing in again and
 * retrying finishes it. Owned records are deleted; hazard reports stay public
 * under a pseudonym.
 *
 * @param input.userId The authenticated user's id
 * @param input.sessionId The session the request was authenticated with
 * @param input.appleAuthorizationCode Apple authorizationCode from a fresh sign-in
 * @returns ok, or why the account was not deleted
 */
export async function deleteAccount(input: {
  userId: string;
  sessionId: string;
  appleAuthorizationCode?: string;
}): Promise<DeleteAccountResult> {
  const { userId, sessionId } = input;

  const signedInAt = await findSessionSignedInAt(sessionId, userId);
  if (
    !signedInAt ||
    Date.now() - signedInAt.getTime() > ACCOUNT_DELETION_REAUTH_WINDOW_MS
  ) {
    return { ok: false, reason: "REAUTH_REQUIRED" };
  }

  const account = await findAccountForDeletion(userId);
  if (!account) return { ok: false, reason: "NOT_FOUND" };

  if (account.appleUserId) {
    const failure = await revokeAppleAuthorization(
      account.appleUserId,
      input.appleAuthorizationCode,
    );
    if (failure) return { ok: false, reason: failure };
  }

  await revokeAllSessionsByUserId(userId, "account_deleted");

  await deleteOwnedRecords(userId, account.email);
  await anonymizeHazardReports(userId, `deleted:${crypto.randomUUID()}`);
  await deleteMemoryVectors(userId);
  await redisDel(MEMORY_CACHE_PREFIX + userId);

  await deleteUserAndSessions(userId);
  return { ok: true };
}
