import type { InsertManyOptions, mongo } from "mongoose";
import HazardReport from "../../model/hazard-report.model";
import { DB_OPTIONS } from "./hazard-report.db";
import { HAZARD_AI } from "../../config/hazard-ai";
import { HAZARD_MSG } from "../../constants/messages";
import type { HazardType, IHazardReport } from "../../types";
import type { buildQueuedReview } from "./hazard-report.ai-job.repository";
import type { HazardReportRecord } from "./hazard-report.repository";

/**
 * Private photo intake: a report document that exists before its photo is
 * public, plus the anonymous cleanup tombstone left when the upload is
 * abandoned. Every query here filters on `photoIntake.state` explicitly;
 * `select: false` alone does not hide rows from anyone else.
 */

const DB_MS = HAZARD_AI.dbTimeoutMs;
/** Re-delete cadence for a tombstone until its late-upload window closes. */
const CLEANUP_REPEAT_MS = 10 * 60_000;
const CLEANUP_RETRY_BASE_MS = 30_000;
const CLEANUP_RETRY_CAP_MS = 30 * 60_000;

export interface IntakeInsert {
  _id: string;
  reporterId: string;
  reportedLocation: { type: "Point"; coordinates: [number, number] };
  hazardType: HazardType;
  severity: IHazardReport["severity"];
  expectedUntil: Date | null;
  description?: string;
  exifValidation: IHazardReport["exifValidation"];
  expiredAt: Date;
  uploadToken: string;
  storagePath: string;
  deadlineAt: Date;
}

/** A tombstone claimed for one bounded delete attempt. */
export interface ClaimedCleanup {
  reportId: string;
  storagePath: string;
  attempts: number;
  cleanupUntil: Date;
}

/**
 * Inserts the private intake report. It is invisible to every public, vote,
 * review, dedup, route and worker query until {@link commitIntakeReady}.
 * Returns nothing: the created document must not be echoed anywhere.
 *
 * @param doc The intake fields
 */
export async function insertPrivateIntake(doc: IntakeInsert): Promise<void> {
  // insertMany keeps schema validation, defaults and timestamps like create(),
  // and lets the bounded driver timeout apply to the insert.
  await HazardReport.insertMany(
    [
      {
        _id: doc._id,
        reporterId: doc.reporterId,
        reportedLocation: doc.reportedLocation,
        hazardType: doc.hazardType,
        severity: doc.severity,
        expectedUntil: doc.expectedUntil,
        description: doc.description,
        exifValidation: doc.exifValidation,
        aiVerification: {
          verdict: "skipped",
          confidence: 0,
          reason: HAZARD_MSG.AI_QUEUED,
        },
        status: "pending",
        expiredAt: doc.expiredAt,
        photoIntake: {
          state: "uploading",
          uploadToken: doc.uploadToken,
          deadlineAt: doc.deadlineAt,
          storagePath: doc.storagePath,
        },
      },
    ],
    // Mongoose's wrapper type omits driver CSOT, but forwards insert options.
    { timeoutMS: DB_MS } as InsertManyOptions & mongo.BulkWriteOptions,
  );
}

/**
 * Fenced commit: the upload token and an unelapsed intake deadline must still
 * match. Stores the photo identity, queues the review and completes the intake
 * in ONE document update.
 *
 * @param reportId Intake report id
 * @param uploadToken The token this producer inserted with
 * @param now Current time
 * @param photo Uploaded object identity
 * @param queued The initial v2 state from `buildQueuedReview`
 * @returns True when this call made the report ready
 */
export async function commitIntakeReady(
  reportId: string,
  uploadToken: string,
  now: Date,
  photo: { url: string; storagePath: string },
  queued: ReturnType<typeof buildQueuedReview>,
): Promise<boolean> {
  const outcome = await HazardReport.updateOne(
    {
      _id: reportId,
      "photoIntake.state": "uploading",
      "photoIntake.uploadToken": uploadToken,
      "photoIntake.deadlineAt": { $gt: now },
      status: "pending",
      expiredAt: { $gt: now },
      contentScrubbedAt: { $exists: false },
      manualReview: { $exists: false },
    },
    {
      $set: {
        photoUrl: photo.url,
        photoStoragePath: photo.storagePath,
        aiReview: queued.aiReview,
        aiReviewJob: queued.aiReviewJob,
        aiVerification: queued.aiVerification,
        "photoIntake.state": "ready",
      },
    },
  )
    .maxTimeMS(DB_MS)
    .setOptions(DB_OPTIONS);
  return outcome.modifiedCount > 0;
}

