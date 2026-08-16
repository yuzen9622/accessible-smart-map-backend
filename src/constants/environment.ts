/**
 * Centralized constants for the pre-trip environment aggregation endpoint —
 * external URLs, Redis key prefixes/TTLs and the degradation `reason` codes.
 * Call sites must not inline these literals.
 */

export const CWA_DATASTORE_BASE_URL =
  "https://opendata.cwa.gov.tw/api/v1/rest/datastore";

export const CWA_COUNTY_RESOURCE_ID = "F-D0047-089";

export const CWA_OBSERVATION_RESOURCE_ID = "O-A0001-001";

export const CWA_WEATHER_ELEMENTS = [
  "溫度",
  "3小時降雨機率",
  "風速",
  "風向",
  "天氣現象",
] as const;

export const TWIPCAM_CAM_LIST_URL =
  "https://www.twipcam.com/api/v1/cam-list.json";

export const TWIPCAM_SNAPSHOT_BASE_URL = "https://c01.twipcam.com/cam/snapshot";

export const ENV_REASON = {
  UPSTREAM_TIMEOUT: "UPSTREAM_TIMEOUT",
  UPSTREAM_HTTP_ERROR: "UPSTREAM_HTTP_ERROR",
  UPSTREAM_BAD_PAYLOAD: "UPSTREAM_BAD_PAYLOAD",
  CIRCUIT_OPEN: "CIRCUIT_OPEN",
} as const;

export type EnvReason = (typeof ENV_REASON)[keyof typeof ENV_REASON];

const ENV_CACHE_PREFIX = "env";

export const ENV_CACHE_TTL_SEC = {
  WEATHER: 20 * 60,
  AIR: 60 * 60,
  CCTV: 10 * 60,
} as const;

export const CCTV_CACHE_KEY = `${ENV_CACHE_PREFIX}:cctv:all`;

export const DEFAULT_CCTV_LIMIT = 5;

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

/**
 * Builds the coordinate-keyed weather cache key (rounded to ~111m precision).
 *
 * @param lat Query latitude.
 * @param lng Query longitude.
 * @returns The Redis key for the parsed weather block.
 */
export function weatherCacheKey(lat: number, lng: number): string {
  return `${ENV_CACHE_PREFIX}:weather:${round3(lat)}:${round3(lng)}`;
}

/**
 * Builds the coordinate-keyed air-quality cache key (rounded to ~111m precision).
 *
 * @param lat Query latitude.
 * @param lng Query longitude.
 * @returns The Redis key for the parsed air-quality block.
 */
export function airCacheKey(lat: number, lng: number): string {
  return `${ENV_CACHE_PREFIX}:air:${round3(lat)}:${round3(lng)}`;
}

/**
 * Builds the cache key for a raw CWA datastore response, shared across all
 * coordinate queries that resolve to the same resource (county/township file).
 *
 * @param resourceId The CWA F-D0047 resource id.
 * @returns The Redis key for the raw datastore payload.
 */
export function cwaRawCacheKey(resourceId: string): string {
  return `${ENV_CACHE_PREFIX}:cwa:raw:${resourceId}`;
}
