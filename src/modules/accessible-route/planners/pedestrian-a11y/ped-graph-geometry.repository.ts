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

/** Exact identity in one immutable graph version; ambiguity is never an XY fallback. */
export async function findPedStopNodeId(
  client: PedGraphQueryable,
  versionId: number,
  stopId: string,
): Promise<string | undefined> {
  if (typeof stopId !== "string" || !stopId.length)
    throw new Error("invalid explicit GTFS stop identity");
  const result = await client.query<{ node_id: string }>(
    `SELECT node_id::text FROM ped_node WHERE version_id=$1 AND source_ref=$2`,
    [versionId, `gtfs_pathways:stop:${stopId}`],
  );
  if (result.rows.length > 1) throw new Error("ambiguous GTFS stop identity");
  return result.rows[0]?.node_id;
}

export interface PedEndpointPart {
  edgeId: string;
  fromNodeId: string;
  toNodeId: string;
  nodeId: string;
  points: LngLat[];
  distanceM: number;
  fraction: number;
  plane: string;
}

const ATTACHMENT_CTES = `
 WITH p AS (SELECT ST_SetSRID(ST_MakePoint($3,$4),4326) AS a,
                   ST_SetSRID(ST_MakePoint($5,$6),4326) AS b),
 cells AS (
   SELECT c.* FROM ped_walk_surface_cell c, p
   WHERE c.version_id=$1 AND c.sidewalk_source_version_id=$2
     AND (ST_Covers(c.geom,p.a) OR ST_Covers(c.geom,p.b))
 ),
 witnessed AS (
   SELECT e.*, c.geom AS cell_geom, c.cell_id,
     CASE WHEN (c.grade::text LIKE '%unknown%' OR c.grade::text LIKE '%null%') THEN 'unknown:' || c.source_id ELSE c.grade::text END AS plane
   FROM cells c JOIN ped_edge e ON e.version_id=c.version_id AND e.geom && c.geom
     AND e.attr_meta->'surface_witness'->>'cell_id'=c.cell_id::text
     AND e.attr_meta->'surface_witness'->>'source_id'=c.source_id
     AND e.attr_meta->'surface_witness'->>'source_version_id'=c.sidewalk_source_version_id::text
     AND e.attr_meta->'surface_witness'->'grade'=c.grade
 ),
 mapped AS (
   SELECT e.*,
     jsonb_build_array(COALESCE(e.attr_meta->'osm_tags'->>'layer','0'),
         COALESCE(e.attr_meta->'osm_tags'->>'level','0'),
         CASE WHEN COALESCE(e.attr_meta->'osm_tags'->>'bridge','no') IN ('no','0','false') THEN 'no' ELSE 'yes' END,
         CASE WHEN COALESCE(e.attr_meta->'osm_tags'->>'tunnel','no') IN ('no','0','false') THEN 'no' ELSE 'yes' END)::text AS plane
   FROM ped_edge e, p WHERE e.version_id=$1 AND e.geom IS NOT NULL
     AND e.source_ref LIKE 'osm:%'
     AND (e.geom && ST_Envelope(ST_Buffer(p.a::geography,0.25)::geometry)
       OR e.geom && ST_Envelope(ST_Buffer(p.b::geography,0.25)::geometry))
     AND (ST_DWithin(e.geom::geography,p.a::geography,0.25)
       OR ST_DWithin(e.geom::geography,p.b::geography,0.25))
 )
`;

interface AttachmentRow {
  edge_id: string;
  from_node: string;
  to_node: string;
  node_id: string;
  geojson: string;
  distance_m: unknown;
  fraction: unknown;
  plane: string;
  side: string;
}

function normalizePlane(plane: string): string {
  if (plane.startsWith("unknown:")) return plane;
  const values: unknown = JSON.parse(plane);
  if (
    !Array.isArray(values) ||
    values.length !== 4 ||
    values.some((v) => typeof v !== "string")
  )
    throw new Error("endpoint has an unsupported grade");
  const numeric = values.slice(0, 2).map((v: string) => {
    if (!v.trim() || !Number.isFinite(Number(v)))
      throw new Error("endpoint has an opaque grade");
    return String(Number(v));
  });
  return JSON.stringify([...numeric, ...values.slice(2)]);
}

