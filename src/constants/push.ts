/**
 * Constants for Expo push delivery. Call sites must not inline these literals.
 */

export const EXPO_PUSH_SEND_URL = "https://exp.host/--/api/v2/push/send";

export const EXPO_PUSH_CHUNK_SIZE = 100;

export const EXPO_PUSH_TIMEOUT_MS = 10_000;

export const EXPO_DEVICE_NOT_REGISTERED = "DeviceNotRegistered";

export const PUSH_DEFAULT_LOCALE = "zh-TW";

export const PUSH_EVENT_TYPE = {
  SOS_UPDATE: "sos_update",
  HAZARD_REVIEW: "hazard_review",
} as const;

export const EXPO_PUSH_RECEIPTS_URL =
  "https://exp.host/--/api/v2/push/getReceipts";

/** Expo accepts at most 1000 ticket ids per getReceipts request. */
export const EXPO_RECEIPT_CHUNK_SIZE = 1_000;

export const EXPO_RECEIPT_ERROR_CODES = [
  "DeviceNotRegistered",
  "MessageTooBig",
  "MessageRateExceeded",
  "MismatchSenderId",
  "InvalidCredentials",
] as const;

/** Receipt failures that mean our own Expo/FCM/APNs credentials need operator attention. */
export const EXPO_CREDENTIAL_ERROR_CODES: readonly string[] = [
  "MismatchSenderId",
  "InvalidCredentials",
];

export const PUSH_RECEIPT = {
  /** Expo asks for the first receipt lookup roughly 15 minutes after sending. */
  firstDelayMs: 15 * 60_000,
  backoffBaseMs: 5 * 60_000,
  backoffMaxMs: 60 * 60_000,
  maxAttempts: 8,
  /** Tracking stops before Expo drops receipts (24h) and is physically purged by TTL. */
  deadlineMs: 23 * 3_600_000,
  retentionMs: 24 * 3_600_000,
  /** A placeholder without ticket after this long is interrupted: converge to unknown. */
  awaitingTicketGraceMs: 5 * 60_000,
  leaseMs: 10 * 60_000,
  pollMs: 60_000,
  claimBatchSize: 20,
  maxPassesPerTick: 5,
  rowConcurrency: 4,
  dbTimeoutMs: 5_000,
} as const;
