import { queueReviewNotificationStage } from "./hazard-report.notification-stages";
import HazardReport from "../../model/hazard-report.model";
import { DB_OPTIONS } from "./hazard-report.db";
import { HAZARD_AI } from "../../config/hazard-ai";
import { HAZARD_MSG } from "../../constants/messages";
import type {
  HazardAiDecisionResult,
  HazardAiReview,
  HazardAiReviewJob,
} from "../../types/hazard-ai-review";
import type { HazardType, IHazardReport } from "../../types";
import {
  INTAKE_COMPLETE,
  cancelAiReviewStages,
} from "./hazard-report.predicates";

/**
 * Mongo-only access to the durable AI review job embedded in a hazard report.
 * Every write is a single-document compare-and-set: no whole-snapshot save
 * ever happens here, so account anonymisation, scrub and manual review made in
 * between can never be overwritten with stale data.
 */

/** What a worker holds after winning a claim. Never serialised to clients. */
export interface ClaimedAiJob {
  reportId: string;
  generation: number;
  leaseToken: string;
  attempts: number;
  invalidOutputAttempts: number;
  hazardType: HazardType;
  description?: string;
  storagePath: string;
  imageHash: string;
  mimeType: HazardAiReviewJob["mimeType"];
  model: string;
  policyVersion: string;
  deadlineAt: Date;
}

/** The identity of an owned lease, used to fence every worker write. */
export interface LeaseFence {
  reportId: string;
  generation: number;
  leaseToken: string;
}

const DB_MS = HAZARD_AI.dbTimeoutMs;

/**
 * Builds the initial v2 state set atomically with the photo becoming ready.
 *
 * @param now Enqueue time
 * @param expiredAt The report expiry; the job deadline is the earlier of this and now+deadlineMs
 * @param params The frozen model, policy and image identity
 */
export function buildQueuedReview(
  now: Date,
  expiredAt: Date,
  params: {
    model: string;
    policyVersion: string;
    imageHash: string;
    mimeType: HazardAiReviewJob["mimeType"];
  },
): {
  aiReview: HazardAiReview;
  aiReviewJob: HazardAiReviewJob;
  aiVerification: IHazardReport["aiVerification"];
} {
  const deadlineAt = new Date(
    Math.min(now.getTime() + HAZARD_AI.deadlineMs, expiredAt.getTime()),
  );
  return {
    aiReview: {
      version: 2,
      state: "queued",
      reasonCode: "QUEUED",
      reason: HAZARD_MSG.AI_QUEUED,
      queuedAt: now,
    },
    aiReviewJob: {
      generation: 1,
      attempts: 0,
      nextAttemptAt: now,
      deadlineAt,
      model: params.model,
      policyVersion: params.policyVersion,
      imageHash: params.imageHash,
      mimeType: params.mimeType,
    },
    aiVerification: {
      verdict: "skipped",
      confidence: 0,
      reason: HAZARD_MSG.AI_QUEUED,
    },
  };
}

function ownerFilter(fence: LeaseFence, now: Date): Record<string, unknown> {
  return {
    _id: fence.reportId,
    "aiReviewJob.generation": fence.generation,
    "aiReviewJob.leaseToken": fence.leaseToken,
    "aiReviewJob.leaseExpiresAt": { $gt: now },
    "aiReview.state": "processing",
    status: "pending",
    contentScrubbedAt: { $exists: false },
    manualReview: { $exists: false },
    expiredAt: { $gt: now },
    ...INTAKE_COMPLETE,
  };
}

/**
 * Atomically claims one due job: queued and due, or processing with an expired
 * lease, with attempts left and the deadline still ahead. Sets a fresh lease
 * token and consumes one attempt.
 *
 * @param now Current time
 * @param leaseToken Fresh unguessable token for this claim
 * @returns The claimed job, or null when nothing is due
 */
