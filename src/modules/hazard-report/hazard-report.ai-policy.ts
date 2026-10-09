import type { HazardType } from "../../types";
import type {
  HazardAiDecisionResult,
  HazardImageObservation,
  HazardRequiredEvidence,
  VisibleHazard,
} from "../../types/hazard-ai-review";

const OBSERVATION_LABELS: Record<VisibleHazard, string> = {
  vehicle: "畫面可見車輛",
  construction: "畫面可見施工設施或施工圍設",
  steps: "畫面可見階梯或台階",
  debris: "畫面可見散落物或堆置物",
  blocked_path: "畫面可見通路受阻",
  other_obstacle: "畫面可見其他占道障礙物",
};
const LIMITATIONS = [
  "照片只能呈現可見畫面，未獨立驗證拍攝地點與時間。",
  "單張照片無法證實實際寬度、坡度或其他替代路線。",
];
const REASONS = {
  SAFETY_BLOCKED: "照片未通過安全檢查，請提供合適的路況照片。",
  NON_STREET_IMAGE: "照片未呈現可供核對的街道或通路場景。",
  MAP_REFERENCE_REQUIRED: "照片無法核實圖資差異，目前尚未提供圖資對照功能。",
  IMAGE_EVIDENCE_INSUFFICIENT: "畫面不足以核對障礙，請補拍清楚的通路與周邊。",
  CLAIM_NOT_SUPPORTED: "照片中未見與此回報相符的占道或通行障礙。",
  PHOTO_SUPPORTS_CLAIM: "照片可見與回報相符的通行障礙；不代表現地已獨立核實。",
};

/** The only content policy. Confidence never upgrades a decision. */
export function decideHazardEvidence(
  hazardType: HazardType,
  observation: HazardImageObservation | null,
  safety: { passed: boolean; safeSearchBlocked: boolean },
): HazardAiDecisionResult {
  if (!safety.passed && !safety.safeSearchBlocked)
    throw new Error("SAFETY_CHECK_REQUIRED");
  const result = (
    decision: HazardAiDecisionResult["decision"],
    reasonCode: keyof typeof REASONS,
    requiredEvidence: HazardRequiredEvidence[] = [],
  ): HazardAiDecisionResult => ({
    decision,
    reasonCode,
    reason: REASONS[reasonCode],
    // Only publish controlled observations, never OCR or unconstrained claims.
    observations: observation
      ? [...new Set(observation.visibleHazards)].map(
          (h) => OBSERVATION_LABELS[h],
        )
      : [],
    visibleHazards: observation ? [...new Set(observation.visibleHazards)] : [],
    limitations: [...LIMITATIONS],
    requiredEvidence,
    confidence: observation?.confidence ?? 0,
  });
  if (safety.safeSearchBlocked) return result("unsupported", "SAFETY_BLOCKED");
  if (!observation) throw new Error("MODEL_OBSERVATION_REQUIRED");
  if (observation.scene === "non_street")
    return result("unsupported", "NON_STREET_IMAGE");
  if (hazardType === "data_error")
    return result("needs_evidence", "MAP_REFERENCE_REQUIRED", [
      "map_reference",
    ]);

  const matchingHazard =
    hazardType === "construction"
      ? observation.visibleHazards.includes("construction")
      : observation.visibleHazards.some((h) => h !== "construction");
  const clearContradiction =
    observation.scene === "street" &&
    observation.imageQuality === "usable" &&
    observation.claimMatch === "contradicted" &&
    observation.pathImpact === "clear" &&
    observation.visibleHazards.length === 0;
  if (clearContradiction) return result("unsupported", "CLAIM_NOT_SUPPORTED");

  const supports =
    observation.scene === "street" &&
    observation.imageQuality === "usable" &&
    observation.claimMatch === "supported" &&
    matchingHazard &&
    (observation.pathImpact === "blocked" ||
      observation.pathImpact === "partly_blocked") &&
    observation.requiredEvidence.length === 0;
  if (supports) return result("supported", "PHOTO_SUPPORTS_CLAIM");
  const evidence: HazardRequiredEvidence[] =
    observation.imageQuality === "insufficient"
      ? ["clearer_image", "wider_view"]
      : matchingHazard
        ? ["wider_view"]
        : ["matching_hazard", "wider_view"];
  return result("needs_evidence", "IMAGE_EVIDENCE_INSUFFICIENT", evidence);
}