/**
 * Reads the intake state for this producer's token, to resolve an
 * acknowledgement that was lost. Never exposes the document.
 *
 * @param reportId Intake report id
 * @param uploadToken The producer's token
 * @returns The state, or null when missing / token mismatch
 */
export async function readIntakeState(
  reportId: string,
  uploadToken: string,
): Promise<"uploading" | "ready" | "cleanup" | null> {
  const doc = await HazardReport.findOne({
    _id: reportId,
    "photoIntake.uploadToken": uploadToken,
  })
    .select("photoIntake.state")
    .maxTimeMS(DB_MS)
    .setOptions(DB_OPTIONS)
    .lean<{ photoIntake?: { state?: "uploading" | "ready" | "cleanup" } }>();
  return doc?.photoIntake?.state ?? null;
}

/**
 * Update pipeline turning an uploading intake into an anonymous tombstone:
 * owner, free text, raw EXIF and location are removed and only the object
 * path and timing needed for cleanup are kept.
 */
function tombstoneStages(
  now: Date,
  pseudonym: string,
): Record<string, unknown>[] {
  return [
    {
      $set: {
        photoIntake: {
          $mergeObjects: [
            "$photoIntake",
            {
              state: "cleanup",
              nextCleanupAt: now,
              cleanupAttempts: 0,
              cleanupUntil: new Date(
                now.getTime() + HAZARD_AI.intakeCleanupGraceMs,
              ),
            },
          ],
        },
        reporterId: { $literal: pseudonym },
        confirmedBy: [],
        deniedBy: [],
        status: "expired",
        closedAt: now,
        contentScrubbedAt: now,
        reportedLocation: { type: "Point", coordinates: [0, 0] },
        aiVerification: {
          verdict: "skipped",
          confidence: 0,
          reason: "[redacted]",
        },
      },
    },
    {
      $unset: [
        "description",
        "exifValidation.rawExifTime",
        "exifValidation.rawExifLat",
        "exifValidation.rawExifLng",
        "photoUrl",
        "photoStoragePath",
        "aiReview",
        "aiReviewJob",
      ],
    },
  ];
}

/**
 * Producer gives up on its own intake (upload failed or timed out). Fenced on
 * the token, so it can never convert a report that already became ready.
 *
 * @param reportId Intake report id
 * @param uploadToken The producer's token
 * @param now Current time
 * @param pseudonym Anonymous stand-in for the reporter
 * @returns True when this call turned the intake into a tombstone
 */
export async function abandonIntake(
  reportId: string,
  uploadToken: string,
  now: Date,
  pseudonym: string,
): Promise<boolean> {
  const outcome = await HazardReport.updateOne(
    {
      _id: reportId,
      "photoIntake.state": "uploading",
      "photoIntake.uploadToken": uploadToken,
    },
    tombstoneStages(now, pseudonym),
    { updatePipeline: true },
  )
    .maxTimeMS(DB_MS)
    .setOptions(DB_OPTIONS);
  return outcome.modifiedCount > 0;
}

/**
 * Maintenance: converts uploads whose deadline elapsed into tombstones. The
 * state and deadline are in the filter, so a report that became ready first is
 * never converted (and its photo never queued for deletion).
 *
 * @param now Current time
 * @param pseudonym Factory for an anonymous stand-in per report
 * @param limit Batch bound
 * @returns How many were converted
 */
export async function convertExpiredIntakes(
  now: Date,
  pseudonym: () => string,
  limit = 50,
): Promise<number> {
  let converted = 0;
  for (let i = 0; i < limit; i++) {
    const doc = await HazardReport.findOneAndUpdate(
      {
        "photoIntake.state": "uploading",
        "photoIntake.deadlineAt": { $lte: now },
      },
      tombstoneStages(now, pseudonym()),
      { updatePipeline: true, projection: { _id: 1 } },
    )
      .maxTimeMS(DB_MS)
      .setOptions(DB_OPTIONS);
    if (!doc) break;
    converted++;
  }
  return converted;
}

