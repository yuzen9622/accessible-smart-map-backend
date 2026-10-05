import type { PedGraphQueryable } from "./graph-loader";
import type { PedGraph } from "./graph.types";
import type { LngLat } from "./ped-graph-geometry.repository";

/** Observation uncertainty remains advisory; this only generates alternatives. */
export const HAZARD_EDGE_SEARCH_RADIUS_M = 5;
export const MAX_HAZARD_AVOID_POINTS = 100;

export const HAZARD_EDGES_QUERY = `
  WITH points AS (
    SELECT ST_SetSRID(ST_MakePoint(lon,lat),4326) AS geom
    FROM unnest($2::double precision[], $3::double precision[]) AS p(lon,lat)
  )
  SELECT DISTINCT edge.edge_id::text AS edge_id
  FROM points
  JOIN ped_edge edge ON edge.version_id = $1
    AND edge.source_ref LIKE 'osm:%'
    AND edge.geom IS NOT NULL
    AND ST_DWithin(edge.geom, points.geom, 0.00006)
    AND ST_DWithin(edge.geom::geography, points.geom::geography, $4)
`;

/** Read affected outdoor edges without mutating the shared graph or cache. */
export async function findHazardEdgeIndexes(
  client: PedGraphQueryable,
  graph: PedGraph,
  points: readonly LngLat[],
): Promise<ReadonlySet<number>> {
  if (points.length === 0) return new Set();
  if (points.length > MAX_HAZARD_AVOID_POINTS) {
    throw new Error("Too many hazard points for a bounded alternative search");
  }
  for (const [lon, lat] of points) {
    if (
      !Number.isFinite(lon) ||
      !Number.isFinite(lat) ||
      lon < -180 ||
      lon > 180 ||
      lat < -90 ||
      lat > 90
    ) {
      throw new Error("Invalid hazard coordinates");
    }
  }
  const result = await client.query<{ edge_id: string }>(HAZARD_EDGES_QUERY, [
    graph.versionId,
    points.map(([lon]) => lon),
    points.map(([, lat]) => lat),
    HAZARD_EDGE_SEARCH_RADIUS_M,
  ]);
  const ids = new Set(result.rows.map(({ edge_id }) => BigInt(edge_id)));
  const indexes = new Set<number>();
  graph.edgeOriginalId.forEach((id, index) => {
    if (ids.has(id)) indexes.add(index);
  });
  return indexes;
}