function endpointPart(row: AttachmentRow): PedEndpointPart {
  const geometry = parseLineString(row.geojson);
  const distanceM = Number(row.distance_m);
  const fraction = Number(row.fraction);
  if (
    geometry.status !== "line" ||
    !Number.isFinite(distanceM) ||
    distanceM < 0 ||
    !Number.isFinite(fraction) ||
    fraction < 0 ||
    (distanceM > 0 && fraction === 0)
  ) {
    throw new Error("invalid persisted endpoint geometry");
  }
  return {
    edgeId: String(row.edge_id),
    fromNodeId: String(row.from_node),
    toNodeId: String(row.to_node),
    nodeId: String(row.node_id),
    points: geometry.points,
    distanceM,
    fraction,
    plane: normalizePlane(row.plane),
  };
}

export async function findPedEndpointAttachments(
  client: PedGraphQueryable,
  versionId: number,
  sourceVersionId: string,
  from: LngLat,
  to: LngLat,
): Promise<{
  origins: PedEndpointPart[];
  destinations: PedEndpointPart[];
  direct: PedEndpointPart[];
}> {
  const result = await client.query<AttachmentRow>(
    ATTACHMENT_CTES +
      `
 , candidates AS (
   SELECT w.edge_id,w.from_node,w.to_node,w.plane, side, n.node_id,
     CASE WHEN side='origin' THEN ST_MakeLine(p.a,n.point)
       ELSE ST_MakeLine(n.point,p.b) END AS line,
     w.length_m
   FROM witnessed w CROSS JOIN p CROSS JOIN (VALUES ('origin'),('destination')) s(side)
     CROSS JOIN LATERAL (VALUES (w.from_node,ST_StartPoint(w.geom)),(w.to_node,ST_EndPoint(w.geom))) n(node_id,point)
   WHERE ST_Covers(w.cell_geom,CASE WHEN side='origin' THEN p.a ELSE p.b END)
     AND ST_CoveredBy(CASE WHEN side='origin' THEN ST_MakeLine(p.a,n.point)
       ELSE ST_MakeLine(n.point,p.b) END,w.cell_geom)
   UNION ALL
   SELECT m.edge_id,m.from_node,m.to_node,m.plane,side,
     CASE WHEN side='origin' THEN m.to_node ELSE m.from_node END,
     CASE WHEN side='origin' THEN ST_MakeLine(p.a,ST_LineSubstring(m.geom,ST_LineLocatePoint(m.geom,p.a),1))
       ELSE ST_MakeLine(ST_LineSubstring(m.geom,0,ST_LineLocatePoint(m.geom,p.b)),p.b) END,
     m.length_m
   FROM mapped m,p,(VALUES ('origin'),('destination')) s(side)
   WHERE ST_DWithin(m.geom::geography,(CASE WHEN side='origin' THEN p.a ELSE p.b END)::geography,0.25)
   UNION ALL
   SELECT w.edge_id,w.from_node,w.to_node,w.plane,'direct',w.to_node,ST_MakeLine(p.a,p.b),w.length_m
   FROM witnessed w,p WHERE ST_Covers(w.cell_geom,p.a) AND ST_Covers(w.cell_geom,p.b)
     AND ST_CoveredBy(ST_MakeLine(p.a,p.b),w.cell_geom)
   UNION ALL
   SELECT m.edge_id,m.from_node,m.to_node,m.plane,'direct',m.to_node,
     ST_MakeLine(ST_MakeLine(p.a,ST_LineSubstring(m.geom,ST_LineLocatePoint(m.geom,p.a),ST_LineLocatePoint(m.geom,p.b))),p.b),m.length_m
   FROM mapped m,p WHERE ST_DWithin(m.geom::geography,p.a::geography,0.25)
     AND ST_DWithin(m.geom::geography,p.b::geography,0.25)
     AND ST_LineLocatePoint(m.geom,p.a)<=ST_LineLocatePoint(m.geom,p.b)
 )
 SELECT edge_id::text,from_node::text,to_node::text,node_id::text,plane,side,
   ST_AsGeoJSON(CASE WHEN GeometryType(line)='POINT' THEN ST_MakeLine(line,line) ELSE line END) AS geojson,
   ST_Length(line::geography) AS distance_m,
   CASE WHEN length_m>0 THEN ST_Length(line::geography)/length_m ELSE 0 END AS fraction
 FROM candidates
 `,
    [versionId, sourceVersionId, ...from, ...to],
  );
  const origins = result.rows
    .filter((r) => r.side === "origin")
    .map(endpointPart);
  const destinations = result.rows
    .filter((r) => r.side === "destination")
    .map(endpointPart);
  const direct = result.rows
    .filter((r) => r.side === "direct")
    .map(endpointPart);
  for (const candidates of [origins, destinations]) {
    if (new Set(candidates.map((c) => c.plane)).size > 1)
      return { origins: [], destinations: [], direct: [] };
  }
  return { origins, destinations, direct };
}
