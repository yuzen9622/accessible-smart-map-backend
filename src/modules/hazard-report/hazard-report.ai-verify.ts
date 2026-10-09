import { prefilterImage } from "../../adapters/vision.adapter";
import { verifyImageWithGemini } from "../../adapters/ai-vision.adapter";
import { HAZARD_AI, HAZARD_AI_POLICY_VERSION } from "../../config/hazard-ai";
import {
  parseHazardObservation,
  ModelObservationError,
} from "./hazard-report.parse";
import { decideHazardEvidence } from "./hazard-report.ai-policy";
import { normalizeHazardPhoto } from "./hazard-report.photo";
import { persistLegacyAiResult } from "./hazard-report.ai-legacy.repository";
import type { HazardType, IHazardReport } from "../../types";
import type { HazardAiDecisionResult } from "../../types/hazard-ai-review";
import type { PhotoMimeType } from "./hazard-report.types";

export class AiReviewError extends Error {
  constructor(
    public readonly code: string,
    public readonly retryable = false,
    public readonly circuitBreak = false,
  ) {
    super(code);
    this.name = "AiReviewError";
  }
}

/** SDK adapters expose safe codes; never log or persist raw provider messages. */
export function classifyAiReviewError(error: unknown): AiReviewError {
  if (error instanceof AiReviewError) return error;
  if (error instanceof ModelObservationError)
    return new AiReviewError("MODEL_OUTPUT_INVALID", true);
  const safe = error as {
    code?: unknown;
    retryable?: unknown;
    circuitBreak?: unknown;
  } | null;
  if (
    safe &&
    typeof safe.code === "string" &&
    /^[A-Z][A-Z0-9_]{0,63}$/.test(safe.code) &&
    typeof safe.retryable === "boolean"
  )
    return new AiReviewError(
      safe.code,
      safe.retryable,
      safe.circuitBreak === true,
    );
  return new AiReviewError("AI_DEPENDENCY_UNAVAILABLE", true);
}

/**
 * Analyze canonical, already decoded bytes. No DB writes: the worker alone
 * commits the policy result under generation/lease/state fencing.
 */
export async function analyzeHazardPhoto(
  buffer: Buffer,
  mimeType: string,
  hazardType: HazardType,
  description?: string,
  options: {
    signal?: AbortSignal;
    model?: string;
    policyVersion?: string;
  } = {},
): Promise<HazardAiDecisionResult> {
  if (
    (options.policyVersion ?? HAZARD_AI_POLICY_VERSION) !==
    HAZARD_AI_POLICY_VERSION
  )
    throw new AiReviewError("POLICY_UNSUPPORTED");
  const jpeg =
    mimeType === "image/jpeg" &&
    buffer[0] === 0xff &&
    buffer[1] === 0xd8 &&
    buffer[2] === 0xff;
  const png =
    mimeType === "image/png" &&
    buffer
      .subarray(0, 8)
      .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  if ((!jpeg && !png) || buffer.length > HAZARD_AI.imageMaxBytes)
    throw new AiReviewError("GCS_IMAGE_INVALID");
  try {
    const prefilter = await prefilterImage(buffer, { signal: options.signal });
    if (!prefilter.passed && !prefilter.safeSearchBlocked)
      throw new AiReviewError("VISION_SAFETY_INCOMPLETE", true);
    if (prefilter.safeSearchBlocked)
      return {
        ...decideHazardEvidence(hazardType, null, prefilter),
        prefilter,
      };
    try {
      const text = await verifyImageWithGemini(
        buffer,
        mimeType,
        hazardType,
        description,
        prefilter.detectedLabels,
        { signal: options.signal, model: options.model },
      );
      const result = decideHazardEvidence(
        hazardType,
        parseHazardObservation(text),
        prefilter,
      );
      return { ...result, prefilter };
    } catch (error) {
      const classified = classifyAiReviewError(error);
      if (classified.code === "GEMINI_SAFETY_BLOCKED")
        return {
          ...decideHazardEvidence(hazardType, null, {
            passed: false,
            safeSearchBlocked: true,
          }),
          prefilter,
        };
      throw classified;
    }
  } catch (error) {
    throw classifyAiReviewError(error);
  }
}

/**
 * Retained for the frozen v1 benchmark's captured-update interface. Production
 * creation uses queued jobs, never this function. Its repository excludes v2.
 */
export async function verifyHazardReport(
  reportId: string,
  buffer: Buffer,
  mimeType: string,
  hazardType: string,
  description?: string,
): Promise<void> {
  let verification: IHazardReport["aiVerification"];
  try {
    const photo = await normalizeHazardPhoto(buffer, mimeType as PhotoMimeType);
    const result = await analyzeHazardPhoto(
      photo.buffer,
      photo.mimeType,
      hazardType as HazardType,
      description,
    );
    const verdicts = {
      supported: "verified",
      unsupported: "rejected",
      needs_evidence: "suspicious",
    } as const;
    verification = {
      verdict: verdicts[result.decision],
      confidence: result.confidence,
      reason: result.reason,
      prefilter: result.prefilter,
      attemptedAt: new Date(),
    };
  } catch {
    verification = {
      verdict: "skipped",
      confidence: 0,
      reason: "圖片審核暫時無法完成，請重新提交或稍後查詢。",
      attemptedAt: new Date(),
    };
  }
  // An uncertain write is not an analysis failure; never overwrite it on retry.
  await persistLegacyAiResult(reportId, verification);
}
