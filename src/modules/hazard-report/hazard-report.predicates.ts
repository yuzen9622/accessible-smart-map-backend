/**
 * Shared Mongo predicates and update-pipeline stages for the v2 review state.
 * Pure data, no I/O, so the repositories, expiry job and retention can all use
 * the same definition of "private intake" and "cancel the active AI job".
 */

/**
 * Private upload intakes (`uploading`) and cleanup tombstones must never be
 * seen by any public, vote, review, dedup, route or worker query. `select:
 * false` does not filter rows, so every query carries this predicate. A missing
 * `photoIntake` (legacy) and `ready` both pass.
 */
export const INTAKE_COMPLETE: Record<string, unknown> = {
  "photoIntake.state": { $nin: ["uploading", "cleanup"] },
};

const ACTIVE_STATES = ["queued", "processing"];

/**
 * Update-pipeline `$set` stage that atomically cancels a queued/processing v2
 * review and bumps the job generation (so any in-flight worker loses its
 * fence). A completed/failed review keeps its historical result. Reports
 * without v2 fields are untouched (a missing expression leaves the field unset).
 */
export function cancelAiReviewStages(): Record<string, unknown>[] {
  const active = { $in: ["$aiReview.state", ACTIVE_STATES] };
  return [
    {
      $set: {
        aiReview: {
          $cond: [
            active,
            {
              $mergeObjects: [
                "$aiReview",
                { state: "cancelled", completedAt: "$$NOW" },
              ],
            },
            "$aiReview",
          ],
        },
        aiReviewJob: {
          $cond: [
            active,
            {
              $mergeObjects: [
                "$aiReviewJob",
                {
                  generation: {
                    $add: [{ $ifNull: ["$aiReviewJob.generation", 0] }, 1],
                  },
                  leaseExpiresAt: "$$NOW",
                },
              ],
            },
            "$aiReviewJob",
          ],
        },
      },
    },
    { $unset: ["aiReviewJob.leaseToken"] },
  ];
}

/**
 * Verified reports that may be treated as active evidence. Legacy verified is
 * unchanged; a v2 report needs a COMPLETED review that is `supported`, or an
 * explicit human verification. A stale `decision` left on a processing/failed
 * record, or a leftover legacy verdict, never qualifies.
 */
export const ACTIVE_VERIFIED_CLAUSE: Record<string, unknown> = {
  $or: [
    { aiReview: { $exists: false } },
    { "aiReview.state": "completed", "aiReview.decision": "supported" },
    { "manualReview.decision": "verified" },
  ],
};

/** Identical eligibility at dedup lookup and the atomic merge linearization. */
export function activeDuplicateClause(
  now: Date,
  staleLegacyBefore: Date,
): Record<string, unknown> {
  return {
    $or: [
      { $and: [{ status: "verified" }, ACTIVE_VERIFIED_CLAUSE] },
      {
        status: "pending",
        "aiReview.state": { $in: ACTIVE_STATES },
        "aiReviewJob.deadlineAt": { $gt: now },
      },
      {
        status: "pending",
        aiReview: { $exists: false },
        "aiVerification.verdict": "skipped",
        createdAt: { $gte: staleLegacyBefore },
      },
    ],
  };
}

/** In-memory twin of {@link ACTIVE_VERIFIED_CLAUSE} for projected records. */
export function isActiveVerifiedRecord(report: {
  aiReview?: { state?: string; decision?: string };
  manualReview?: { decision?: string };
}): boolean {
  if (report.manualReview?.decision === "verified") return true;
  if (!report.aiReview) return true;
  return (
    report.aiReview.state === "completed" &&
    report.aiReview.decision === "supported"
  );
}
