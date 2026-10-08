/**
 * Privacy data-retention tunables. Deadlines mirror the published privacy
 * policy; environment overrides may only shorten them, never extend them.
 * See docs/PRIVACY_DATA_RETENTION.md.
 */

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

/** Policy ceilings (days). Overrides above these are rejected. */
export const RETENTION_POLICY_CEILING_DAYS = {
  sosResolved: 30,
  contactLocation: 30,
  hazardReport: 90,
  memoryUnused: 365,
  memoryTombstone: 30,
  accountSweep: 30,
} as const;

export interface RetentionConfig {
  /** How often the retention job runs. */
  scanIntervalMs: number;
  /**
   * Data is processed this long before its policy deadline, so one missed or
   * slow run still lands inside the deadline.
   */
  safetyMarginMs: number;
  /** Documents handled per category per batch. */
  batchSize: number;
  /** Wall-clock budget of one run; remaining backlog continues next run. */
  runBudgetMs: number;
  /** How often the reconciliation sweeps (orphan vectors, deleted accounts) run. */
  reconcileIntervalMs: number;

  sosResolvedDeadlineDays: number;
  contactLocationDeadlineDays: number;
  hazardReportDeadlineDays: number;
  memoryUnusedDeadlineDays: number;

  /** An active SOS with no location update for this long is auto-resolved. */
  sosStaleAutoResolveHours: number;
  /** Attempts to deliver the auto-resolve notice before giving up. */
  sosNoticeMaxAttempts: number;
  /** Lease on one notice delivery attempt; also the retry delay. */
  sosNoticeLeaseMs: number;
  /** Timeout of one LINE send; must be shorter than the lease. */
  sosNoticeSendTimeoutMs: number;

  /** Content-free memory tombstones are kept this long for vector reconciliation. */
  memoryTombstoneKeepDays: number;
  /** Vectors indexed more recently than this are never treated as orphans. */
  memoryVectorGraceMs: number;
  /** Abort deadline of one vector upsert (after embedding); must be shorter than the grace. */
  memoryIndexTimeoutMs: number;

  /** A deleted-account entry is dropped after a quiet period with no residue found. */
  accountSweepQuietMs: number;
  /** Hard cap on how long a deleted-account entry lives. */
  accountSweepCapDays: number;

  /** Cache-Control max-age of hazard photos; must not exceed the safety margin. */
  hazardPhotoCacheMaxAgeSec: number;
}

const DEFAULTS: RetentionConfig = {
  scanIntervalMs: HOUR_MS,
  safetyMarginMs: DAY_MS,
  batchSize: 200,
  runBudgetMs: 5 * 60 * 1000,
  reconcileIntervalMs: 6 * HOUR_MS,
  sosResolvedDeadlineDays: RETENTION_POLICY_CEILING_DAYS.sosResolved,
  contactLocationDeadlineDays: RETENTION_POLICY_CEILING_DAYS.contactLocation,
  hazardReportDeadlineDays: RETENTION_POLICY_CEILING_DAYS.hazardReport,
  memoryUnusedDeadlineDays: RETENTION_POLICY_CEILING_DAYS.memoryUnused,
  sosStaleAutoResolveHours: 24,
  sosNoticeMaxAttempts: 10,
  sosNoticeLeaseMs: 15 * 60 * 1000,
  sosNoticeSendTimeoutMs: 10_000,
  memoryTombstoneKeepDays: RETENTION_POLICY_CEILING_DAYS.memoryTombstone,
  memoryVectorGraceMs: 10 * 60 * 1000,
  memoryIndexTimeoutMs: 30_000,
  accountSweepQuietMs: DAY_MS,
  accountSweepCapDays: RETENTION_POLICY_CEILING_DAYS.accountSweep,
  hazardPhotoCacheMaxAgeSec: 3600,
};

function readNumber(
  name: string,
  fallback: number,
  valid: (value: number) => boolean,
  expected: string,
): number {
  const raw = process.env[name];
  if (raw == null || raw.trim() === "") return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || !valid(value)) {
    throw new Error(`Invalid ${name}: expected ${expected}, got "${raw}"`);
  }
  return value;
}