export async function claimNextAiJob(
  now: Date,
  leaseToken: string,
): Promise<ClaimedAiJob | null> {
  const doc = await HazardReport.findOneAndUpdate(
    {
      status: "pending",
      expiredAt: { $gt: now },
      contentScrubbedAt: { $exists: false },
      manualReview: { $exists: false },
      photoStoragePath: { $exists: true },
      "aiReviewJob.attempts": { $lt: HAZARD_AI.maxAttempts },
      "aiReviewJob.deadlineAt": { $gt: now },
      ...INTAKE_COMPLETE,
      $or: [
        {
          "aiReview.state": "queued",
          "aiReviewJob.nextAttemptAt": { $lte: now },
        },
        {
          "aiReview.state": "processing",
          "aiReviewJob.leaseExpiresAt": { $lte: now },
        },
      ],
    },
    {
      $set: {
        "aiReview.state": "processing",
        "aiReview.startedAt": now,
        "aiReviewJob.leaseToken": leaseToken,
        "aiReviewJob.leaseExpiresAt": new Date(
          now.getTime() + HAZARD_AI.leaseMs,
        ),
      },
      $inc: { "aiReviewJob.attempts": 1 },
    },
    {
      returnDocument: "after",
      sort: { "aiReviewJob.nextAttemptAt": 1 },
      projection: {
        hazardType: 1,
        description: 1,
        photoStoragePath: 1,
        aiReviewJob: 1,
      },
    },
  )
    .maxTimeMS(DB_MS)
    .setOptions(DB_OPTIONS)
    .lean<
      | (Pick<
          IHazardReport,
          "hazardType" | "description" | "photoStoragePath"
        > & {
          _id: unknown;
          aiReviewJob: HazardAiReviewJob;
        })
      | null
    >();
  if (!doc?.aiReviewJob || !doc.photoStoragePath) return null;
  const job = doc.aiReviewJob;
  return {
    reportId: String(doc._id),
    generation: job.generation,
    leaseToken,
    attempts: job.attempts,
    invalidOutputAttempts: job.invalidOutputAttempts ?? 0,
    hazardType: doc.hazardType,
    description: doc.description ?? undefined,
    storagePath: doc.photoStoragePath,
    imageHash: job.imageHash,
    mimeType: job.mimeType,
    model: job.model,
    policyVersion: job.policyVersion,
    deadlineAt: job.deadlineAt,
  };
}

const LEASE_UNSET = ["aiReviewJob.leaseToken", "aiReviewJob.leaseExpiresAt"];

/**
 * Persists a finished content decision and its legacy projection in one
 * fenced update. Rejects (returns false) once the lease, generation, deadline,
 * report state or privacy state changed: the caller drops the result.
 *
 * @param fence Owned lease identity
 * @param result The decision
 * @param now Current time
 * @returns True when this call committed the result
 */
export async function finalizeAiReview(
  fence: LeaseFence,
  result: HazardAiDecisionResult,
  now: Date,
): Promise<boolean> {
  const nextStatus =
    result.decision === "supported"
      ? "verified"
      : result.decision === "unsupported"
        ? "rejected"
        : "pending";
  const verdict =
    result.decision === "supported"
      ? "verified"
      : result.decision === "unsupported"
        ? "rejected"
        : "suspicious";
  const outcome = await HazardReport.updateOne(
    {
      ...ownerFilter(fence, now),
      "aiReviewJob.deadlineAt": { $gt: now },
    },
    [
      queueReviewNotificationStage(`ai_${result.decision}`, now),
      {
        $set: {
          aiReview: {
            $mergeObjects: [
              "$aiReview",
              {
                $literal: {
                  state: "completed",
                  decision: result.decision,
                  reasonCode: result.reasonCode,
                  reason: result.reason,
                  observations: result.observations,
                  limitations: result.limitations,
                  requiredEvidence: result.requiredEvidence,
                  visibleHazards: result.visibleHazards,
                  completedAt: now,
                },
              },
            ],
          },
          aiVerification: {
            $literal: {
              verdict,
              confidence: result.confidence,
              reason: result.reason,
              ...(result.prefilter ? { prefilter: result.prefilter } : {}),
              attemptedAt: now,
            },
          },
          status: nextStatus,
          closedAt:
            nextStatus === "rejected"
              ? { $ifNull: ["$closedAt", now] }
              : "$closedAt",
        },
      },
      { $unset: [...LEASE_UNSET, "aiReviewJob.errorCode"] },
    ],
    { updatePipeline: true },
  )
    .maxTimeMS(DB_MS)
    .setOptions(DB_OPTIONS);
  return outcome.modifiedCount > 0;
}

/**
 * Returns an owned job to the queue for a later attempt.
 *
 * @param fence Owned lease identity
 * @param errorCode Controlled internal error code
 * @param nextAttemptAt When it becomes due again
 * @param invalidOutputAttempts Updated MODEL_OUTPUT_INVALID counter
 * @param now Current time
 * @returns True when this call re-queued the job
 */
export async function requeueAiJob(
  fence: LeaseFence,
  errorCode: string,
  nextAttemptAt: Date,
  invalidOutputAttempts: number,
  now: Date,
): Promise<boolean> {
  const outcome = await HazardReport.updateOne(ownerFilter(fence, now), {
    $set: {
      "aiReview.state": "queued",
      "aiReviewJob.nextAttemptAt": nextAttemptAt,
      "aiReviewJob.errorCode": errorCode,
      "aiReviewJob.invalidOutputAttempts": invalidOutputAttempts,
    },
    $unset: { "aiReviewJob.leaseToken": "", "aiReviewJob.leaseExpiresAt": "" },
  })
    .maxTimeMS(DB_MS)
    .setOptions(DB_OPTIONS);
  return outcome.modifiedCount > 0;
}

