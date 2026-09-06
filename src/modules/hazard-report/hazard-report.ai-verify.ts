import HazardReport from "../../model/hazard-report.model";
import { prefilterImage } from "../../adapters/vision.adapter";
import { verifyImageWithGemini } from "../../adapters/ai-vision.adapter";
import { parseAiVerifyResult } from "./hazard-report.parse";
import type { AiVerdict, HazardStatus } from "../../types";
import type { AiVerifyResult } from "./hazard-report.types";

function statusForVerdict(verdict: AiVerdict): HazardStatus | null {
  if (verdict === "verified") return "verified";
  if (verdict === "rejected") return "rejected";
  return null;
}

/**
 * Runs the two-stage image check for a report and persists the outcome:
 * stage one is Cloud Vision SafeSearch/label prefilter, stage two is Gemini's
 * single-image semantic verdict. Every external failure degrades softly
 * (prefilter skipped or verdict `skipped`) and never throws to the caller. The
 * status only advances out of `pending` when the report is still `pending`.
 *
 * @param reportId The report document id.
 * @param buffer The original photo bytes (passed in to avoid a GCS re-download).
 * @param mimeType The photo MIME type.
 * @param hazardType The claimed hazard type.
 * @param description Optional reporter description used as an LLM hint.
 */
export async function verifyHazardReport(
  reportId: string,
  buffer: Buffer,
  mimeType: string,
  hazardType: string,
  description?: string,
): Promise<void> {
  let prefilter:
    | { passed: boolean; detectedLabels?: string[]; safeSearchBlocked: boolean }
    | undefined;
  let detectedLabels: string[] | undefined;

  try {
    const r = await prefilterImage(buffer);
    detectedLabels = r.detectedLabels;
    prefilter = {
      passed: !r.safeSearchBlocked,
      detectedLabels: r.detectedLabels,
      safeSearchBlocked: r.safeSearchBlocked,
    };
    if (r.safeSearchBlocked) {
      await HazardReport.updateOne({ _id: reportId }, [
        {
          $set: {
            aiVerification: {
              verdict: "rejected",
              confidence: 1,
              reason: "影像未通過安全檢測",
              prefilter,
              attemptedAt: new Date(),
            },
            status: {
              $cond: [{ $eq: ["$status", "pending"] }, "rejected", "$status"],
            },
          },
        },
      ]);
      return;
    }
  } catch {
    prefilter = undefined;
  }

  let result: AiVerifyResult;
  try {
    const text = await verifyImageWithGemini(
      buffer,
      mimeType,
      hazardType,
      description,
      detectedLabels,
    );
    result = parseAiVerifyResult(text);
  } catch {
    result = { verdict: "skipped", confidence: 0, reason: "AI 服務暫時不可用" };
  }

  const nextStatus = statusForVerdict(result.verdict);
  await HazardReport.updateOne({ _id: reportId }, [
    {
      $set: {
        aiVerification: {
          verdict: result.verdict,
          confidence: result.confidence,
          reason: result.reason,
          prefilter,
          attemptedAt: new Date(),
        },
        ...(nextStatus
          ? {
              status: {
                $cond: [{ $eq: ["$status", "pending"] }, nextStatus, "$status"],
              },
            }
          : {}),
      },
    },
  ]);
}
