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
  /** Wall-clock ceiling for one graph load or refresh attempt. */
  loadTimeoutMs: number;
  /** Minimum interval between ACTIVE-version freshness checks. */
  refreshIntervalMs: number;
}

/**
 * CSR coverage bbox, mirroring `TAIWAN_BBOX` in src/scripts/build-ped-graph.py
 * (the graph build in build-otp-graph.sh uses `--bbox taiwan`). Requests
 * reaching outside it are planned by OTP2 as the primary engine, not as a
 * degraded fallback: the CSR graph simply does not describe that ground.
 */
export const PED_GRAPH_COVERAGE_BBOX: PedGraphCoverageBbox = [
  118.0, 21.8, 122.1, 26.5,
];

/**
 * Maximum distance an origin/destination may sit from the chosen routable graph
 * endpoint. A nearby edge projection is insufficient because production routes
 * from an endpoint and must never teleport along an uncounted mid-edge gap.
 * A point that does not snap within this radius is treated as unrepresented
 * graph coverage, never as a satisfied accessibility or fare-policy decision.
 * Historical Phase 0 projection-snap metrics do not describe this release's
 * stricter endpoint-based behavior.
 *
 * 60 m rather than 50 m because the middle of a large station hall (Taipei
 * Main Station) sits 51-55 m from the nearest connected walkway: at 50 m those
 * points reached only an isolated platform staircase and every walk from them
 * failed. On 464 sample points the wider radius snaps 8 more, all 50-57 m out.
 */
export const PED_GRAPH_MAX_SNAP_TOLERANCE_M = 60;

/**
 * A connected piece of the graph with fewer nodes than this is a fragment:
 * an isolated platform staircase, a footpath stub, a severed service road.
 * A request point prefers an endpoint on a larger piece when one lies within
 * the snap tolerance, because a route can never leave a fragment. Graph v34
 * has about 5,900 pieces under 50 nodes and about 100 above, the smallest real ones being
 * offshore islands of a few hundred nodes.
 */
export const PED_GRAPH_SNAP_MIN_COMPONENT_NODES = 50;

/**
 * Side of the grid cells, in metres, that mark where the government curb ramp
 * survey has data: a cell holding at least one surveyed ramp is surveyed.
 * The survey covers Taipei only, where ramps sit at most junctions, so a
 * junction-sized cell follows the city edge without leaving holes inside it.
 */
export const KERB_RAMP_SURVEY_CELL_M = 200;

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
 * @returns The current CSR pedestrian graph configuration.
 */
export function getPedGraphConfig(): PedGraphConfig {
  const rawUrl = process.env.PED_GRAPH_DATABASE_URL;
  const databaseUrl =
    rawUrl == null || rawUrl.trim() === "" ? null : rawUrl.trim();

  return {
    databaseUrl,
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
