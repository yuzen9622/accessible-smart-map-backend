export const VALHALLA_BASE_URL =
  process.env.VALHALLA_BASE_URL ?? "http://localhost:8002";

export const VALHALLA_ROUTE_PATH = "/route";
export const VALHALLA_TIMEOUT_MS = 10_000;
/** Mirrors `service_limits.max_exclude_locations` in the deployed valhalla.json. */
export const VALHALLA_MAX_EXCLUDE_LOCATIONS = 50;
/**
 * Pedestrian `max_distance` sent with the wheelchair type, whose own default
 * is 10 km. Equals Valhalla's foot default and stays below the default
 * pedestrian `service_limits.max_distance` (250 km), which compose does not override.
 */
export const VALHALLA_WHEELCHAIR_MAX_DISTANCE_M = 100_000;
export const VALHALLA_OSM_ATTRIBUTION = "© OpenStreetMap contributors";
