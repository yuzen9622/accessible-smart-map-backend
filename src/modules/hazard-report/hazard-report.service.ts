import { Types, type HydratedDocument } from "mongoose";
import HazardReport from "../../model/hazard-report.model";
import { uploadHazardPhoto } from "../../adapters/gcs.adapter";
import { parsePhotoExif } from "./hazard-report.parse";
import { verifyHazardReport } from "./hazard-report.ai-verify";
import { ResponseCode } from "../../types/code";
import { HAZARD_MSG, HAZARD_REASON, MSG } from "../../constants/messages";
import type { HazardType, IHazardReport } from "../../types";
import type {
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

const PUBLIC_SELECT = "-reporterId -photoStoragePath -confirmedBy -deniedBy";
const MINE_SELECT = "-photoStoragePath -confirmedBy -deniedBy";
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
  doc: HydratedDocument<IHazardReport>,
  includeReporter: boolean,
): Record<string, unknown> {
  const obj = doc.toObject() as unknown as Record<string, unknown>;
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
export async function createReport(input: CreateReportInput): Promise<ServiceResult> {
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

  const existing = await HazardReport.findOne({
    reportedLocation: {
      $near: {
        $geometry: { type: "Point", coordinates: [input.longitude, input.latitude] },
        $maxDistance: DEDUP_RADIUS_M,
      },
    },
    hazardType: input.hazardType,
    status: { $in: ["pending", "verified"] },
  });
  if (existing) {
    if (!existing.confirmedBy.includes(input.reporterId)) {
      existing.confirmCount += 1;
      existing.confirmedBy.push(input.reporterId);
      await existing.save();
    }
    return {
      ok: true,
      httpCode: ResponseCode.OK,
      message: HAZARD_MSG.MERGED,
      data: { merged: true, report: toView(existing, false) },
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

  const expectedUntil = input.expectedUntil ? new Date(input.expectedUntil) : null;

  const doc = await HazardReport.create({
    _id,
    reporterId: input.reporterId,
    reportedLocation: { type: "Point", coordinates: [input.longitude, input.latitude] },
    hazardType: input.hazardType,
    severity: input.severity,
    expectedUntil,
    description: input.description ?? null,
    photoUrl: uploaded.url,
    photoStoragePath: uploaded.storagePath,
    exifValidation: exif,
    aiVerification: { verdict: "skipped", confidence: 0, reason: "影像辨識進行中" },
    status: "pending",
    expiredAt: expectedUntil ?? new Date(now.getTime() + EXPIRY_MS[input.hazardType]),
  });

  void verifyHazardReport(
    doc.id,
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
export async function findNearby(input: NearbyReportsInput): Promise<ServiceResult> {
  const radius = Math.min(input.radius ?? DEFAULT_NEARBY_RADIUS_M, MAX_NEARBY_RADIUS_M);
  const limit = Math.min(input.limit ?? DEFAULT_LIMIT, MAX_LIMIT);
  const statusFilter = input.status?.length ? input.status : DEFAULT_NEARBY_STATUS;

  const reports = await HazardReport.find({
    reportedLocation: {
      $near: {
        $geometry: { type: "Point", coordinates: [input.lng, input.lat] },
        $maxDistance: radius,
      },
    },
    status: { $in: statusFilter },
    ...(input.hazardType ? { hazardType: input.hazardType } : {}),
  })
    .select(PUBLIC_SELECT)
    .limit(limit)
    .lean();

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
 * Fetches a single report by id (public projection).
 *
 * @param id The report ObjectId string.
 * @returns A 200 with the report, or a 400/404 domain failure.
 */
export async function findById(id: string): Promise<ServiceResult> {
  if (!Types.ObjectId.isValid(id)) {
    return fail(ResponseCode.INVALID_INPUT, "INVALID_ID");
  }
  const report = await HazardReport.findById(id).select(PUBLIC_SELECT).lean();
  if (!report) {
    return fail(ResponseCode.NOT_FOUND, "REPORT_NOT_FOUND");
  }
  return { ok: true, httpCode: ResponseCode.OK, message: MSG.OK, data: { report } };
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
  const query: Record<string, unknown> = { reporterId: input.reporterId };
  if (input.status?.length) query.status = { $in: input.status };
  if (input.hazardType) query.hazardType = input.hazardType;
  if (input.cursor && Types.ObjectId.isValid(input.cursor)) {
    query._id = { $lt: new Types.ObjectId(input.cursor) };
  }

  const reports = await HazardReport.find(query)
    .select(MINE_SELECT)
    .sort({ createdAt: -1 })
    .limit(limit)
    .lean();

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
export async function confirmReport(input: ConfirmInput): Promise<ServiceResult> {
  if (!Types.ObjectId.isValid(input.reportId)) {
    return fail(ResponseCode.INVALID_INPUT, "INVALID_ID");
  }
  const report = await HazardReport.findById(input.reportId);
  if (!report) {
    return fail(ResponseCode.NOT_FOUND, "REPORT_NOT_FOUND");
  }
  if (report.status === "expired") {
    return fail(ResponseCode.GONE, "REPORT_EXPIRED");
  }
  if (
    report.confirmedBy.includes(input.voterId) ||
    report.deniedBy.includes(input.voterId)
  ) {
    return fail(ResponseCode.INVALID_INPUT, "ALREADY_VOTED");
  }

  if (input.action === "confirm") {
    report.confirmCount += 1;
    report.confirmedBy.push(input.voterId);
  } else {
    report.denyCount += 1;
    report.deniedBy.push(input.voterId);
  }
  await report.save();

  return {
    ok: true,
    httpCode: ResponseCode.OK,
    message: input.action === "confirm" ? HAZARD_MSG.CONFIRMED : HAZARD_MSG.DENIED,
    data: {
      reportId: input.reportId,
      action: input.action,
      confirmCount: report.confirmCount,
      denyCount: report.denyCount,
    },
  };
}
