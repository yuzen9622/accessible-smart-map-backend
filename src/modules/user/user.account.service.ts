import crypto from "crypto";
import { findUserById } from "./user.repository";
import { revokeAllSessionsByUserId } from "./user.auth-session.repository";
import {
  anonymizeHazardReports,
  deleteOwnedRecords,
  deleteUserAndSessions,
  findSessionSignedInAt,
} from "./user.account.repository";
import {
  deleteDocumentsWhere,
  getOrCreateCollection,
} from "../../adapters/chroma.adapter";
import { redisDel } from "../../config/redis";
import { MEMORY_CACHE_PREFIX, MEMORY_COLLECTION } from "../../constants/memory";

export const ACCOUNT_DELETION_REAUTH_WINDOW_MS = 5 * 60 * 1000;

export type DeleteAccountResult =
  { ok: true } | { ok: false; reason: "REAUTH_REQUIRED" | "NOT_FOUND" };

async function deleteMemoryVectors(userId: string): Promise<void> {
  try {
    const collection = await getOrCreateCollection(MEMORY_COLLECTION);
    await deleteDocumentsWhere(collection, { userId });
  } catch (error) {
    console.warn("[account] memory vector delete unavailable:", error);
  }
}

/**
 * Permanently deletes an account.
 *
 * The caller's session must have signed in within the re-auth window. All
 * sessions are revoked first, so a failure part-way leaves the account signed
 * out everywhere but still present: signing in again and retrying finishes it.
 * Owned records are deleted; hazard reports stay public under a pseudonym.
 *
 * @param input.userId The authenticated user's id
 * @param input.sessionId The session the request was authenticated with
 * @returns ok, or why the account was not deleted
 */
export async function deleteAccount(input: {
  userId: string;
  sessionId: string;
}): Promise<DeleteAccountResult> {
  const { userId, sessionId } = input;

  const signedInAt = await findSessionSignedInAt(sessionId, userId);
  if (
    !signedInAt ||
    Date.now() - signedInAt.getTime() > ACCOUNT_DELETION_REAUTH_WINDOW_MS
  ) {
    return { ok: false, reason: "REAUTH_REQUIRED" };
  }

  const user = await findUserById(userId);
  if (!user) return { ok: false, reason: "NOT_FOUND" };

  await revokeAllSessionsByUserId(userId, "account_deleted");

  await deleteOwnedRecords(userId, user.email);
  await anonymizeHazardReports(userId, `deleted:${crypto.randomUUID()}`);
  await deleteMemoryVectors(userId);
  await redisDel(MEMORY_CACHE_PREFIX + userId);

  await deleteUserAndSessions(userId);
  return { ok: true };
}
