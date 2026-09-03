export const VALHALLA_BASE_URL =
  process.env.VALHALLA_BASE_URL ?? "http://localhost:8002";

export const VALHALLA_ROUTE_PATH = "/route";
export const VALHALLA_TIMEOUT_MS = 10_000;
/** Mirrors `service_limits.max_exclude_locations` in the deployed valhalla.json. */
export const VALHALLA_MAX_EXCLUDE_LOCATIONS = 50;
export const VALHALLA_OSM_ATTRIBUTION = "© OpenStreetMap contributors";
