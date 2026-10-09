import { randomUUID } from "node:crypto";
import { Types } from "mongoose";
import {
  addConfirmation,
  addDenial,
  countActiveVerifiedWithin,
  findActiveDuplicate,
  mergeActiveDuplicate,
  findActiveVerifiedWithin,
  findConfirmedWithin,
  findNearbyReports,
  findPublicReportById,
  findReportById,
  findReportsByReporter,
  findReviewQueueReports,
  setManualReview,
  type HazardGeoProjection,
} from "./hazard-report.repository";
import {
  abandonIntake,
  commitIntakeReady,
  insertPrivateIntake,
  readIntakeState,
} from "./hazard-report.intake.repository";
import { buildQueuedReview } from "./hazard-report.ai-job.repository";
import {
  getHazardPhotoStoragePath,
  uploadHazardPhoto,
} from "../../adapters/gcs.adapter";
import { model as aiModel } from "../../config/ai";
import { HAZARD_AI, HAZARD_AI_POLICY_VERSION } from "../../config/hazard-ai";
import { parsePhotoExif } from "./hazard-report.parse";
import {
  PhotoNormalizationError,
  normalizeHazardPhoto,
} from "./hazard-report.photo";
import { isActiveVerifiedRecord } from "./hazard-report.predicates";
import { toReportView } from "./hazard-report.view";
import { ResponseCode } from "../../types/code";
import { HAZARD_MSG, HAZARD_REASON, MSG } from "../../constants/messages";
import type { HazardStatus, HazardType, IHazardReport } from "../../types";
import type {
  ConfirmedHazard,
  ConfirmInput,
  CreateReportInput,
  MyReportsInput,
  NearbyReportsInput,
  ReviewDecisionInput,
  ReviewQueueInput,
  ServiceResult,
} from "./hazard-report.types";

const DEDUP_RADIUS_M = 50;
const DEFAULT_NEARBY_RADIUS_M = 500;
const MAX_NEARBY_RADIUS_M = 5000;
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;

// Normal AI verification finishes in seconds; a `skipped` verdict still on a
// report older than this means the AI service itself failed, not that it is
// mid-flight, so it needs a human to look at it.
const REVIEW_STALE_SKIPPED_MS = Number(
  process.env.HAZARD_REVIEW_STALE_SKIPPED_MS ?? 10 * 60 * 1000,
);

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
const EXPIRY_MS: Record<HazardType, number> = {
  obstacle: 6 * HOUR_MS,
  construction: 7 * DAY_MS,
  data_error: 30 * DAY_MS,
};

function hasIndependentConfirmation(
  report: Pick<IHazardReport, "reporterId" | "confirmedBy">,
): boolean {
  return (
    typeof report.reporterId === "string" &&
    report.reporterId.length > 0 &&
    Array.isArray(report.confirmedBy) &&
    report.confirmedBy.some(
      (voterId) =>
        typeof voterId === "string" &&
        voterId.length > 0 &&
        voterId !== report.reporterId,
    )
  );
}

function isRouteEligibleHazard(
  report: HazardGeoProjection,
  now: Date,
): boolean {
  return (
    report.status === "verified" &&
    isActiveVerifiedRecord(report) &&
    report.expiredAt instanceof Date &&
    report.expiredAt.getTime() > now.getTime() &&
    hasIndependentConfirmation(report)
  );
}

// Default listing is the active verified set; unverified pending reports are
// reachable by id, by `mine`, or with an explicit status filter.
const DEFAULT_NEARBY_STATUS: HazardStatus[] = ["verified"];

const PHOTO_ERROR_HTTP: Record<string, number> = {
  IMAGE_INVALID: ResponseCode.INVALID_INPUT,
  IMAGE_UNSUPPORTED: ResponseCode.INVALID_INPUT,
  IMAGE_TOO_LARGE: ResponseCode.INVALID_INPUT,
  PHOTO_PROCESSING_UNAVAILABLE: ResponseCode.SERVICE_UNAVAILABLE,
};

function fail(
  httpCode: number,
  reason: keyof typeof HAZARD_REASON,
  extra?: Record<string, unknown>,
): ServiceResult {
  return {
    ok: false,
    httpCode,
    message: HAZARD_MSG[reason],
    data: { reason: HAZARD_REASON[reason], ...(extra ?? {}) },
  };
}