/**
 * Claims one due tombstone for a delete attempt by pushing its next time
 * forward (so a second worker skips it) and counting the attempt.
 *
 * @param now Current time
 * @returns The claimed tombstone, or null
 */
export async function claimIntakeCleanup(
  now: Date,
): Promise<ClaimedCleanup | null> {
  const doc = await HazardReport.findOneAndUpdate(
    {
      "photoIntake.state": "cleanup",
      "photoIntake.nextCleanupAt": { $lte: now },
    },
    {
      $set: {
        "photoIntake.nextCleanupAt": new Date(
          now.getTime() + HAZARD_AI.attemptTimeoutMs * 2,
        ),
      },
      $inc: { "photoIntake.cleanupAttempts": 1 },
    },
    {
      returnDocument: "after",
      projection: { photoIntake: 1 },
    },
  )
    .maxTimeMS(DB_MS)
    .setOptions(DB_OPTIONS)
    .lean<Pick<HazardReportRecord, "photoIntake"> & { _id: unknown }>();
  const intake = doc?.photoIntake;
  if (!doc || !intake) return null;
  return {
    reportId: String(doc._id),
    storagePath: intake.storagePath,
    attempts: intake.cleanupAttempts ?? 1,
    cleanupUntil: intake.cleanupUntil ?? now,
  };
}

/**
 * A delete succeeded. The tombstone stays (re-deleting the same known path)
 * until its late-upload window closes, then the anonymous doc is removed.
 *
 * @param claim The claimed tombstone
 * @param now Current time
 * @returns True when the tombstone was removed for good
 */
export async function settleIntakeCleanupSuccess(
  claim: ClaimedCleanup,
  now: Date,
): Promise<boolean> {
  if (now.getTime() >= claim.cleanupUntil.getTime()) {
    const removed = await HazardReport.deleteOne({
      _id: claim.reportId,
      "photoIntake.state": "cleanup",
    })
      .maxTimeMS(DB_MS)
      .setOptions(DB_OPTIONS);
    return removed.deletedCount > 0;
  }
  const next = new Date(
    Math.min(now.getTime() + CLEANUP_REPEAT_MS, claim.cleanupUntil.getTime()),
  );
  await HazardReport.updateOne(
    { _id: claim.reportId, "photoIntake.state": "cleanup" },
    { $set: { "photoIntake.nextCleanupAt": next } },
  )
    .maxTimeMS(DB_MS)
    .setOptions(DB_OPTIONS);
  return false;
}

/**
 * A delete failed: keep the tombstone (never drop tracking) and back off.
 *
 * @param claim The claimed tombstone
 * @param now Current time
 */
export async function settleIntakeCleanupFailure(
  claim: ClaimedCleanup,
  now: Date,
): Promise<void> {
  const delay = Math.min(
    CLEANUP_RETRY_BASE_MS * 2 ** Math.max(0, claim.attempts - 1),
    CLEANUP_RETRY_CAP_MS,
  );
  await HazardReport.updateOne(
    { _id: claim.reportId, "photoIntake.state": "cleanup" },
    { $set: { "photoIntake.nextCleanupAt": new Date(now.getTime() + delay) } },
  )
    .maxTimeMS(DB_MS)
    .setOptions(DB_OPTIONS);
}

/** Operational counts only; never ids or storage paths. */
export interface IntakeSnapshot {
  uploading: number;
  cleanupPending: number;
  /** tombstones still failing after their late-upload window: needs an alert. */
  cleanupOverdue: number;
}

/**
 * Aggregate intake counts for private operations/acceptance scripts.
 *
 * @param now Current time
 */
export async function getIntakeSnapshot(now: Date): Promise<IntakeSnapshot> {
  const count = (filter: Record<string, unknown>) =>
    HazardReport.countDocuments(filter).maxTimeMS(DB_MS).setOptions(DB_OPTIONS);
  const [uploading, cleanupPending, cleanupOverdue] = await Promise.all([
    count({ "photoIntake.state": "uploading" }),
    count({ "photoIntake.state": "cleanup" }),
    count({
      "photoIntake.state": "cleanup",
      "photoIntake.cleanupUntil": { $lte: now },
    }),
  ]);
  return { uploading, cleanupPending, cleanupOverdue };
}
