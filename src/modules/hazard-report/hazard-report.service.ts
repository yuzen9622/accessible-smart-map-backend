import { Types } from "mongoose";
import {
  addConfirmation,
  addDenial,
  findActiveDuplicate,
  findConfirmedWithin,
  findNearbyReports,
  findPublicReportById,
  findReportById,
  findReportsByReporter,
  insertReport,
  type HazardGeoProjection,
  type HazardReportRecord,
} from "./hazard-report.repository";
import { uploadHazardPhoto } from "../../adapters/gcs.adapter";
import { parsePhotoExif } from "./hazard-report.parse";
import { verifyHazardReport } from "./hazard-report.ai-verify";
import { ResponseCode } from "../../types/code";
import { HAZARD_MSG, HAZARD_REASON, MSG } from "../../constants/messages";
import type { HazardStatus, HazardType, IHazardReport } from "../../types";
import type {
  ConfirmedHazard,
  ConfirmInput,
  CreateReportInput,
  MyReportsInput,
  NearbyReportsInput,
  ServiceResult,
} from "./hazard-report.types";

const DEDUP_RADIUS_M = 50;
const DEFAULT_NEARBY_RADIUS_M = 500;
const MAX_NEARBY_RADIUS_M = 5000;
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;

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
    report.expiredAt instanceof Date &&
    report.expiredAt.getTime() > now.getTime() &&
    hasIndependentConfirmation(report)
  );
}

const DEFAULT_NEARBY_STATUS = ["pending", "verified"];

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
  doc: HazardReportRecord,
  includeReporter: boolean,
): Record<string, unknown> {
  const obj = { ...doc } as unknown as Record<string, unknown>;
  delete obj.photoStoragePath;
  delete obj.confirmedBy;
  delete obj.deniedBy;
  delete obj.__v;
  if (!includeReporter) delete obj.reporterId;
  return obj;
}

/**
 * Validates and persists a new hazard report: EXIF freshness and GPS match,
 * same-location dedup merge, GCS photo upload, then document creation with a
 * `skipped` AI placeholder. The AI image check is fired asynchronously and does
 * not block the returned result. The report location is the reporter's own
 * coordinates (no separate reported point, no auth required).
 *
 * @param input The reporter id, coordinates, hazard type, description and photo.
 * @returns A 201 with the created report, a 200 merge into a nearby report, or a domain failure.
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

  const existing = await findActiveDuplicate(
    input.latitude,
    input.longitude,
    DEDUP_RADIUS_M,
    input.hazardType,
    now,
  );
  if (existing) {
    let merged = existing;
    if (
      input.reporterId !== existing.reporterId &&
      !existing.confirmedBy.includes(input.reporterId)
    ) {
      merged =
        (await addConfirmation(String(existing._id), input.reporterId)) ??
        existing;
    }
    return {
      ok: true,
      httpCode: ResponseCode.OK,
      message: HAZARD_MSG.MERGED,
      data: { merged: true, report: toView(merged, false) },
    };
  }

  const _id = new Types.ObjectId();
  let uploaded: { url: string; storagePath: string };
  try {
    uploaded = await uploadHazardPhoto(
      input.photo.buffer,
      _id.toString(),
      input.photo.mimeType,
    );
  } catch (err) {
    console.error("[hazard-report] GCS upload failed:", err);
    return fail(ResponseCode.INTERNAL_ERROR, "UPLOAD_FAILED");
  }

  const expectedUntil = input.expectedUntil
    ? new Date(input.expectedUntil)
    : null;

  const doc = await insertReport({
    _id: _id.toString(),
    reporterId: input.reporterId,
    reportedLocation: {
      type: "Point",
      coordinates: [input.longitude, input.latitude],
    },
    hazardType: input.hazardType,
    severity: input.severity,
    expectedUntil,
    description: input.description ?? undefined,
    photoUrl: uploaded.url,
    photoStoragePath: uploaded.storagePath,
    exifValidation: exif,
    aiVerification: {
      verdict: "skipped",
      confidence: 0,
      reason: "影像辨識進行中",
    },
    status: "pending",
    expiredAt:
      expectedUntil ?? new Date(now.getTime() + EXPIRY_MS[input.hazardType]),
  });

  void verifyHazardReport(
    _id.toString(),
    input.photo.buffer,
    input.photo.mimeType,
    input.hazardType,
    input.description,
  ).catch((err) => console.error("[hazard-report] AI verify failed:", err));

  return {
    ok: true,
    httpCode: ResponseCode.CREATED,
    message: HAZARD_MSG.CREATED,
    data: { report: toView(doc, true) },
  };
}

/**
 * Finds non-expired reports near a point, ordered by distance.
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
  );

  return {
    ok: true,
    httpCode: ResponseCode.OK,
    message: `找到 ${reports.length} 筆附近路況回報`,
    data: {
      reports,
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
    data: { report },
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
    data: { reports, total: reports.length, nextCursor },
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
  if (report.status === "expired") {
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