function toView(
  doc: Partial<IHazardReport> | Record<string, unknown>,
  includeReporter: boolean,
): Record<string, unknown> {
  return toReportView(doc, includeReporter);
}

/**
 * Validates and persists a new hazard report. Order matters:
 * EXIF on the original bytes → full decode/normalise → same-place dedup →
 * private intake insert → bounded upload → one atomic update that makes the
 * photo ready and queues the durable AI review. A failed decode can therefore
 * never merge into (or vote for) another report, and an unknown commit is
 * never answered with 201.
 *
 * @param input The reporter id, coordinates, hazard type, description and photo.
 * @returns A 201 with the queued report, a 200 merge into a nearby report, or a domain failure.
 */
export async function createReport(
  input: CreateReportInput,
): Promise<ServiceResult> {
  const now = new Date();

  const exif = await parsePhotoExif(
    input.photo.buffer,
    input.latitude,
    input.longitude,
    now,
  );
  if (!exif.timestampFresh) {
    return fail(ResponseCode.INVALID_INPUT, "EXIF_TOO_OLD");
  }
  if (exif.gpsPresent && !exif.gpsMatchesClaimed) {
    return fail(ResponseCode.INVALID_INPUT, "EXIF_GPS_MISMATCH");
  }

  let photo: Awaited<ReturnType<typeof normalizeHazardPhoto>>;
  try {
    photo = await normalizeHazardPhoto(
      input.photo.buffer,
      input.photo.mimeType,
    );
  } catch (err) {
    if (err instanceof PhotoNormalizationError) {
      return fail(
        PHOTO_ERROR_HTTP[err.code] ?? ResponseCode.INVALID_INPUT,
        err.code,
      );
    }
    throw err;
  }

  const existing = await findActiveDuplicate(
    input.latitude,
    input.longitude,
    DEDUP_RADIUS_M,
    input.hazardType,
    now,
    new Date(now.getTime() - REVIEW_STALE_SKIPPED_MS),
  );
  if (existing) {
    const mergeNow = new Date();
    const merged = await mergeActiveDuplicate(
      String(existing._id),
      input.reporterId,
      input.hazardType,
      mergeNow,
      new Date(mergeNow.getTime() - REVIEW_STALE_SKIPPED_MS),
    );
    if (merged)
      return {
        ok: true,
        httpCode: ResponseCode.OK,
        message: HAZARD_MSG.MERGED,
        // The submitted photo was not reviewed separately; only the vote counts.
        data: {
          merged: true,
          photoReviewed: false,
          report: toView(merged, false),
        },
      };
    // AI/manual/expiry/privacy may have changed since lookup. Preserve the new
    // evidence as its own durable intake; never return the obsolete snapshot.
  }

  const reportId = new Types.ObjectId().toString();
  const uploadToken = randomUUID();
  const storagePath = getHazardPhotoStoragePath(reportId, photo.mimeType);
  const expectedUntil = input.expectedUntil
    ? new Date(input.expectedUntil)
    : null;
  const expiredAt =
    expectedUntil ?? new Date(now.getTime() + EXPIRY_MS[input.hazardType]);
  const uncertain = () =>
    fail(ResponseCode.SERVICE_UNAVAILABLE, "REPORT_COMMIT_UNCERTAIN", {
      reportId,
    });

  try {
    await insertPrivateIntake({
      _id: reportId,
      reporterId: input.reporterId,
      reportedLocation: {
        type: "Point",
        coordinates: [input.longitude, input.latitude],
      },
      hazardType: input.hazardType,
      severity: input.severity,
      expectedUntil,
      description: input.description ?? undefined,
      exifValidation: exif,
      expiredAt,
      uploadToken,
      storagePath,
      deadlineAt: new Date(now.getTime() + HAZARD_AI.intakeDeadlineMs),
    });
  } catch (err) {
    // Unknown whether it persisted: do not upload; a stray intake is inert
    // and maintenance turns it into a tombstone after its deadline.
    console.error("[hazard-report] intake insert uncertain:", errorName(err));
    return uncertain();
  }

  let uploaded: { url: string; storagePath: string };
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), HAZARD_AI.uploadTimeoutMs);
  try {
    uploaded = await uploadHazardPhoto(photo.buffer, reportId, photo.mimeType, {
      signal: abort.signal,
      timeoutMs: HAZARD_AI.uploadTimeoutMs,
    });
  } catch (err) {
    console.error("[hazard-report] GCS upload failed:", errorName(err));
    // The object may still have landed: hand the known path to cleanup.
    await abandonIntake(
      reportId,
      uploadToken,
      new Date(),
      `deidentified:${randomUUID()}`,
    ).catch(() => false);
    return fail(ResponseCode.INTERNAL_ERROR, "UPLOAD_FAILED");
  } finally {
    clearTimeout(timer);
  }

  let ready = false;
  try {
    ready = await commitIntakeReady(
      reportId,
      uploadToken,
      new Date(),
      uploaded,
      buildQueuedReview(new Date(), expiredAt, {
        model: aiModel,
        policyVersion: HAZARD_AI_POLICY_VERSION,
        imageHash: photo.imageHash,
        mimeType: photo.mimeType,
      }),
    );
    if (!ready) {
      // An acknowledged-but-lost earlier write may still have made it ready.
      ready = (await readIntakeState(reportId, uploadToken)) === "ready";
    }
  } catch (err) {
    console.error("[hazard-report] queued commit uncertain:", errorName(err));
    ready = await readIntakeState(reportId, uploadToken)
      .then((state) => state === "ready")
      .catch(() => false);
  }
  if (!ready) return uncertain();

  const doc = await findReportById(reportId).catch(() => null);
  if (!doc) return uncertain();
  return {
    ok: true,
    httpCode: ResponseCode.CREATED,
    message: HAZARD_MSG.CREATED,
    data: { report: toView(doc, true) },
  };
}

