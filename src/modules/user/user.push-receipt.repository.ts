import { randomUUID } from "node:crypto";
import PushReceipt from "../../model/push-receipt.model";
import DeletedAccount from "../../model/deleted-account.model";
import PushToken from "../../model/push-token.model";
import User from "../../model/user.model";
import { PUSH_RECEIPT } from "../../constants/push";
import type { IPushReceipt } from "../../types/push-receipt";
import type { IPushToken } from "../../types";

const DB = {
  maxTimeMS: PUSH_RECEIPT.dbTimeoutMs,
  timeoutMS: PUSH_RECEIPT.dbTimeoutMs,
};
const RELEASE = { leaseToken: "", leaseExpiresAt: "" };
const ACTIVE_STATES = ["pending", "cleanup_pending"] as const;

export type ClaimedReceipt = IPushReceipt & { leaseToken: string };

/**
 * Persists a tracking placeholder BEFORE the send so every external send is
 * traceable. The account is rechecked after the insert: a deletion tombstone
 * registered before the check removes the placeholder here, one registered
 * after it is purged by the deletion sweep that follows the tombstone.
 *
 * @returns The attempt id, or null when the account is gone (do not send)
 */
export async function reserveReceiptAttempt(
  token: Pick<IPushToken, "_id" | "userId" | "authSessionId"> & {
    registrationVersion: string;
  },
  now = new Date(),
): Promise<string | null> {
  const attemptId = randomUUID();
  await PushReceipt.insertMany(
    [
      {
        attemptId,
        userId: token.userId,
        tokenId: String(token._id),
        registrationVersion: token.registrationVersion,
        authSessionId: token.authSessionId,
        state: "awaiting_ticket",
        attempts: 0,
        nextAttemptAt: new Date(now.getTime() + PUSH_RECEIPT.firstDelayMs),
        deadlineAt: new Date(now.getTime() + PUSH_RECEIPT.deadlineMs),
        createdAt: now,
        expiresAt: new Date(now.getTime() + PUSH_RECEIPT.retentionMs),
      },
    ],
    { timeoutMS: DB.timeoutMS } as never,
  );
  const [user, deleted, registration] = await Promise.all([
    User.exists({ _id: token.userId }).setOptions(DB),
    DeletedAccount.exists({ userId: token.userId }).setOptions(DB),
    PushToken.exists({
      _id: token._id,
      registrationVersion: token.registrationVersion,
    }).setOptions(DB),
  ]);
  if (user && !deleted && registration) return attemptId;
  await PushReceipt.deleteOne({ attemptId }, DB);
  return null;
}

/** Drops a placeholder whose send was cancelled before reaching Expo. */
export async function discardReceiptAttempt(attemptId: string): Promise<void> {
  await PushReceipt.deleteOne({ attemptId, state: "awaiting_ticket" }, DB);
}

/**
 * Attaches the accepted ticket to its EXISTING placeholder only (never
 * upserts), so a purged or expired attempt cannot be resurrected.
 */
export async function attachReceiptTicket(
  attemptId: string,
  ticketId: string,
  now = new Date(),
): Promise<boolean> {
  const result = await PushReceipt.updateOne(
    { attemptId, state: "awaiting_ticket" },
    {
      $set: {
        state: "pending",
        ticketId,
        nextAttemptAt: new Date(now.getTime() + PUSH_RECEIPT.firstDelayMs),
      },
    },
    DB,
  );
  return result.modifiedCount > 0;
}

/**
 * Records a ticket that never became accepted (no receipt will exist) with a
 * controlled code. Only a provider-reported rejection is `failed`; an ambiguous
 * transport failure cannot prove non-delivery and is recorded as `unknown`.
 */
export async function failReceiptAttempt(
  attemptId: string,
  errorCode: string,
  state: "failed" | "unknown" | "cleanup_pending" = "failed",
): Promise<void> {
  await PushReceipt.updateOne(
    { attemptId, state: "awaiting_ticket" },
    {
      $set: {
        state,
        errorCode,
        ...(state === "cleanup_pending"
          ? { nextAttemptAt: new Date(Date.now() + PUSH_RECEIPT.backoffBaseMs) }
          : {}),
      },
    },
    DB,
  );
}

/** Completes immediate-ticket cleanup only if a worker has not claimed it. */
export async function finishImmediateReceiptCleanup(
  attemptId: string,
): Promise<void> {
  await PushReceipt.updateOne(
    { attemptId, state: "cleanup_pending", leaseToken: null },
    { $set: { state: "failed" } },
    DB,
  );
}

/**
 * Converges interrupted placeholders and overdue tracking to `unknown`
 * (never a resend) and prunes records past retention.
 */
