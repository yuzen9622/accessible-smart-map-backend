/**
 * Runtime configuration for the CSR pedestrian accessibility graph.
 *
 * Every value is read on each call so a deployment configuration error surfaces
 * immediately instead of being frozen into a module-load snapshot. A missing
 * `PED_GRAPH_DATABASE_URL` is NOT an error here: it means the CSR walk planner
 * has not been rolled out for this deployment, and the planner reports
 * `unavailable` rather than throwing at application boot.
 */

export interface PedGraphCoveragePoint {
  lat: number;
  lng: number;
}

export type PedGraphCoverageBbox = readonly [
  minLng: number,
  minLat: number,
  maxLng: number,
  maxLat: number,
];

export interface PedGraphConfig {
  /** Postgres/PostGIS connection URI, or null when CSR walking is not deployed. */
  databaseUrl: string | null;
  /** Whether the service should attempt CSR planning for pure walking requests. */
  csrWalkEnabled: boolean;
  /** Wall-clock ceiling for one graph load or refresh attempt. */
  loadTimeoutMs: number;
  /** Minimum interval between ACTIVE-version freshness checks. */
  refreshIntervalMs: number;
}

/**
 * CSR coverage bbox, mirroring `TAIPEI_BBOX` in src/scripts/build-ped-graph.py.
 * Requests reaching outside it are planned by OTP2 as the primary engine, not
 * as a degraded fallback: the CSR graph simply does not describe that ground.
 */
export const PED_GRAPH_COVERAGE_BBOX: PedGraphCoverageBbox = [
  121.43, 24.95, 121.68, 25.22,
];

/**
 * Maximum distance an origin/destination may sit from the chosen routable graph
 * endpoint. A nearby edge projection is insufficient because production routes
 * from an endpoint and must never teleport along an uncounted mid-edge gap.
 * A point that does not snap within this radius is treated as unrepresented
 * graph coverage, never as a satisfied accessibility or fare-policy decision.
 * Historical Phase 0 projection-snap metrics do not describe this release's
 * stricter endpoint-based behavior.
 */
export const PED_GRAPH_MAX_SNAP_TOLERANCE_M = 50;

export const DEFAULT_PED_GRAPH_LOAD_TIMEOUT_MS = 120_000;
export const DEFAULT_PED_GRAPH_REFRESH_INTERVAL_MS = 300_000;

/**
 * @param value Raw environment value.
 * @param name Environment variable name for failure messages.
 * @param fallback Value used when unset or blank.
 * @returns A positive integer millisecond duration.
 */
function positiveMs(
  value: string | undefined,
  name: string,
  fallback: number,
): number {
  if (value == null || value.trim() === "") {
    return fallback;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(
      `Invalid ${name}: expected a positive number of milliseconds, got "${value}"`,
    );
  }
  return parsed;
}

/**
 * @param value Raw environment value.
 * @param name Environment variable name for failure messages.
 * @param fallback Value used when unset or blank.
 * @returns The resolved boolean flag.
 */
function booleanFlag(
  value: string | undefined,
  name: string,
  fallback: boolean,
): boolean {
  if (value == null || value.trim() === "") {
    return fallback;
  }
  const normalized = value.trim().toLowerCase();
  if (normalized === "true" || normalized === "1") return true;
  if (normalized === "false" || normalized === "0") return false;
  throw new Error(`Invalid ${name}: expected true or false, got "${value}"`);
}

/**
 * @returns The current CSR pedestrian graph configuration.
 */
export function getPedGraphConfig(): PedGraphConfig {
  const rawUrl = process.env.PED_GRAPH_DATABASE_URL;
  const databaseUrl =
    rawUrl == null || rawUrl.trim() === "" ? null : rawUrl.trim();

  return {
    databaseUrl,
    // Keep a configured graph database inert until rollout is explicitly
    // approved. Removing the flag therefore returns pure walking to OTP2
    // primary without changing or disconnecting the graph database.
    csrWalkEnabled: booleanFlag(
      process.env.PED_GRAPH_CSR_WALK_ENABLED,
      "PED_GRAPH_CSR_WALK_ENABLED",
      false,
    ),
    loadTimeoutMs: positiveMs(
      process.env.PED_GRAPH_LOAD_TIMEOUT_MS,
      "PED_GRAPH_LOAD_TIMEOUT_MS",
      DEFAULT_PED_GRAPH_LOAD_TIMEOUT_MS,
    ),
    refreshIntervalMs: positiveMs(
      process.env.PED_GRAPH_REFRESH_INTERVAL_MS,
      "PED_GRAPH_REFRESH_INTERVAL_MS",
      DEFAULT_PED_GRAPH_REFRESH_INTERVAL_MS,
    ),
  };
}

/**
 * @param point Latitude/longitude to test.
 * @param bbox Coverage bounds; defaults to the built CSR graph bbox.
 * @returns Whether the point lies inside CSR graph coverage, bounds included.
 */
export function isWithinPedGraphCoverage(
  point: PedGraphCoveragePoint,
  bbox: PedGraphCoverageBbox = PED_GRAPH_COVERAGE_BBOX,
): boolean {
  const [minLng, minLat, maxLng, maxLat] = bbox;
  return (
    Number.isFinite(point.lat) &&
    Number.isFinite(point.lng) &&
    point.lng >= minLng &&
    point.lng <= maxLng &&
    point.lat >= minLat &&
    point.lat <= maxLat
  );
}
