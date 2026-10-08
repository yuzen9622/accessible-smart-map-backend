import { Types } from "mongoose";
import HazardReport from "../../model/hazard-report.model";
import type { HazardStatus, HazardType, IHazardReport } from "../../types";

const EARTH_RADIUS_M = 6_371_000;

// Retention bookkeeping (closedAt, contentScrubbedAt, photoDelete) is internal.
const INTERNAL_SELECT = "-closedAt -contentScrubbedAt -photoDelete";
const PUBLIC_SELECT = `-reporterId -photoStoragePath -confirmedBy -deniedBy ${INTERNAL_SELECT}`;
const MINE_SELECT = `-photoStoragePath -confirmedBy -deniedBy ${INTERNAL_SELECT}`;

const GEO_SELECT =
  "hazardType severity description reportedLocation reporterId confirmedBy status expiredAt";

/**
 * Matches reports carrying at least one confirmation from somebody other than
 * the reporter. Count-only legacy records fail closed.
 */
const INDEPENDENT_CONFIRMATION_EXPR = {
  $gt: [
    {
      $size: {
        $filter: {
          input: {
            $cond: [{ $isArray: "$confirmedBy" }, "$confirmedBy", []],
          },
          as: "voterId",
          cond: { $ne: ["$$voterId", "$reporterId"] },
        },
      },
    },
    0,
  ],
};

/** A hazard report as stored, as a plain object. */
export type HazardReportRecord = IHazardReport & { _id: string };

/** The projection the route-blocking check reads. */
export type HazardGeoProjection = Pick<
  IHazardReport,
  | "_id"
  | "hazardType"
  | "severity"
  | "description"
  | "reportedLocation"
  | "reporterId"
  | "confirmedBy"
  | "status"
  | "expiredAt"
>;

/** The fields a report is created with. */
export interface HazardReportInsert {
  _id: string;
  reporterId: string;
  reportedLocation: { type: "Point"; coordinates: [number, number] };
  hazardType: HazardType;
  severity: IHazardReport["severity"];
  expectedUntil: Date | null;
  description?: string;
  photoUrl: string;
  photoStoragePath: string;
  exifValidation: IHazardReport["exifValidation"];
  aiVerification: IHazardReport["aiVerification"];
  status: HazardStatus;
  expiredAt: Date;
}

function nearQuery(lng: number, lat: number, maxDistanceM: number) {
  return {
    $near: {
      $geometry: { type: "Point", coordinates: [lng, lat] },
      $maxDistance: maxDistanceM,
    },
  };
}

/**
 * Finds a still-active report of the same type at effectively the same place.
 *
 * @param lat Reported latitude
 * @param lng Reported longitude
 * @param radiusM Dedup radius in metres
 * @param hazardType The hazard type being reported
 * @param now Current time, used to exclude already-expired reports
 * @returns The duplicate to merge into, or null
 */
export async function findActiveDuplicate(
  lat: number,
  lng: number,
  radiusM: number,
  hazardType: HazardType,
  now: Date,
): Promise<HazardReportRecord | null> {
  return HazardReport.findOne({
    reportedLocation: nearQuery(lng, lat, radiusM),
    hazardType,
    status: { $in: ["pending", "verified"] },
    expiredAt: { $gt: now },
  }).lean<HazardReportRecord | null>();
}

/**
 * Adds one confirmation vote to a report.
 *
 * @param reportId Report id
 * @param voterId Identity of the confirming party
 * @returns The report after the update, or null when it vanished
 */
export async function addConfirmation(
  reportId: string,
  voterId: string,
): Promise<HazardReportRecord | null> {
  // The one-vote-per-identity rule is enforced in the filter, not just by the
  // caller's earlier read: two concurrent requests from the same voter would
  // otherwise both pass that read and both push, inflating confirmCount and
  // putting the voter in confirmedBy twice.
  return HazardReport.findOneAndUpdate(
    {
      _id: reportId,
      confirmedBy: { $ne: voterId },
      deniedBy: { $ne: voterId },
      // A de-identified report must not collect voter identities again.
      contentScrubbedAt: { $exists: false },
    },
    { $inc: { confirmCount: 1 }, $push: { confirmedBy: voterId } },
    { returnDocument: "after" },
  ).lean<HazardReportRecord | null>();
}

/**
 * Adds one denial vote to a report.
 *
 * @param reportId Report id
 * @param voterId Identity of the denying party
 * @returns The report after the update, or null when it vanished
 */