function failedStages(
  reasonCode: unknown,
  now: Date,
): Record<string, unknown>[] {
  return [
    queueReviewNotificationStage("ai_failed", now),
    {
      $set: {
        aiReview: {
          $mergeObjects: [
            "$aiReview",
            {
              state: "failed",
              reasonCode,
              reason: { $literal: HAZARD_MSG.AI_FAILED },
              completedAt: now,
            },
          ],
        },
        aiReviewJob: {
          $mergeObjects: [
            "$aiReviewJob",
            {
              generation: { $add: ["$aiReviewJob.generation", 1] },
              errorCode: reasonCode,
            },
          ],
        },
        aiVerification: {
          $literal: {
            verdict: "skipped",
            confidence: 0,
            reason: HAZARD_MSG.AI_FAILED,
          },
        },
      },
    },
    { $unset: LEASE_UNSET },
  ];
}

/**
 * Ends an owned job as failed (report stays pending).
 *
 * @param fence Owned lease identity
 * @param errorCode Controlled internal error code
 * @param now Current time
 * @returns True when this call recorded the failure
 */
export async function failAiJob(
  fence: LeaseFence,
  errorCode: string,
  now: Date,
): Promise<boolean> {
  const outcome = await HazardReport.updateOne(
    ownerFilter(fence, now),
    failedStages({ $literal: errorCode }, now),
    { updatePipeline: true },
  )
    .maxTimeMS(DB_MS)
    .setOptions(DB_OPTIONS);
  return outcome.modifiedCount > 0;
}

/**
 * Maintenance convergence. An absolute job/report deadline revokes even a
 * nominally live lease; finalization is already forbidden past that deadline.
 * Attempt exhaustion alone waits for lease expiry. Completed results are never
 * overwritten. This keeps a crashed late claim within the five-minute SLA.
 *
 * @param now Current time
 * @returns How many jobs were failed and cancelled
 */
export async function convergeStuckAiJobs(
  now: Date,
): Promise<{ failed: number; cancelled: number }> {
  const idle = {
    $or: [
      { "aiReview.state": "queued" },
      {
        "aiReview.state": "processing",
        "aiReviewJob.leaseExpiresAt": { $lte: now },
      },
    ],
  };
  const active = { "aiReview.state": { $in: ["queued", "processing"] } };
  const cancelFilter: Record<string, unknown> = {
    ...INTAKE_COMPLETE,
    contentScrubbedAt: { $exists: false },
    $and: [active, { expiredAt: { $lte: now } }],
  };
  const cancelled = await HazardReport.updateMany(
    cancelFilter,
    cancelAiReviewStages(),
    { updatePipeline: true },
  )
    .maxTimeMS(DB_MS)
    .setOptions(DB_OPTIONS);
  const failFilter: Record<string, unknown> = {
    ...INTAKE_COMPLETE,
    status: "pending",
    expiredAt: { $gt: now },
    contentScrubbedAt: { $exists: false },
    manualReview: { $exists: false },
    $or: [
      { $and: [active, { "aiReviewJob.deadlineAt": { $lte: now } }] },
      {
        $and: [
          idle,
          { "aiReviewJob.attempts": { $gte: HAZARD_AI.maxAttempts } },
        ],
      },
    ],
  };
  const failed = await HazardReport.updateMany(
    failFilter,
    failedStages(
      { $ifNull: ["$aiReviewJob.errorCode", "AI_REVIEW_TIMEOUT"] },
      now,
    ),
    { updatePipeline: true },
  )
    .maxTimeMS(DB_MS)
    .setOptions(DB_OPTIONS);
  return {
    failed: failed.modifiedCount,
    cancelled: cancelled.modifiedCount,
  };
}

/** Operational counts only; never payload, text, ids or paths. */
export interface AiQueueSnapshot {
  queued: number;
  processing: number;
  /** processing jobs whose lease already expired (a worker died or stalled). */
  expiredLease: number;
  oldestQueuedAgeMs: number | null;
}

/**
 * Aggregate queue counts for private operations/acceptance scripts.
 *
 * @param now Current time
 */
export async function getAiQueueSnapshot(now: Date): Promise<AiQueueSnapshot> {
  const rows = await HazardReport.aggregate<{
    _id: string;
    count: number;
    oldest?: Date;
    expiredLease: number;
  }>([
    { $match: { "aiReview.state": { $in: ["queued", "processing"] } } },
    {
      $group: {
        _id: "$aiReview.state",
        count: { $sum: 1 },
        oldest: { $min: "$aiReview.queuedAt" },
        expiredLease: {
          $sum: {
            $cond: [{ $lte: ["$aiReviewJob.leaseExpiresAt", now] }, 1, 0],
          },
        },
      },
    },
  ]).option({ maxTimeMS: DB_MS, timeoutMS: DB_MS });
  const queued = rows.find((row) => row._id === "queued");
  const processing = rows.find((row) => row._id === "processing");
  return {
    queued: queued?.count ?? 0,
    processing: processing?.count ?? 0,
    expiredLease: processing?.expiredLease ?? 0,
    oldestQueuedAgeMs: queued?.oldest
      ? Math.max(0, now.getTime() - queued.oldest.getTime())
      : null,
  };
}