function errorName(err: unknown): string {
  return err instanceof Error ? err.name : "unknown";
}

/**
 * Finds reports near a point, ordered by distance. The default is the active
 * verified set (supported or human-verified, unexpired); queued, processing,
 * needs-evidence, failed and cancelled reports are only returned for an
 * explicit `status=pending` query and carry their `aiReview` state.
 *
 * @param input Query centre, radius, optional hazardType/status filters and limit.
 * @returns A 200 with the matching public report views.
 */
export async function findNearby(
  input: NearbyReportsInput,
): Promise<ServiceResult> {
  const radius = Math.min(
    input.radius ?? DEFAULT_NEARBY_RADIUS_M,
    MAX_NEARBY_RADIUS_M,
  );
  const limit = Math.min(input.limit ?? DEFAULT_LIMIT, MAX_LIMIT);
  const now = new Date();
  const statusFilter = (
    input.status?.length ? input.status : DEFAULT_NEARBY_STATUS
  ) as HazardStatus[];

  const reports = await findNearbyReports(
    input.lat,
    input.lng,
    radius,
    statusFilter,
    input.hazardType,
    limit,
    now,
  );

  return {
    ok: true,
    httpCode: ResponseCode.OK,
    message: `找到 ${reports.length} 筆附近路況回報`,
    data: {
      reports: reports.map((report) => toView(report, false)),
      total: reports.length,
      queryCenter: { lat: input.lat, lng: input.lng },
      radiusM: radius,
    },
  };
}

/**
 * Confirmed, still-active hazards inside a circle — the machine-actionable
 * subset of the reports feed. "Confirmed" means AI/community `verified` AND at
 * least one identity-bearing confirmation from someone other than the reporter
 * AND an expiry still in the future. Count-only legacy records fail closed, so
 * an unreviewed, self-confirmed, or stale report can never make a route look
 * blocked.
 *
 * Uses `$geoWithin`/`$centerSphere` on the `reportedLocation` 2dsphere index
 * rather than `$near`, because callers filter by their own route geometry
 * afterwards and do not need the distance ordering `$near` forces.
 *
 * @param center Circle centre.
 * @param radiusM Circle radius in metres.
 * @param limit Hard cap on returned documents.
 * @returns The matching hazards as plain domain objects (never a ServiceResult).
 */
export async function findConfirmedHazardsWithin(
  center: { lat: number; lng: number },
  radiusM: number,
  limit: number,
): Promise<ConfirmedHazard[]> {
  const now = new Date();
  const docs = await findConfirmedWithin(center, radiusM, limit, now);

  return docs
    .filter((doc) => isRouteEligibleHazard(doc, now))
    .map((doc) => ({
      id: String(doc._id),
      hazardType: doc.hazardType,
      severity: doc.severity,
      ...(doc.description ? { description: doc.description } : {}),
      coordinates: doc.reportedLocation.coordinates,
    }));
}

