/** v2 photo evidence; a supported image is not independent proof of place/time. */
export type HazardAiState =
  "queued" | "processing" | "completed" | "failed" | "cancelled";
export type HazardAiDecision = "supported" | "needs_evidence" | "unsupported";
export type HazardRequiredEvidence =
  "wider_view" | "clearer_image" | "matching_hazard" | "map_reference";
export type VisibleHazard =
  | "vehicle"
  | "construction"
  | "steps"
  | "debris"
  | "blocked_path"
  | "other_obstacle";

export interface HazardImageObservation {
  scene: "street" | "non_street" | "unclear";
  imageQuality: "usable" | "insufficient";
  pathImpact: "blocked" | "partly_blocked" | "clear" | "unclear";
  visibleHazards: VisibleHazard[];
  claimMatch: "supported" | "contradicted" | "insufficient";
  observations: string[];
  limitations: string[];
  requiredEvidence: HazardRequiredEvidence[];
  confidence: number;
}

export interface HazardAiDecisionResult {
  decision: HazardAiDecision;
  reasonCode: string;
  reason: string;
  observations: string[];
  limitations: string[];
  requiredEvidence: HazardRequiredEvidence[];
  visibleHazards: VisibleHazard[];
  confidence: number;
  prefilter?: {
    passed: boolean;
    detectedLabels?: string[];
    safeSearchBlocked: boolean;
  };
}

export interface HazardAiReview {
  version: 2;
  state: HazardAiState;
  decision?: HazardAiDecision;
  reasonCode: string;
  reason: string;
  observations?: string[];
  limitations?: string[];
  requiredEvidence?: HazardRequiredEvidence[];
  visibleHazards?: VisibleHazard[];
  queuedAt?: Date;
  startedAt?: Date;
  completedAt?: Date;
}

/** Never expose in transport views or store a description/owner/byte copy. */
export interface HazardAiReviewJob {
  generation: number;
  attempts: number;
  nextAttemptAt: Date;
  deadlineAt: Date;
  leaseToken?: string;
  leaseExpiresAt?: Date;
  model: string;
  policyVersion: string;
  imageHash: string;
  mimeType: "image/jpeg" | "image/png";
  errorCode?: string;
  invalidOutputAttempts?: number;
}

/** Known-path cleanup also tracks ambiguous/late storage commits. */
export interface HazardPhotoIntake {
  state: "uploading" | "ready" | "cleanup";
  uploadToken: string;
  deadlineAt: Date;
  storagePath: string;
  nextCleanupAt?: Date;
  cleanupAttempts?: number;
  cleanupUntil?: Date;
}