const positiveInteger = (value: number) => Number.isInteger(value) && value > 0;
const daysUpTo = (ceiling: number) => (value: number) =>
  positiveInteger(value) && value <= ceiling;

function assertRule(ok: boolean, message: string): void {
  if (!ok) throw new Error(`Invalid retention config: ${message}`);
}

/**
 * Resolves and validates the retention tunables. Called once before the
 * server starts listening, so a bad deployment value aborts startup instead
 * of leaving the retention job silently off.
 *
 * @returns The effective retention configuration.
 */
export function getRetentionConfig(): RetentionConfig {
  const c = RETENTION_POLICY_CEILING_DAYS;
  const config: RetentionConfig = {
    scanIntervalMs: readNumber(
      "RETENTION_SCAN_INTERVAL_MS",
      DEFAULTS.scanIntervalMs,
      (v) => positiveInteger(v) && v <= 6 * HOUR_MS,
      "a positive integer ≤ 21600000 (6 h)",
    ),
    safetyMarginMs: readNumber(
      "RETENTION_SAFETY_MARGIN_MS",
      DEFAULTS.safetyMarginMs,
      positiveInteger,
      "a positive integer",
    ),
    batchSize: readNumber(
      "RETENTION_BATCH_SIZE",
      DEFAULTS.batchSize,
      (v) => positiveInteger(v) && v <= 5000,
      "a positive integer ≤ 5000",
    ),
    runBudgetMs: readNumber(
      "RETENTION_RUN_BUDGET_MS",
      DEFAULTS.runBudgetMs,
      positiveInteger,
      "a positive integer",
    ),
    reconcileIntervalMs: readNumber(
      "RETENTION_RECONCILE_INTERVAL_MS",
      DEFAULTS.reconcileIntervalMs,
      positiveInteger,
      "a positive integer",
    ),
    sosResolvedDeadlineDays: readNumber(
      "SOS_RESOLVED_DEADLINE_DAYS",
      DEFAULTS.sosResolvedDeadlineDays,
      daysUpTo(c.sosResolved),
      `an integer 1–${c.sosResolved}`,
    ),
    contactLocationDeadlineDays: readNumber(
      "CONTACT_LOCATION_DEADLINE_DAYS",
      DEFAULTS.contactLocationDeadlineDays,
      daysUpTo(c.contactLocation),
      `an integer 1–${c.contactLocation}`,
    ),
    hazardReportDeadlineDays: readNumber(
      "HAZARD_REPORT_DEADLINE_DAYS",
      DEFAULTS.hazardReportDeadlineDays,
      daysUpTo(c.hazardReport),
      `an integer 1–${c.hazardReport}`,
    ),
    memoryUnusedDeadlineDays: readNumber(
      "MEMORY_UNUSED_DEADLINE_DAYS",
      DEFAULTS.memoryUnusedDeadlineDays,
      daysUpTo(c.memoryUnused),
      `an integer 1–${c.memoryUnused}`,
    ),
    sosStaleAutoResolveHours: readNumber(
      "SOS_STALE_AUTO_RESOLVE_HOURS",
      DEFAULTS.sosStaleAutoResolveHours,
      (v) => positiveInteger(v) && v >= 6,
      "an integer ≥ 6",
    ),
    sosNoticeMaxAttempts: readNumber(
      "SOS_NOTICE_MAX_ATTEMPTS",
      DEFAULTS.sosNoticeMaxAttempts,
      positiveInteger,
      "a positive integer",
    ),
    sosNoticeLeaseMs: readNumber(
      "SOS_NOTICE_LEASE_MS",
      DEFAULTS.sosNoticeLeaseMs,
      positiveInteger,
      "a positive integer",
    ),
    sosNoticeSendTimeoutMs: readNumber(
      "SOS_NOTICE_SEND_TIMEOUT_MS",
      DEFAULTS.sosNoticeSendTimeoutMs,
      positiveInteger,
      "a positive integer",
    ),
    memoryTombstoneKeepDays: readNumber(
      "MEMORY_TOMBSTONE_KEEP_DAYS",
      DEFAULTS.memoryTombstoneKeepDays,
      daysUpTo(c.memoryTombstone),
      `an integer 1–${c.memoryTombstone}`,
    ),
    memoryVectorGraceMs: readNumber(
      "MEMORY_VECTOR_GRACE_MS",
      DEFAULTS.memoryVectorGraceMs,
      positiveInteger,
      "a positive integer",
    ),
    memoryIndexTimeoutMs: readNumber(
      "MEMORY_INDEX_TIMEOUT_MS",
      DEFAULTS.memoryIndexTimeoutMs,
      positiveInteger,
      "a positive integer",
    ),
    accountSweepQuietMs: readNumber(
      "ACCOUNT_SWEEP_QUIET_MS",
      DEFAULTS.accountSweepQuietMs,
      positiveInteger,
      "a positive integer",
    ),
    accountSweepCapDays: readNumber(
      "ACCOUNT_SWEEP_CAP_DAYS",
      DEFAULTS.accountSweepCapDays,
      daysUpTo(c.accountSweep),
      `an integer 1–${c.accountSweep}`,
    ),
    hazardPhotoCacheMaxAgeSec: readNumber(
      "HAZARD_PHOTO_CACHE_MAX_AGE_SEC",
      DEFAULTS.hazardPhotoCacheMaxAgeSec,
      positiveInteger,
      "a positive integer",
    ),
  };

  const smallestDeadlineMs =
    Math.min(
      config.sosResolvedDeadlineDays,
      config.contactLocationDeadlineDays,
      config.hazardReportDeadlineDays,
      config.memoryUnusedDeadlineDays,
    ) * DAY_MS;

  assertRule(
    config.safetyMarginMs >= 2 * config.scanIntervalMs,
    "RETENTION_SAFETY_MARGIN_MS must be ≥ 2 × RETENTION_SCAN_INTERVAL_MS",
  );
  assertRule(
    config.safetyMarginMs < smallestDeadlineMs,
    "RETENTION_SAFETY_MARGIN_MS must be shorter than the smallest deadline",
  );
  assertRule(
    config.reconcileIntervalMs <= config.safetyMarginMs / 2,
    "RETENTION_RECONCILE_INTERVAL_MS must be ≤ RETENTION_SAFETY_MARGIN_MS / 2",
  );
  assertRule(
    config.reconcileIntervalMs + config.memoryVectorGraceMs <=
      config.safetyMarginMs,
    "RETENTION_RECONCILE_INTERVAL_MS + MEMORY_VECTOR_GRACE_MS must be ≤ RETENTION_SAFETY_MARGIN_MS",
  );
  assertRule(
    config.sosNoticeSendTimeoutMs < config.sosNoticeLeaseMs,
    "SOS_NOTICE_SEND_TIMEOUT_MS must be shorter than SOS_NOTICE_LEASE_MS",
  );
  assertRule(
    config.memoryIndexTimeoutMs < config.memoryVectorGraceMs,
    "MEMORY_INDEX_TIMEOUT_MS must be shorter than MEMORY_VECTOR_GRACE_MS",
  );
  assertRule(
    config.hazardPhotoCacheMaxAgeSec * 1000 <= config.safetyMarginMs,
    "HAZARD_PHOTO_CACHE_MAX_AGE_SEC must not exceed RETENTION_SAFETY_MARGIN_MS",
  );
  assertRule(
    config.accountSweepQuietMs < config.accountSweepCapDays * DAY_MS,
    "ACCOUNT_SWEEP_QUIET_MS must be shorter than ACCOUNT_SWEEP_CAP_DAYS",
  );

  return config;
}

/**
 * The instant before which data is due for processing: the policy deadline
 * pulled forward by the safety margin.
 *
 * @param now Current time
 * @param deadlineMs Policy deadline length
 * @param config Effective retention config
 * @returns Records whose clock started at or before this are due
 */
export function retentionCutoff(
  now: Date,
  deadlineMs: number,
  config: Pick<RetentionConfig, "safetyMarginMs">,
): Date {
  return new Date(now.getTime() - deadlineMs + config.safetyMarginMs);
}

export const RETENTION_DAY_MS = DAY_MS;
