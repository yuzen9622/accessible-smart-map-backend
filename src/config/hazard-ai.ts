/** Bounded defaults. Policy version is pinned on enqueue, not read per attempt. */
export const HAZARD_AI_POLICY_VERSION = "hazard-photo-v2";
const uploadMaxMb = Number(process.env.HAZARD_PHOTO_MAX_SIZE_MB ?? 10);
if (!Number.isFinite(uploadMaxMb) || uploadMaxMb <= 0)
  throw new Error("HAZARD_PHOTO_MAX_SIZE_MB must be positive and finite");
export const HAZARD_AI = {
  pollMs: 1_000,
  maintenanceMs: 30_000,
  monitorMs: 30_000,
  // Deadline convergence must not wait behind slow photo cleanup.
  convergenceMs: 5_000,
  concurrency: 2,
  maxAttempts: 3,
  attemptTimeoutMs: 40_000,
  leaseMs: 90_000,
  deadlineMs: 5 * 60_000,
  intakeDeadlineMs: 5 * 60_000,
  intakeCleanupGraceMs: 24 * 60 * 60_000,
  uploadTimeoutMs: 40_000,
  retryMs: [15_000, 30_000] as readonly number[],
  maxJitterMs: 1_000,
  dbTimeoutMs: 5_000,
  providerTimeoutMs: 10_000,
  uploadMaxBytes: uploadMaxMb * 1024 * 1024,
  imageMaxBytes: 10 * 1024 * 1024,
  imageMaxPixels: 20_000_000,
  imageMaxDimension: 1_600,
  decodeTimeoutMs: 10_000,
  decodeConcurrency: 2,
  decodeQueueLimit: 8,
  modelOutputMaxBytes: 8 * 1024,
} as const;

export const HAZARD_AI_ALERT_CODES = [
  "MONGO_UNAVAILABLE",
  "WORKER_UNAVAILABLE",
  "AI_PAUSED",
  "CIRCUIT_OPEN",
  "QUEUE_AGING",
  "EXPIRED_LEASE",
  "INTAKE_CLEANUP_OVERDUE",
  "INTAKE_PRIVACY_STALE",
  "CONVERGENCE_STALE",
] as const;
