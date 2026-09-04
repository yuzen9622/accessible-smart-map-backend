/**
 * Configuration for the TDX Road/Traffic integration (live congestion, section
 * geometry and live road events).
 *
 * Every path and value domain below was pinned by `pnpm smoke:tdx-traffic`
 * against the live TDX service, because the TDX Swagger does not describe the
 * Road/Traffic family precisely enough to derive them:
 *
 * - live congestion lives under `v2/Road/Traffic/Live/City/{City}` (envelope key
 *   `LiveTraffics`); the `Live/Section/City` spelling answers 404.
 * - road events live under a DIFFERENT service root,
 *   `v1/Traffic/RoadEvent/LiveEvent/City/{City}` (envelope key `LiveEvents`),
 *   not under `v2/Road/Traffic`.
 * - `CongestionLevel` arrives as a STRING; the observed Taipei domain is
 *   `1..6` (TDX level names A..F, 1 = free flowing, 6 = severe) plus `-99` for
 *   "no data", which also appears as the `TravelTime` / `TravelSpeed` sentinel.
 *   `-1` (road closed) is documented but was not observed, so it is styled but
 *   never assumed. Any other code degrades to the unknown/grey style.
 */

import type { CongestionLevel } from "../types/traffic";

const DEFAULT_ROAD_TRAFFIC_BASE_URL =
  "https://tdx.transportdata.tw/api/basic/v2/Road/Traffic";
const DEFAULT_ROAD_EVENT_BASE_URL =
  "https://tdx.transportdata.tw/api/basic/v1/Traffic/RoadEvent";

function envText(name: string, fallback: string): string {
  const raw = process.env[name];
  return raw == null || raw.trim() === "" ? fallback : raw.trim();
}

/**
 * @param name Environment variable name.
 * @param fallback Value used when unset or blank.
 * @returns A positive number, falling back when the value is unset or unusable.
 */
function envPositive(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw == null || raw.trim() === "") return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export const TDX_ROAD_TRAFFIC_BASE_URL = envText(
  "TDX_ROAD_TRAFFIC_BASE_URL",
  DEFAULT_ROAD_TRAFFIC_BASE_URL,
);

export const TDX_ROAD_EVENT_BASE_URL = envText(
  "TDX_ROAD_EVENT_BASE_URL",
  DEFAULT_ROAD_EVENT_BASE_URL,
);

export const trafficUrl = {
  liveTrafficUrl: (city: string) =>
    `${TDX_ROAD_TRAFFIC_BASE_URL}/Live/City/${city}`,
  sectionUrl: (city: string) =>
    `${TDX_ROAD_TRAFFIC_BASE_URL}/Section/City/${city}`,
  sectionShapeUrl: (city: string) =>
    `${TDX_ROAD_TRAFFIC_BASE_URL}/SectionShape/City/${city}`,
  congestionLevelUrl: (city: string) =>
    `${TDX_ROAD_TRAFFIC_BASE_URL}/CongestionLevel/City/${city}`,
  liveEventUrl: (city: string) =>
    `${TDX_ROAD_EVENT_BASE_URL}/LiveEvent/City/${city}`,

  // 國道 Freeway
  freewaySectionUrl: () => `${TDX_ROAD_TRAFFIC_BASE_URL}/Section/Freeway`,
  freewaySectionShapeUrl: () =>
    `${TDX_ROAD_TRAFFIC_BASE_URL}/SectionShape/Freeway`,
  freewayLiveTrafficUrl: () => `${TDX_ROAD_TRAFFIC_BASE_URL}/Live/Freeway`,

  // 省道 Highway
  highwaySectionUrl: () => `${TDX_ROAD_TRAFFIC_BASE_URL}/Section/Highway`,
  highwaySectionShapeUrl: () =>
    `${TDX_ROAD_TRAFFIC_BASE_URL}/SectionShape/Highway`,
  highwayLiveTrafficUrl: () => `${TDX_ROAD_TRAFFIC_BASE_URL}/Live/Highway`,
} as const;

/**
 * Verified cities and counties supported by TDX Road/Traffic (Section & CongestionLevel).
 * Confirmed by live TDX API: only these 12 administrative divisions are accepted.
 * Calling any other city returns HTTP 400 ("City: '{City}' is not accepted").
 */
