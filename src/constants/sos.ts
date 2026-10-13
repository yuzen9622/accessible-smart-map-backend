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

/** Who-is-viewing bookkeeping for public tracking-link reads. */
export const SOS_VIEWER = {
  // A returning reader refreshes lastSeenAt at most this often (bounds writes).
  refreshMs: 60_000,
  // Readers seen within this window count as "currently viewing".
  activeWindowMs: 3 * 60_000,
  // Distinct devices recorded per session; later ones are not added.
  maxEntries: 50,
} as const;

/** Resolved sessions answer status-only for this long, then the link is gone. */
export const SOS_RESOLVED_STATUS_MS = 24 * 60 * 60 * 1000;
