export const VALHALLA_BASE_URL =
  process.env.VALHALLA_BASE_URL ?? "http://localhost:8002";

export const VALHALLA_ROUTE_PATH = "/route";
export const VALHALLA_TIMEOUT_MS = 10_000;
export const VALHALLA_METADATA_BUDGET_MS = 1_000;
export const VALHALLA_METADATA_CONCURRENCY = 2;
export const VALHALLA_MAX_ORIENTATION_COMPARISONS = 100_000;
/**
 * How far before a lane-guided maneuver its suggested lanes are shown. The
 * edge that carries the turn lanes is usually 10–20 m long in Taipei (measured
 * 2026-11-09: median 15 m over 21 lane maneuvers), too short to change lanes.
 */
export const VALHALLA_LANE_PREP_DISTANCE_M = 300;
/** Mirrors `service_limits.max_exclude_locations` in the deployed valhalla.json. */
export const VALHALLA_MAX_EXCLUDE_LOCATIONS = 50;
/**
 * Pedestrian `max_distance` sent with the wheelchair type, whose own default
 * is 10 km. Equals Valhalla's foot default and stays below the default
 * pedestrian `service_limits.max_distance` (250 km), which compose does not override.
 */
export const VALHALLA_WHEELCHAIR_MAX_DISTANCE_M = 100_000;
export const VALHALLA_OSM_ATTRIBUTION = "© OpenStreetMap contributors";