export const TDX_SUPPORTED_CITIES = [
  "Taipei",
  "NewTaipei",
  "Taoyuan",
  "Taichung",
  "Tainan",
  "Kaohsiung",
  "Keelung",
  "HsinchuCounty",
  "ChanghuaCounty",
  "YunlinCounty",
  "PingtungCounty",
  "YilanCounty",
] as const;

export type TdxSupportedCity = (typeof TDX_SUPPORTED_CITIES)[number];

/**
 * Cities the traffic feature covers. Setting the variable to an empty value is
 * a supported kill switch: no city means no TDX call and no traffic overlay.
 */
export const TRAFFIC_TARGET_CITIES: readonly string[] = envText(
  "TRAFFIC_TARGET_CITIES",
  "Taipei,NewTaipei",
)
  .split(",")
  .map((city) => city.trim())
  .filter(Boolean);

/** Redis cache-aside lifetimes, in seconds. */
export const TRAFFIC_TTL = {
  liveSoftSec: envPositive("TRAFFIC_FLOW_LIVE_SOFT_TTL_SEC", 90),
  liveHardSec: envPositive("TRAFFIC_FLOW_LIVE_HARD_TTL_SEC", 300),
  liveErrSec: envPositive("TRAFFIC_FLOW_LIVE_ERR_TTL_SEC", 15),
  congestionDefSec: envPositive("TRAFFIC_CONGESTION_DEF_TTL_SEC", 86_400),
  incidentSec: envPositive("TRAFFIC_INCIDENT_TTL_SEC", 60),
  incidentErrSec: envPositive("TRAFFIC_INCIDENT_ERR_TTL_SEC", 15),
} as const;

/** Background live-traffic refresher cadence and the cross-instance lock. */
export const TRAFFIC_REFRESH = {
  liveIntervalMs: envPositive("TRAFFIC_LIVE_REFRESH_INTERVAL_MS", 60_000),
  /** Must stay below liveIntervalMs so the lock always self-expires between ticks. */
  lockTtlSec: envPositive("TRAFFIC_REFRESH_LOCK_TTL_SEC", 50),
  lockKey: "traffic:refresh:lock",
  geometryIntervalMs: envPositive(
    "TRAFFIC_GEOMETRY_REFRESH_INTERVAL_MS",
    21_600_000,
  ),
} as const;

/** `CongestionLevel` value returned when TDX has no usable measurement. */
export const TDX_CONGESTION_UNKNOWN = -99;
/** `CongestionLevel` value documented for a closed road. */
export const TDX_CONGESTION_ROAD_CLOSED = -1;
/** `TravelTime` / `TravelSpeed` sentinel meaning "not measured". */
export const TDX_MEASUREMENT_UNKNOWN = -99;

export interface CongestionStyle {
  label: string;
  color: string;
}

export function congestionToSemanticLevel(
  congestionLevel: number,
): "light" | "moderate" | "heavy" | "severe" | "closed" | "unknown" {
  switch (congestionLevel) {
    case 1:
      return "light";
    case 2:
    case 3:
      return "moderate";
    case 4:
    case 5:
      return "heavy";
    case 6:
      return "severe";
    case -1:
      return "closed";
    default:
      return "unknown";
  }
}

export function congestionToLabel(congestionLevel: number): string {
  switch (congestionLevel) {
    case 1:
      return "順暢";
    case 2:
      return "稍慢";
    case 3:
      return "車多";
    case 4:
      return "車多壅塞";
    case 5:
      return "壅塞";
    case 6:
      return "嚴重壅塞";
    case -1:
      return "道路封閉";
    default:
      return "無資料";
  }
}

/** Style used for any congestion code outside the evidenced domain. */
export const UNKNOWN_CONGESTION_STYLE: CongestionStyle = {
  label: "無資料",
  color: "#9CA3AF",
};

export const CONGESTION_STYLE: Readonly<
  Record<CongestionLevel, CongestionStyle>
