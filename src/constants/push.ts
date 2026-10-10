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