export async function expireReceipts(now = new Date()): Promise<void> {
  await PushReceipt.updateMany(
    {
      state: "awaiting_ticket",
      createdAt: {
        $lte: new Date(now.getTime() - PUSH_RECEIPT.awaitingTicketGraceMs),
      },
    },
    { $set: { state: "unknown", errorCode: "ticket_not_recorded" } },
    DB,
  );
  await PushReceipt.updateMany(
    {
      state: { $in: [...ACTIVE_STATES] },
      deadlineAt: { $lte: now },
      $or: [{ leaseExpiresAt: null }, { leaseExpiresAt: { $lte: now } }],
    },
    {
      $set: { state: "unknown", errorCode: "receipt_deadline" },
      $unset: { leaseToken: "", leaseExpiresAt: "" },
    },
    DB,
  );
  await PushReceipt.deleteMany({ expiresAt: { $lte: now } }, DB);
}

/** Atomically claims one due record under a fresh lease token, or null. */
export async function claimDueReceipt(
  now = new Date(),
): Promise<ClaimedReceipt | null> {
  const claimed = await PushReceipt.findOneAndUpdate(
    {
      state: { $in: [...ACTIVE_STATES] },
      nextAttemptAt: { $lte: now },
      deadlineAt: { $gt: now },
      expiresAt: { $gt: now },
      $or: [{ leaseExpiresAt: null }, { leaseExpiresAt: { $lte: now } }],
    },
    {
      $set: {
        leaseToken: randomUUID(),
        leaseExpiresAt: new Date(now.getTime() + PUSH_RECEIPT.leaseMs),
      },
    },
    { sort: { nextAttemptAt: 1 }, returnDocument: "after", ...DB },
  ).lean<ClaimedReceipt>();
  return claimed;
}

/** A claim may only act while its lease, deadline and retention are all live. */
const fence = (claim: ClaimedReceipt, now: Date) => ({
  _id: claim._id,
  leaseToken: claim.leaseToken,
  state: { $in: [...ACTIVE_STATES] },
  leaseExpiresAt: { $gt: now },
  deadlineAt: { $gt: now },
  expiresAt: { $gt: now },
});

/** Whether the claim is still the live, unexpired holder (checked before side effects). */
export async function isReceiptClaimLive(
  claim: ClaimedReceipt,
  now = new Date(),
): Promise<boolean> {
  return Boolean(await PushReceipt.exists(fence(claim, now)).setOptions(DB));
}

/** Gives a claim back unprocessed (e.g. on shutdown) so it is not stuck behind its lease. */
export async function releaseReceiptClaim(
  claim: ClaimedReceipt,
  now = new Date(),
): Promise<void> {
  await PushReceipt.updateOne(fence(claim, now), { $unset: RELEASE }, DB);
}

/** Terminal outcome; a stale lease holder cannot overwrite a newer claim. */
export async function finalizeReceipt(
  claim: ClaimedReceipt,
  state: "provider_accepted" | "failed" | "unknown",
  errorCode: string | null,
  now = new Date(),
): Promise<boolean> {
  const result = await PushReceipt.updateOne(
    fence(claim, now),
    { $set: { state, errorCode }, $unset: RELEASE },
    DB,
  );
  return result.modifiedCount > 0;
}

/**
 * Releases the lease with bounded exponential backoff; exhausted attempts or
 * a next try past the deadline converge to unknown. `state` may switch a
 * receipt to the cleanup retry phase.
 */
export async function rescheduleReceipt(
  claim: ClaimedReceipt,
  errorCode: string,
  opts: { state?: "pending" | "cleanup_pending"; now?: Date } = {},
): Promise<boolean> {
  const now = opts.now ?? new Date();
  const attempts = claim.attempts + 1;
  const delay = Math.min(
    PUSH_RECEIPT.backoffBaseMs * 2 ** claim.attempts,
    PUSH_RECEIPT.backoffMaxMs,
  );
  const next = new Date(now.getTime() + delay);
  if (attempts >= PUSH_RECEIPT.maxAttempts || next >= claim.deadlineAt) {
    return finalizeReceipt(
      claim,
      "unknown",
      opts.state === "cleanup_pending" ? "cleanup_failed" : errorCode,
      now,
    );
  }
  const result = await PushReceipt.updateOne(
    fence(claim, now),
    {
      $set: {
        attempts,
        nextAttemptAt: next,
        errorCode,
        ...(opts.state ? { state: opts.state } : {}),
      },
      $unset: RELEASE,
    },
    DB,
  );
  return result.modifiedCount > 0;
}

/** Account deletion / retention: removes every tracking record of the user. */
export async function deleteReceiptsForUser(userId: string): Promise<number> {
  const result = await PushReceipt.deleteMany({ userId }, DB);
  return result.deletedCount;
}