export async function addDenial(
  reportId: string,
  voterId: string,
): Promise<HazardReportRecord | null> {
  // Same one-vote-per-identity guard as addConfirmation.
  return HazardReport.findOneAndUpdate(
    {
      _id: reportId,
      confirmedBy: { $ne: voterId },
      deniedBy: { $ne: voterId },
      contentScrubbedAt: { $exists: false },
    },
    { $inc: { denyCount: 1 }, $push: { deniedBy: voterId } },
    { returnDocument: "after" },
  ).lean<HazardReportRecord | null>();
}

/**
 * Inserts a new report.
 *
 * @param doc The report to store
 * @returns The stored report
 */
export async function insertReport(
  doc: HazardReportInsert,
): Promise<HazardReportRecord> {
  const created = await HazardReport.create(doc);
  // SAFETY: `doc` supplies every required field, so the created document always
  // matches HazardReportRecord's shape once plainified.
  return created.toObject() as unknown as HazardReportRecord;
}

/**
 * Non-expired reports near a point, nearest first.
 *
 * @param lat Latitude of the search centre
 * @param lng Longitude of the search centre
 * @param radiusM Search radius in metres
 * @param statuses Statuses to include
 * @param hazardType Optional hazard-type filter
 * @param limit Maximum rows
 * @returns Public-projected reports
 */
export async function findNearbyReports(
  lat: number,
  lng: number,
  radiusM: number,
  statuses: HazardStatus[],
  hazardType: HazardType | undefined,
  limit: number,
): Promise<Record<string, unknown>[]> {
  return HazardReport.find({
    reportedLocation: nearQuery(lng, lat, radiusM),
    status: { $in: statuses },
    ...(hazardType ? { hazardType } : {}),
  })
    .select(PUBLIC_SELECT)
    .limit(limit)
    .lean<Record<string, unknown>[]>();
}

/**
 * Confirmed, still-active hazards inside a circle.
 *
 * Uses `$geoWithin`/`$centerSphere` rather than `$near`, because callers filter
 * by their own route geometry afterwards and do not need distance ordering.
 *
 * @param center Circle centre
 * @param radiusM Circle radius in metres
 * @param limit Hard cap on returned documents
 * @param now Current time, used to exclude expired reports
 * @returns Geo-projected hazards
 */
export async function findConfirmedWithin(
  center: { lat: number; lng: number },
  radiusM: number,
  limit: number,
  now: Date,
): Promise<HazardGeoProjection[]> {
  return HazardReport.find({
    reportedLocation: {
      $geoWithin: {
        $centerSphere: [[center.lng, center.lat], radiusM / EARTH_RADIUS_M],
      },
    },
    status: "verified",
    expiredAt: { $gt: now },
    $expr: INDEPENDENT_CONFIRMATION_EXPR,
  })
    .select(GEO_SELECT)
    .limit(limit)
    .lean<HazardGeoProjection[]>();
}

/**
 * One report by id, with reporter-identifying fields stripped.
 *
 * @param id Candidate report id
 * @returns The public view, or null when the id is malformed or unknown
 */
export async function findPublicReportById(
  id: string,
): Promise<Record<string, unknown> | null> {
  if (!Types.ObjectId.isValid(id)) return null;
  return HazardReport.findById(id)
    .select(PUBLIC_SELECT)
    .lean<Record<string, unknown> | null>();
}

/**
 * One reporter's own reports, newest first, with id-based cursor paging.
 *
 * @param reporterId Owner of the reports
 * @param filter Optional status / hazardType narrowing and paging cursor
 * @param limit Page size
 * @returns The reporter's own projected reports
 */
export async function findReportsByReporter(
  reporterId: string,
  filter: {
    statuses?: string[];
    hazardType?: HazardType;
    cursor?: string;
  },
  limit: number,
): Promise<(Record<string, unknown> & { _id: unknown })[]> {
  const query: Record<string, unknown> = { reporterId };
  if (filter.statuses?.length) query.status = { $in: filter.statuses };
  if (filter.hazardType) query.hazardType = filter.hazardType;
  if (filter.cursor && Types.ObjectId.isValid(filter.cursor)) {
    query._id = { $lt: new Types.ObjectId(filter.cursor) };
  }

  return HazardReport.find(query)
    .select(MINE_SELECT)
    .sort({ createdAt: -1 })
    .limit(limit)
    .lean<(Record<string, unknown> & { _id: unknown })[]>();
}

/**
 * One report by id, with every field.
 *
 * @param id Candidate report id
 * @returns The report, or null when the id is malformed or unknown
 */
export async function findReportById(
  id: string,
): Promise<HazardReportRecord | null> {
  if (!Types.ObjectId.isValid(id)) return null;
  return HazardReport.findById(id).lean<HazardReportRecord | null>();
}

