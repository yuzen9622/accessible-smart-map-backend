/** Private, bounded latest-result outbox, embedded in its report. */
export type HazardReviewNoticeResult =
  | "ai_supported"
  | "ai_needs_evidence"
  | "ai_unsupported"
  | "ai_failed"
  | "manual_verified"
  | "manual_rejected"
  | "legacy_verified"
  | "legacy_suspicious"
  | "legacy_rejected";

export interface HazardReviewNotification {
  revision: number;
  result: HazardReviewNoticeResult;
  state: "pending" | "processing" | "sent" | "skipped" | "expired";
  createdAt: Date;
  deadlineAt: Date;
  nextAttemptAt: Date;
  attempts: number;
  leaseToken?: string;
  leaseExpiresAt?: Date;
  /** SHA-256 device-token digests, never the tokens themselves. */
  delivered: string[];
}