/**
 * Fetches a single report by id (public projection).
 *
 * @param id The report ObjectId string.
 * @returns A 200 with the report, or a 400/404 domain failure.
 */
export async function findById(id: string): Promise<ServiceResult> {
  if (!Types.ObjectId.isValid(id)) {
    return fail(ResponseCode.INVALID_INPUT, "INVALID_ID");
  }
  const report = await findPublicReportById(id);
  if (!report) {
    return fail(ResponseCode.NOT_FOUND, "REPORT_NOT_FOUND");
  }
  return {
    ok: true,
    httpCode: ResponseCode.OK,
    message: MSG.OK,
    data: { report: toView(report, false) },
  };
}

/**
 * Lists the authenticated reporter's own reports (including expired), newest
 * first, with id-based cursor paging.
 *
 * @param input Reporter id plus optional status/hazardType filters, limit and cursor.
 * @returns A 200 with the reporter's report views and the next cursor.
 */
export async function findMine(input: MyReportsInput): Promise<ServiceResult> {
  const limit = Math.min(input.limit ?? DEFAULT_LIMIT, MAX_LIMIT);
  const reports = await findReportsByReporter(
    input.reporterId,
    {
      statuses: input.status,
      hazardType: input.hazardType,
      cursor: input.cursor,
    },
    limit,
  );

  const nextCursor =
    reports.length === limit ? String(reports[reports.length - 1]._id) : null;

  return {
    ok: true,
    httpCode: ResponseCode.OK,
    message: `找到 ${reports.length} 筆您的回報`,
    data: {
      reports: reports.map((report) => toView(report, true)),
      total: reports.length,
      nextCursor,
    },
  };
}

/**
 * Records a community confirm/deny vote on a report, rejecting duplicate votes
 * by the same voter and votes on expired reports.
 *
 * @param input Report id, action, and the resolved voter identity (userId or hashed IP).
 * @returns A 200 with the updated vote counts, or a 400/404/410 domain failure.
 */
export async function confirmReport(
  input: ConfirmInput,
): Promise<ServiceResult> {
  if (!Types.ObjectId.isValid(input.reportId)) {
    return fail(ResponseCode.INVALID_INPUT, "INVALID_ID");
  }
  const report = await findReportById(input.reportId);
  if (!report) {
    return fail(ResponseCode.NOT_FOUND, "REPORT_NOT_FOUND");
  }
  if (report.status === "expired" || report.contentScrubbedAt) {
    return fail(ResponseCode.GONE, "REPORT_EXPIRED");
  }
  if (input.action === "confirm" && report.reporterId === input.voterId) {
    return fail(ResponseCode.INVALID_INPUT, "SELF_CONFIRMATION");
  }
  if (
    report.confirmedBy.includes(input.voterId) ||
    report.deniedBy.includes(input.voterId)
  ) {
    return fail(ResponseCode.INVALID_INPUT, "ALREADY_VOTED");
  }

  const updated =
    input.action === "confirm"
      ? await addConfirmation(input.reportId, input.voterId)
      : await addDenial(input.reportId, input.voterId);
  if (!updated && (await findReportById(input.reportId))?.contentScrubbedAt) {
    return fail(ResponseCode.GONE, "REPORT_EXPIRED");
  }
  const counts = updated ?? report;

  return {
    ok: true,
    httpCode: ResponseCode.OK,
    message:
      input.action === "confirm" ? HAZARD_MSG.CONFIRMED : HAZARD_MSG.DENIED,
    data: {
      reportId: input.reportId,
      action: input.action,
      confirmCount: counts.confirmCount,
      denyCount: counts.denyCount,
    },
  };
}

/**
 * Lists reports awaiting manual review — legacy AI-`suspicious`, or legacy
 * AI-`skipped` and stale — oldest first, with id-based cursor paging. v2
 * reports (queued, needs_evidence, failed) never enter the routine queue; an
 * admin can still review any report by id.
 *
 * @param input Optional limit and paging cursor.
 * @returns A 200 with the queue and the next cursor.
 */
export async function findReviewQueue(
  input: ReviewQueueInput,
): Promise<ServiceResult> {
  const limit = Math.min(input.limit ?? DEFAULT_LIMIT, MAX_LIMIT);
  const staleSkippedBefore = new Date(Date.now() - REVIEW_STALE_SKIPPED_MS);
  const reports = await findReviewQueueReports(
    staleSkippedBefore,
    input.cursor,
    limit,
  );

  const nextCursor =
    reports.length === limit ? String(reports[reports.length - 1]._id) : null;

  return {
    ok: true,
    httpCode: ResponseCode.OK,
    message: `找到 ${reports.length} 筆待人工審核的回報`,
    data: {
      reports: reports.map((report) => toView(report, true)),
      total: reports.length,
      nextCursor,
    },
  };
}