/**
 * Reports awaiting manual review, oldest first, with id-based cursor paging.
 *
 * A report needs manual review when it is still `pending` and either the AI
 * verdict is `suspicious`, or the verdict is still `skipped` and the report
 * was created before `staleSkippedBefore` — normal AI processing finishes in
 * seconds, so a `skipped` report older than that means the AI service itself
 * failed rather than being mid-flight.
 *
 * @param staleSkippedBefore Cutoff before which a `skipped` verdict counts as stalled
 * @param cursor Id of the last report from the previous page
 * @param limit Page size
 * @returns The matching reports, admin-projected
 */
export async function findReviewQueueReports(
  staleSkippedBefore: Date,
  cursor: string | undefined,
  limit: number,
): Promise<(Record<string, unknown> & { _id: unknown })[]> {
  const query: Record<string, unknown> = {
    status: "pending",
    $or: [
      { "aiVerification.verdict": "suspicious" },
      {
        "aiVerification.verdict": "skipped",
        createdAt: { $lt: staleSkippedBefore },
      },
    ],
  };
  if (cursor && Types.ObjectId.isValid(cursor)) {
    query._id = { $gt: new Types.ObjectId(cursor) };
  }

  return HazardReport.find(query)
    .select(MINE_SELECT)
    .sort({ createdAt: 1 })
    .limit(limit)
    .lean<(Record<string, unknown> & { _id: unknown })[]>();
}

/**
 * Records a manual review decision and moves the report straight to the
 * corresponding status, bypassing the AI/community path.
 *
 * @param reportId Report id
 * @param manualReview The review record to persist
 * @returns The report after the update, or null when it vanished
 */
export async function setManualReview(
  reportId: string,
  manualReview: {
    reviewerId: string;
    decision: "verified" | "rejected";
    note?: string;
    reviewedAt: Date;
  },
): Promise<HazardReportRecord | null> {
  // Rejecting closes the report (keeping an earlier close time); verifying
  // reopens it, so its retention clock restarts at the next close.
  const closure =
    manualReview.decision === "rejected"
      ? { $min: { closedAt: manualReview.reviewedAt } }
      : { $unset: { closedAt: "" } };
  return HazardReport.findOneAndUpdate(
    { _id: reportId, contentScrubbedAt: { $exists: false } },
    { $set: { manualReview, status: manualReview.decision }, ...closure },
    { returnDocument: "after" },
  ).lean<HazardReportRecord | null>();
}

/** Phase A candidates: closed or expired before the cutoff, not yet scrubbed. */
function scrubDueFilter(cutoff: Date): Record<string, unknown> {
  return {
    contentScrubbedAt: { $exists: false },
    $or: [{ expiredAt: { $lte: cutoff } }, { closedAt: { $lte: cutoff } }],
  };
}

/**
 * One batch of report ids whose content is due for scrubbing.
 *
 * @param cutoff Closure/expiry time limit
 * @param limit Batch size
 */
export async function findReportsDueForScrub(
  cutoff: Date,
  limit: number,
): Promise<string[]> {
  const rows = await HazardReport.find(scrubDueFilter(cutoff))
    .select("_id")
    .limit(limit)
    .lean<{ _id: unknown }[]>();
  return rows.map((row) => String(row._id));
}

/**
 * Retention phase A: removes everything that identifies a person or was
 * written about them — reporter and voter ids, reviewer id and note,
 * description, raw EXIF, AI reason and labels — in one atomic update, leaving
 * type, location, severity, status, counts and timestamps. The due condition
 * is part of the filter, so the update is idempotent and safe to race.
 *
 * @param reportId Report id
 * @param cutoff Closure/expiry time limit
 * @param pseudonym Stand-in for reporter and reviewer ids, unique per report
 * @returns True when this call scrubbed the report
 */
export async function scrubReportContent(
  reportId: string,
  cutoff: Date,
  pseudonym: string,
): Promise<boolean> {
  const result = await HazardReport.updateOne(
    { _id: reportId, ...scrubDueFilter(cutoff) },
    [
      {
        $set: {
          reporterId: pseudonym,
          confirmedBy: [],
          deniedBy: [],
          aiVerification: {
            $mergeObjects: ["$aiVerification", { reason: "[redacted]" }],
          },
          manualReview: {
            $cond: [
              { $eq: [{ $type: "$manualReview" }, "object"] },
              { $mergeObjects: ["$manualReview", { reviewerId: pseudonym }] },
              "$$REMOVE",
            ],
          },
          contentScrubbedAt: "$$NOW",
        },
      },
      {
        $unset: [
          "description",
          "exifValidation.rawExifTime",
          "exifValidation.rawExifLat",
          "exifValidation.rawExifLng",
          "aiVerification.prefilter.detectedLabels",
          "manualReview.note",
        ],
      },
    ],
    { updatePipeline: true },
  );
  return result.modifiedCount > 0;
}

