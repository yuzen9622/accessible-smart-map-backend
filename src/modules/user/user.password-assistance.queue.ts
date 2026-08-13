import { randomUUID } from "crypto";
import type { CreateOptions } from "mongoose";
import PasswordAssistanceJob from "../../model/password-assistance-job.model";
import type { IPasswordAssistanceJob } from "../../types";

const JOB_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const LOCK_TIMEOUT_MS = 5 * 60 * 1000;
const MAX_ATTEMPTS = 5;
const RETRY_BASE_MS = 30_000;
const MAX_ERROR_LENGTH = 1_000;
const DB_OPERATION_MAX_MS = 10_000;

/** Persist a request before acknowledging it to the client. */
export async function enqueuePasswordAssistance(email: string): Promise<void> {
  // mongoose 9 dropped `writeConcern` from the CreateOptions type, but the
  // runtime still forwards it to the driver (w:majority + j:true durability
  // for a password-reset job is intentionally explicit).
  await PasswordAssistanceJob.create(
    [
      {
        email,
        status: "pending",
        attempts: 0,
        availableAt: new Date(),
        expiresAt: new Date(Date.now() + JOB_RETENTION_MS),
      },
    ],
    {
      writeConcern: { w: "majority", j: true, wtimeout: DB_OPERATION_MAX_MS },
    } as unknown as CreateOptions,
  );
}

/** Atomically claim one due job, including work abandoned by a crashed worker. */
export async function claimPasswordAssistanceJob() {
  const now = new Date();
  const staleBefore = new Date(now.getTime() - LOCK_TIMEOUT_MS);
  const leaseToken = randomUUID();

  return PasswordAssistanceJob.findOneAndUpdate(
    {
      $or: [
        { status: "pending", availableAt: { $lte: now } },
        { status: "processing", lockedAt: { $lte: staleBefore } },
      ],
    },
    {
      $set: { status: "processing", lockedAt: now, leaseToken },
      $inc: { attempts: 1 },
    },
    { new: true, sort: { availableAt: 1, createdAt: 1 }, maxTimeMS: DB_OPERATION_MAX_MS },
  );
}

/** Renew and verify ownership immediately before an irreversible dispatch. */
export async function renewPasswordAssistanceLease(input: {
  jobId: unknown;
  leaseToken: string;
}): Promise<boolean> {
  const result = await PasswordAssistanceJob.updateOne(
    { _id: input.jobId as string, status: "processing", leaseToken: input.leaseToken },
    { $set: { lockedAt: new Date() } },
    { maxTimeMS: DB_OPERATION_MAX_MS },
  );
  return result.matchedCount === 1;
}

/**
 * Persist the first reset-token expiry and return it unchanged on every retry.
 * The lease predicate also fences stale workers before token rotation.
 */
export async function getOrSetPasswordResetExpiry(input: {
  jobId: unknown;
  leaseToken: string;
  ttlMs: number;
}): Promise<Date | null> {
  const now = new Date();
  const firstExpiry = new Date(now.getTime() + input.ttlMs);
  // Aggregation update pipeline: mongoose 9 requires explicit opt-in.
  const job = (await PasswordAssistanceJob.findOneAndUpdate(
    { _id: input.jobId as string, status: "processing", leaseToken: input.leaseToken },
    [
      {
        $set: {
          lockedAt: now,
          tokenExpiresAt: { $ifNull: ["$tokenExpiresAt", firstExpiry] },
        },
      },
    ],
    { new: true, updatePipeline: true, maxTimeMS: DB_OPERATION_MAX_MS },
  )) as IPasswordAssistanceJob | null;
  return job?.tokenExpiresAt ?? null;
}

/** Remove work only if the caller still owns its lease. */
export async function completePasswordAssistanceJob(input: {
  jobId: unknown;
  leaseToken: string;
}): Promise<boolean> {
  const result = await PasswordAssistanceJob.deleteOne(
    {
      _id: input.jobId as string,
      status: "processing",
      leaseToken: input.leaseToken,
    },
    { maxTimeMS: DB_OPERATION_MAX_MS },
  );
  return result.deletedCount === 1;
}

/** Release failed work only if the caller still owns its lease. */
export async function failPasswordAssistanceJob(input: {
  jobId: unknown;
  leaseToken: string;
  attempts: number;
  error: unknown;
}): Promise<boolean> {
  const message = String(input.error instanceof Error ? input.error.message : input.error).slice(
    0,
    MAX_ERROR_LENGTH,
  );

  if (input.attempts >= MAX_ATTEMPTS) {
    const result = await PasswordAssistanceJob.updateOne(
      { _id: input.jobId as string, status: "processing", leaseToken: input.leaseToken },
      {
        $set: {
          status: "failed",
          lastError: message,
          lockedAt: null,
          leaseToken: null,
        },
      },
      { maxTimeMS: DB_OPERATION_MAX_MS },
    );
    return result.matchedCount === 1;
  }

  const delayMs = RETRY_BASE_MS * 2 ** Math.max(0, input.attempts - 1);
  const result = await PasswordAssistanceJob.updateOne(
    { _id: input.jobId as string, status: "processing", leaseToken: input.leaseToken },
    {
      $set: {
        status: "pending",
        lastError: message,
        lockedAt: null,
        leaseToken: null,
        availableAt: new Date(Date.now() + delayMs),
      },
    },
    { maxTimeMS: DB_OPERATION_MAX_MS },
  );
  return result.matchedCount === 1;
}
