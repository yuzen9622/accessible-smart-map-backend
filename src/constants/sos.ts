export const SOS_NOTICE = {
  pollMs: 5_000,
  leaseMs: 30_000,
  timeoutMs: 10_000,
  retryMs: 30_000,
  maxAttempts: 10,
  // Stop before LINE's 24-hour retry-key retention expires.
  retryWindowMs: 23 * 60 * 60 * 1000,
  batchSize: 25,
} as const;