> = {
  [TDX_CONGESTION_UNKNOWN]: UNKNOWN_CONGESTION_STYLE,
  [TDX_CONGESTION_ROAD_CLOSED]: { label: "道路封閉", color: "#4B5563" },
  1: { label: "順暢", color: "#22C55E" },
  2: { label: "稍慢", color: "#84CC16" },
  3: { label: "車多", color: "#F59E0B" },
  4: { label: "車多壅塞", color: "#F97316" },
  5: { label: "壅塞", color: "#EF4444" },
  6: { label: "嚴重壅塞", color: "#991B1B" },
} as const;

/** Wall-clock ceiling for one TDX Road/Traffic HTTP call. */
export const TRAFFIC_FETCH_TIMEOUT_MS = envPositive(
  "TRAFFIC_FETCH_TIMEOUT_MS",
  8_000,
);

/** Hard ceiling for the whole traffic hook inside a routing request. */
export const TRAFFIC_ROUTE_HOOK_TIMEOUT_MS = envPositive(
  "TRAFFIC_ROUTE_HOOK_TIMEOUT_MS",
  2_500,
);

/** Thresholds for matching a TDX section geometry onto a route leg polyline. */
export const TRAFFIC_MATCH = {
  /** Max distance from a section vertex to the leg for that vertex to count. */
  toleranceM: 30,
  /** Padding in meters for expanding route segment bboxes when querying spatial index. */
  corridorPadM: envPositive("TRAFFIC_CORRIDOR_PAD_M", 30),
  /** Max bearing angle difference in degrees for matching directed sections. */
  bearingToleranceDeg: envPositive("TRAFFIC_BEARING_TOLERANCE_DEG", 45),
  /** Defense-in-depth cap on candidate segments per route segment. */
  maxCandidatesPerSegment: envPositive(
    "TRAFFIC_MAX_CANDIDATES_PER_SEGMENT",
    32,
  ),
  /** Below this matched share of the leg, traffic fields stay unset. */
  minCoverageRatio: 0.25,
  /** Speed floor so a stalled section cannot produce an unbounded duration. */
  minSpeedMps: 1.5,
} as const;

/** Traffic-to-free-flow duration ratios separating the reported levels. */
export const TRAFFIC_RATIO = {
  moderate: 1.15,
  heavy: 1.5,
} as const;

/** Max distance from an incident point to a leg for it to be reported on it. */
export const INCIDENT_MATCH_TOLERANCE_M = 60;

/** Max bbox span accepted by the traffic layer endpoints, in degrees. */
export const TRAFFIC_FLOW_MAX_BBOX_DEG = envPositive(
  "TRAFFIC_FLOW_MAX_BBOX_DEG",
  0.5,
);

/**
 * Only events whose title or description matches one of these produce a
 * Valhalla `exclude_locations` entry. Classification is deliberately narrow:
 * `exclude_locations` is a HARD exclusion, so anything unrecognised stays an
 * advisory rather than risking the removal of the only viable road.
 */
export const TRAFFIC_INCIDENT_HARD_EXCLUDE_KEYWORDS: readonly string[] = [
  "封閉",
  "封路",
  "禁止通行",
  "不通",
  "中斷",
  "管制通行",
];

/** Path where the Valhalla traffic.tar extract is written and mounted. */
export const VALHALLA_TRAFFIC_EXTRACT_PATH = envText(
  "VALHALLA_TRAFFIC_EXTRACT_PATH",
  "./valhalla-data/traffic/traffic.tar",
);

/** Path to the offline-generated TDX Section -> Valhalla GraphId mapping cache. */
export const VALHALLA_EDGE_MAP_PATH = envText(
  "VALHALLA_EDGE_MAP_PATH",
  "./valhalla-data/traffic/tdx-valhalla-edge-map.json",
);

/** Path to directory containing active Valhalla tiles (.gph files). */
export const VALHALLA_TILES_DIR = envText(
  "VALHALLA_TILES_DIR",
  "./valhalla-data/active/valhalla_tiles",
);

/** Distributed lock settings for Valhalla traffic.tar background generator. */
export const TRAFFIC_TAR_LOCK_KEY = "traffic:tar:lock";
export const TRAFFIC_TAR_LOCK_TTL_SEC = envPositive(
  "TRAFFIC_TAR_LOCK_TTL_SEC",
  50,
);