/** Phase B candidates: scrubbed, photo not yet gone, backoff elapsed. */
function photoDueFilter(now: Date): Record<string, unknown> {
  return {
    contentScrubbedAt: { $exists: true },
    deidentifiedAt: { $exists: false },
    $or: [
      { "photoDelete.nextAttemptAt": { $exists: false } },
      { "photoDelete.nextAttemptAt": { $lte: now } },
    ],
  };
}

/**
 * One batch of scrubbed reports whose photo still has to go, least recently
 * retried first so a persistently failing photo cannot hog the batch.
 *
 * @param now Current time
 * @param limit Batch size
 */
export async function findReportsDueForPhotoDelete(
  now: Date,
  limit: number,
): Promise<{ _id: string; photoStoragePath?: string; attempts: number }[]> {
  const rows = await HazardReport.find(photoDueFilter(now))
    .select("_id photoStoragePath photoDelete")
    .sort({ "photoDelete.nextAttemptAt": 1 })
    .limit(limit)
    .lean<
      {
        _id: unknown;
        photoStoragePath?: string;
        photoDelete?: { attempts?: number };
      }[]
    >();
  return rows.map((row) => ({
    _id: String(row._id),
    photoStoragePath: row.photoStoragePath,
    attempts: row.photoDelete?.attempts ?? 0,
  }));
}

/**
 * Retention phase B done: the photo object is gone, so drop its URL and path
 * and mark the report de-identified.
 *
 * @param reportId Report id
 */
export async function markReportDeidentified(reportId: string): Promise<void> {
  await HazardReport.updateOne(
    {
      _id: reportId,
      contentScrubbedAt: { $exists: true },
      deidentifiedAt: { $exists: false },
    },
    {
      $set: { deidentifiedAt: new Date() },
      $unset: { photoUrl: "", photoStoragePath: "", photoDelete: "" },
    },
  );
}

/**
 * Records a failed photo delete and when to retry it.
 *
 * @param reportId Report id
 * @param nextAttemptAt Retry time
 */
export async function deferReportPhotoDelete(
  reportId: string,
  nextAttemptAt: Date,
): Promise<void> {
  await HazardReport.updateOne(
    { _id: reportId, deidentifiedAt: { $exists: false } },
    {
      $inc: { "photoDelete.attempts": 1 },
      $set: { "photoDelete.nextAttemptAt": nextAttemptAt },
    },
  );
}

/**
 * Oldest not-yet-de-identified report whose clock started at or before the
 * deadline, for overdue monitoring.
 *
 * @param deadline Policy deadline instant
 * @returns Its clock start, or null
 */
export async function findOldestOverdueReport(
  deadline: Date,
): Promise<Date | null> {
  const [byExpiry, byClose] = await Promise.all([
    HazardReport.findOne({
      deidentifiedAt: { $exists: false },
      expiredAt: { $lte: deadline },
    })
      .sort({ expiredAt: 1 })
      .select("expiredAt")
      .lean<{ expiredAt?: Date }>(),
    HazardReport.findOne({
      deidentifiedAt: { $exists: false },
      closedAt: { $lte: deadline },
    })
      .sort({ closedAt: 1 })
      .select("closedAt")
      .lean<{ closedAt?: Date }>(),
  ]);
  const times = [byExpiry?.expiredAt, byClose?.closedAt].filter(
    (t): t is Date => t instanceof Date,
  );
  if (!times.length) return null;
  return new Date(Math.min(...times.map((t) => t.getTime())));
}

/**
 * Backfills closedAt on reports rejected before closedAt existed, from their
 * last update (the best available close time). One batch per call.
 *
 * @param limit Batch size
 * @returns How many were backfilled
 */
export async function backfillRejectedClosedAt(limit: number): Promise<number> {
  const filter: Record<string, unknown> = {
    status: "rejected",
    closedAt: { $exists: false },
    contentScrubbedAt: { $exists: false },
  };
  const rows = await HazardReport.find(filter)
    .select("_id")
    .limit(limit)
    .lean<{ _id: unknown }[]>();
  if (!rows.length) return 0;
  const result = await HazardReport.updateMany(
    { ...filter, _id: { $in: rows.map((row) => row._id) } } as Record<
      string,
      unknown
    >,
    [{ $set: { closedAt: "$updatedAt" } }],
    { updatePipeline: true },
  );
  return result.modifiedCount;
}
