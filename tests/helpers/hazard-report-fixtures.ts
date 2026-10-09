import type { IHazardReport } from "../../src/types";
import { Types } from "mongoose";
import HazardReport from "../../src/model/hazard-report.model";
import { buildQueuedReview } from "../../src/modules/hazard-report/hazard-report.ai-job.repository";
import type { HazardAiDecisionResult } from "../../src/types/hazard-ai-review";

/** Shared real-Mongo fixtures for the hazard-report integration tests. */

export const HASH = "a".repeat(64);

export function newId(): string {
  return new Types.ObjectId().toString();
}

/** Inserts a report straight through the model; defaults to legacy verified. */
export async function seedReport(
  over: Record<string, unknown> = {},
): Promise<string> {
  const _id = (over._id as string | undefined) ?? newId();
  await HazardReport.create({
    _id,
    reporterId: "reporter-1",
    reportedLocation: { type: "Point", coordinates: [121.565, 25.033] },
    hazardType: "obstacle",
    severity: "blocking",
    expectedUntil: null,
    description: "free text from the reporter",
    photoUrl: `https://example.test/${_id}.jpg`,
    photoStoragePath: `reports/${_id}.jpg`,
    exifValidation: {
      timestampFresh: true,
      gpsPresent: true,
      gpsMatchesClaimed: true,
      rawExifLat: 25.033,
      rawExifLng: 121.565,
    },
    aiVerification: { verdict: "verified", confidence: 0.9, reason: "legacy" },
    status: "verified",
    expiredAt: new Date(Date.now() + 3_600_000),
    ...over,
  });
  return _id;
}

/** A pending v2 report that is queued and due now. */
export async function seedQueued(
  over: Record<string, unknown> = {},
  jobOver: Record<string, unknown> = {},
): Promise<string> {
  const now = new Date();
  const queued = buildQueuedReview(now, new Date(now.getTime() + 3_600_000), {
    model: "test-model",
    policyVersion: "hazard-photo-v2",
    imageHash: HASH,
    mimeType: "image/jpeg",
  });
  return seedReport({
    status: "pending",
    aiVerification: queued.aiVerification,
    aiReview: queued.aiReview,
    aiReviewJob: { ...queued.aiReviewJob, ...jobOver },
    photoIntake: {
      state: "ready",
      uploadToken: "tok",
      deadlineAt: new Date(now.getTime() + 60_000),
      storagePath: "reports/x.jpg",
    },
    ...over,
  });
}

/** The stored report including select:false internals, as a plain object. */
export async function readDoc(id: string): Promise<IHazardReport | null> {
  return HazardReport.findById(id)
    .select("+aiReviewJob +photoIntake")
    .lean<IHazardReport | null>();
}

export function decision(
  over: Partial<HazardAiDecisionResult> = {},
): HazardAiDecisionResult {
  return {
    decision: "supported",
    reasonCode: "PHOTO_SUPPORTS_CLAIM",
    reason: "照片可見與回報相符的通行障礙",
    observations: ["畫面可見車輛"],
    limitations: ["單張照片無法證實實際寬度"],
    requiredEvidence: [],
    visibleHazards: ["vehicle"],
    confidence: 0.9,
    ...over,
  };
}