/**
 * Records an admin's manual review decision, moving the report straight to
 * `verified`/`rejected` and bypassing the AI/community path.
 *
 * @param input Report id, resolved reviewer id, decision and optional note.
 * @returns A 200 with the updated report, or a 400/404 domain failure.
 */
export async function submitManualReview(
  input: ReviewDecisionInput,
): Promise<ServiceResult> {
  if (!Types.ObjectId.isValid(input.reportId)) {
    return fail(ResponseCode.INVALID_INPUT, "INVALID_ID");
  }
  const report = await findReportById(input.reportId);
  if (!report) {
    return fail(ResponseCode.NOT_FOUND, "REPORT_NOT_FOUND");
  }
  if (report.contentScrubbedAt) {
    return fail(ResponseCode.GONE, "REPORT_EXPIRED");
  }

  const updated = await setManualReview(input.reportId, {
    reviewerId: input.reviewerId,
    decision: input.decision,
    note: input.note,
    reviewedAt: new Date(),
  });
  if (!updated) {
    // Scrubbed (or deleted) between the read and the guarded write.
    return fail(ResponseCode.GONE, "REPORT_EXPIRED");
  }

  return {
    ok: true,
    httpCode: ResponseCode.OK,
    message: HAZARD_MSG.REVIEWED,
    data: { report: toView(updated, true) },
  };
}

/**
 * Number of active verified hazards inside a circle. Queued, processing,
 * needs-evidence, failed, cancelled, intake, scrubbed and expired reports never
 * count, so an unproven or duplicate re-shot report cannot sway an assessment.
 *
 * @param center Circle centre.
 * @param radiusM Circle radius in metres.
 * @returns The active verified count.
 */
export async function countActiveHazardsNear(
  center: { lat: number; lng: number },
  radiusM: number,
): Promise<number> {
  return countActiveVerifiedWithin(center, radiusM, new Date());
}

/** What another LLM may be told about a hazard; no free text, photo or identity. */
export interface AgentHazard {
  id: string;
  hazardType: HazardType;
  /** Self-reported by the reporter; not verified. */
  reporterSeverity: string;
  expiresAt: string;
  /** Rounded coordinates [lat, lng]. */
  location: [number, number];
  verification: "photo_supported" | "manual" | "legacy";
  visibleHazards: string[];
}

function roundCoord(value: number): number {
  return Math.round(value * 1e5) / 1e5;
}

/**
 * Machine-safe projection of active verified hazards for the chat agent. Only
 * controlled enums, a rounded location and the self-reported severity leave
 * this function: never description, observations, photo, raw reason, job or
 * identity fields.
 *
 * @param input Centre, radius and optional type filter.
 * @returns The projected hazards.
 */
export async function findActiveHazardsForAgent(input: {
  lat: number;
  lng: number;
  radiusM?: number;
  hazardType?: HazardType;
}): Promise<AgentHazard[]> {
  const radius = Math.min(
    input.radiusM ?? DEFAULT_NEARBY_RADIUS_M,
    MAX_NEARBY_RADIUS_M,
  );
  const rows = await findActiveVerifiedWithin(
    { lat: input.lat, lng: input.lng },
    radius,
    MAX_LIMIT,
    input.hazardType,
    new Date(),
  );
  return rows.map((row) => {
    const review = row.aiReview as
      { decision?: string; visibleHazards?: string[] } | undefined;
    const manual = row.manualReview as { decision?: string } | undefined;
    const coordinates = (
      row.reportedLocation as { coordinates: [number, number] }
    ).coordinates;
    return {
      id: String(row._id),
      hazardType: row.hazardType as HazardType,
      reporterSeverity: String(row.severity),
      expiresAt: (row.expiredAt as Date).toISOString(),
      location: [roundCoord(coordinates[1]), roundCoord(coordinates[0])],
      verification:
        manual?.decision === "verified"
          ? "manual"
          : review
            ? "photo_supported"
            : "legacy",
      visibleHazards: review?.visibleHazards ?? [],
    };
  });
}
