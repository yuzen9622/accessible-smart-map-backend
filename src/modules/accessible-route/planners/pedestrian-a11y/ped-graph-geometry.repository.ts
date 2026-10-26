import type { PedGraphQueryable } from "./graph-loader";

const EDGE_GEOMETRY_QUERY = `
  SELECT
    edge_id::text AS edge_id,
    ST_AsGeoJSON(geom) AS geojson
  FROM ped_edge
  WHERE version_id = $1 AND edge_id = ANY($2::bigint[])
`;

/** A single [longitude, latitude] pair, matching the WalkLeg polyline order. */
export type LngLat = [number, number];

/**
 * Geometry-read disposition for one selected directed edge. Only an explicit
 * database NULL is an indoor-geometry absence; malformed values and absent rows
 * remain distinguishable so the planner can fail closed for outdoor edges.
 */
export type PedEdgeGeometry =
  | { status: "line"; points: LngLat[] }
  | { status: "null" }
  | { status: "malformed" }
  | { status: "missing" };

interface EdgeGeometryRow {
  edge_id: unknown;
  geojson: unknown;
}

/**
 * @param value Raw `ST_AsGeoJSON` output for one edge.
 * @returns A valid LineString, explicit database NULL, or malformed geometry.
 */
function parseLineString(value: unknown): PedEdgeGeometry {
  if (value === null) {
    return { status: "null" };
  }
  if (typeof value !== "string" || value.length === 0) {
    return { status: "malformed" };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return { status: "malformed" };
  }
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    (parsed as { type?: unknown }).type !== "LineString"
  ) {
    return { status: "malformed" };
  }
  const coordinates = (parsed as { coordinates?: unknown }).coordinates;
  if (!Array.isArray(coordinates) || coordinates.length < 2) {
    return { status: "malformed" };
  }
  const points: LngLat[] = [];
  for (const entry of coordinates) {
    if (
      !Array.isArray(entry) ||
      entry.length < 2 ||
      typeof entry[0] !== "number" ||
      typeof entry[1] !== "number" ||
      !Number.isFinite(entry[0]) ||
      !Number.isFinite(entry[1])
    ) {
      return { status: "malformed" };
    }
    points.push([entry[0], entry[1]]);
  }
  return { status: "line", points };
}

/**
 * Read the stored geometry for a selected set of directed edges.
 *
 * The result is aligned to `edgeIds` positionally, so the caller can stitch a
 * polyline in traversal order without re-sorting. `ped_edge.geom` is already
 * stored in `from_node -> to_node` order for each directed row (the offline
 * builder reverses coordinates when emitting the reverse direction), so no
 * orientation correction is applied or needed here.
 *
 * The result distinguishes an explicit NULL from malformed values and absent
 * rows. This repository never fabricates detailed geometry; whether an
 * unavailable geometry may use indoor endpoint proxies is the caller's
 * explicit, flag-checked decision.
 *
 * @param client Queryable PostGIS client.
 * @param versionId Graph version the edge IDs belong to.
 * @param edgeIds Selected `ped_edge.edge_id` values, in traversal order.
 * @returns One geometry disposition per requested edge, in the requested order.
 */
export async function findPedEdgeGeometries(
  client: PedGraphQueryable,
  versionId: number,
  edgeIds: readonly bigint[],
): Promise<PedEdgeGeometry[]> {
  if (edgeIds.length === 0) {
    return [];
  }
  const uniqueIds = Array.from(new Set(edgeIds.map((id) => id.toString())));
  const result = await client.query<EdgeGeometryRow>(EDGE_GEOMETRY_QUERY, [
    versionId,
    uniqueIds,
  ]);

  const byEdgeId = new Map<string, PedEdgeGeometry>();
  for (const row of result.rows) {
    byEdgeId.set(String(row.edge_id), parseLineString(row.geojson));
  }
  return edgeIds.map(
    (edgeId) => byEdgeId.get(edgeId.toString()) ?? { status: "missing" },
  );
}
