import type { IHazardReport } from "../../types";
import type {
  HazardAiReview,
  HazardAiReviewJob,
} from "../../types/hazard-ai-review";

/**
 * Whitelist view of a stored report. Fields are copied by name, never
 * `delete`d from a spread, so a new internal field (job, intake, lease,
 * storage path, raw EXIF) cannot leak by default.
 */

type Row = Record<string, unknown>;

const PUBLIC_KEYS = [
  "_id",
  "hazardType",
  "severity",
  "expectedUntil",
  "reportedLocation",
  "description",
  "status",
  "confirmCount",
  "denyCount",
  "manualReview",
  "createdAt",
  "updatedAt",
  "expiredAt",
  "deidentifiedAt",
] as const;

const AI_REVIEW_KEYS = [
  "version",
  "state",
  "decision",
  "reasonCode",
  "reason",
  "observations",
  "limitations",
  "requiredEvidence",
  "visibleHazards",
  "queuedAt",
  "startedAt",
  "completedAt",
] as const;

function pick(source: Row, keys: readonly string[]): Row {
  const out: Row = {};
  for (const key of keys) {
    if (source[key] !== undefined) out[key] = source[key];
  }
  return out;
}

function aiReviewView(doc: Row, now: Date): Row | undefined {
  const review = doc.aiReview as (HazardAiReview & Row) | undefined;
  if (!review || typeof review !== "object") return undefined;
  const view = pick(review as Row, AI_REVIEW_KEYS);
  const job = doc.aiReviewJob as Partial<HazardAiReviewJob> | undefined;
  // A queued/processing review whose deadline elapsed (worker or DB down)
  // shows as delayed instead of an endless spinner.
  if (
    (review.state === "queued" || review.state === "processing") &&
    job?.deadlineAt instanceof Date &&
    job.deadlineAt.getTime() <= now.getTime()
  ) {
    view.delayed = true;
  }
  return view;
}

/**
 * Builds the transport view of a report.
 *
 * @param doc The stored report (lean or plain)
 * @param includeReporter True for the reporter's own/admin views
 * @param now Current time, for the `delayed` hint
 */
export function toReportView(
  doc: Partial<IHazardReport> | Row,
  includeReporter: boolean,
  now: Date = new Date(),
): Row {
  const source = doc as Row;
  const view = pick(source, PUBLIC_KEYS);
  view.hasPhoto = Boolean(
    !source.contentScrubbedAt &&
    !source.deidentifiedAt &&
    (source.photoStoragePath || source.photoUrl),
  );
  if (includeReporter && source.reporterId !== undefined) {
    view.reporterId = source.reporterId;
  }
  const exif = source.exifValidation as Row | undefined;
  if (exif) {
    view.exifValidation = pick(exif, [
      "timestampFresh",
      "gpsPresent",
      "gpsMatchesClaimed",
    ]);
  }
  const verification = source.aiVerification as Row | undefined;
  if (verification) {
    view.aiVerification = pick(verification, [
      "verdict",
      "confidence",
      "reason",
    ]);
  }
  const review = aiReviewView(source, now);
  if (review) view.aiReview = review;
  return view;
}
