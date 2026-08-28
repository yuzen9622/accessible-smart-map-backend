import {
  EDGE_FLAG,
  isGtfsIndoorEdge,
  NODE_FLAG,
  NODE_TYPE,
  type PedGraph,
} from "./graph.types";

const RAMP_NODE_TABLE_EXISTS_QUERY = `
  SELECT to_regclass('ped_ramp_node') IS NOT NULL AS table_exists
`;

const RAMP_NODE_IDS_QUERY = `
  SELECT DISTINCT node_id::text AS node_id
  FROM ped_ramp_node
  WHERE version_id = $1
`;

const PAGE_SIZE = 10_000;
const MIN_BIGINT = "-9223372036854775808";
const MAX_INT32 = 2_147_483_647;
const MAX_UINT16 = 65_535;

const LATEST_VERSION_QUERY = `
  SELECT id, node_count, directed_edge_count
  FROM ped_graph_version
  WHERE lifecycle_status = 'ACTIVE'
  ORDER BY built_at DESC, id DESC
  LIMIT 1
`;

const VERSION_QUERY = `
  SELECT id, node_count, directed_edge_count
  FROM ped_graph_version
  WHERE id = $1
`;

/**
 * `ped_osm_way_name` is a standalone backfill table (see
 * `src/scripts/backfill-osm-way-names.py`) that may not exist yet on a fresh
 * database. Checking `to_regclass` first lets the loader fail soft to "no
 * street names" instead of failing the whole graph load.
 */
const WAY_NAME_TABLE_EXISTS_QUERY = `
  SELECT to_regclass('ped_osm_way_name') IS NOT NULL AS table_exists
`;

/**
 * `ped_ramp_edge` is built by `src/scripts/import-taipei-ramps.ts` and is
 * absent until that import has run at least once, so its absence must fail
 * soft to "no ramp points" instead of failing the whole graph load — the
 * same fail-soft contract as `ped_osm_way_name` above.
 */
const RAMP_EDGE_TABLE_EXISTS_QUERY = `
  SELECT to_regclass('ped_ramp_edge') IS NOT NULL AS table_exists
`;

const RAMP_POINTS_QUERY = `
  SELECT
    ramp_edge.edge_id::text AS edge_id,
    ST_X(ramp_point.geom) AS lon,
    ST_Y(ramp_point.geom) AS lat
  FROM ped_ramp_edge AS ramp_edge
  JOIN ped_ramp_point AS ramp_point ON ramp_point.objectid = ramp_edge.objectid
  WHERE ramp_edge.version_id = $1
`;

/**
 * `proxy_geom` is a station centroid shared by every node of that station, so
 * it may only stand in for a node that genuinely has no surveyed position
 * (indoor concourse/platform rows). Entrance and outdoor-connector rows do
 * carry a real `geom`, and their connector edges store real geometry and real
 * lengths against it — reading the centroid for them collapses a station's
 * portals onto one point and contradicts those stored lengths.
 */
const NODE_PAGE_QUERY = `
  SELECT
    node_id::text AS node_id,
    ST_X(COALESCE(geom, proxy_geom)) AS lon,
    ST_Y(COALESCE(geom, proxy_geom)) AS lat,
    station_id,
    station_radius_m,
    node_type,
    geom IS NOT NULL AS has_real_geom
  FROM ped_node
  WHERE version_id = $1 AND node_id > $2
  ORDER BY node_id
  LIMIT $3
`;

const EDGE_COUNT_PAGE_QUERY = `
  SELECT
    edge_id::text AS edge_id,
    from_node::text AS from_node,
    to_node::text AS to_node,
    is_bidirectional
  FROM ped_edge
  WHERE version_id = $1 AND edge_id > $2
  ORDER BY edge_id
  LIMIT $3
`;

const EDGE_PAGE_QUERY = `
  SELECT
    edge_id::text AS edge_id,
    from_node::text AS from_node,
    to_node::text AS to_node,
    length_m,
    edge_type,
    slope_longitudinal,
    surface,
    smoothness,
    effective_width_m AS width_m,
    wheelchair,
    stair_count,
    traversal_time_s,
    has_ramp,
    source_ref,
    attr_meta->'gov_sidewalk_source_id'->>'value' AS sidewalk_source_id,
    attr_meta->'sidewalk_ramp_count'->>'value' AS sidewalk_ramp_count
  FROM ped_edge
  WHERE version_id = $1 AND edge_id > $2
  ORDER BY edge_id
  LIMIT $3
`;

/**
 * Same as `EDGE_PAGE_QUERY`, plus the OSM way name backfilled into
 * `ped_osm_way_name`. Only used once `WAY_NAME_TABLE_EXISTS_QUERY` confirms
 * the table exists; GTFS indoor edges never match (their `source_ref` is not
 * `osm:way/<id>`) and read back as NULL, same as an unnamed way.
 *
 * The `bigint` cast lives inside a `CASE` rather than after a `LIKE` guard:
 * Postgres does not guarantee `AND` short-circuits before evaluating the
 * cast, and a GTFS `source_ref` (e.g. `gtfs_pathways:pathway:9995:reverse`)
 * has no `/`, so `split_part(..., '/', 2)` yields `''` and `''::bigint`
 * throws. `CASE` does guarantee ordered evaluation, and the regex guard only
 * matches a well-formed `osm:way/<digits>` id.
 */
const EDGE_PAGE_QUERY_WITH_STREET_NAME = `
  SELECT
    edge_id::text AS edge_id,
    from_node::text AS from_node,
    to_node::text AS to_node,
    length_m,
    edge_type,
    slope_longitudinal,
    surface,
    smoothness,
    effective_width_m AS width_m,
    wheelchair,
    stair_count,
    traversal_time_s,
    has_ramp,
    source_ref,
    attr_meta->'gov_sidewalk_source_id'->>'value' AS sidewalk_source_id,
    attr_meta->'sidewalk_ramp_count'->>'value' AS sidewalk_ramp_count,
    way_name.name AS street_name
  FROM ped_edge
  LEFT JOIN ped_osm_way_name AS way_name
    ON way_name.osm_way_id = CASE
      WHEN ped_edge.source_ref ~ '^osm:way/[0-9]+$'
      THEN split_part(ped_edge.source_ref, '/', 2)::bigint
    END
  WHERE ped_edge.version_id = $1 AND ped_edge.edge_id > $2
  ORDER BY ped_edge.edge_id
  LIMIT $3
`;

export interface PedGraphQueryable {
  query<R>(sql: string, params?: unknown[]): Promise<{ rows: R[] }>;
}

interface GraphVersionRow {
  id: unknown;
  node_count: unknown;
  directed_edge_count: unknown;
}

interface NodeRow {
  node_id: unknown;
  lon: unknown;
  lat: unknown;
  station_id: unknown;
  station_radius_m: unknown;
  node_type: unknown;
  has_real_geom: unknown;
}

interface EdgeCountRow {
  edge_id: unknown;
  from_node: unknown;
  to_node: unknown;
  is_bidirectional: unknown;
}

interface EdgeRow extends EdgeCountRow {
  length_m: unknown;
  edge_type: unknown;
  slope_longitudinal: unknown;
  surface: unknown;
  smoothness: unknown;
  width_m: unknown;
  wheelchair: unknown;
  stair_count: unknown;
  traversal_time_s: unknown;
  has_ramp: unknown;
  source_ref: unknown;
  sidewalk_source_id: unknown;
  sidewalk_ramp_count: unknown;
  street_name?: unknown;
}

interface WayNameTableRow {
  table_exists: unknown;
}

interface RampPointRow {
  edge_id: unknown;
  lon: unknown;
  lat: unknown;
}

interface RampNodeIdRow {
  node_id: unknown;
}

interface NodeStorage {
  nodeLon: Float64Array;
  nodeLat: Float64Array;
  nodeFlags: Uint8Array;
  nodeStationId: Int32Array;
  originalNodeId: BigInt64Array;
  adjOffset: Int32Array;
}

interface StationTables {
  stationIds: readonly string[];
  stationRadiusM: Float32Array;
}

interface EdgeStorage {
  adjTarget: Int32Array;
  adjAttr: Int32Array;
  edgeOriginalId: BigInt64Array;
  edgeLengthM: Float32Array;
  edgeType: Uint8Array;
  edgeSlope: Float32Array;
  edgeSurface: Uint8Array;
  edgeSmoothness: Uint8Array;
  edgeWidthM: Float32Array;
  edgeWheelchair: Uint8Array;
  edgeStairCount: Uint16Array;
  edgeTraversalTimeS: Float32Array;
  edgeFlags: Uint8Array;
  edgeSidewalkId: Int32Array;
  edgeSidewalkRampCount: Uint16Array;
  edgeStreetName: Int32Array;
}

interface SidewalkTables {
  sidewalkIds: readonly string[];
}

interface StreetNameTables {
  streetNames: readonly string[];
}

interface EdgeCountResult {
  degree: Int32Array;
  undirectedEdgeCount: number;
}

/**
 * @param value Raw PostgreSQL scalar value.
 * @param label Database column name for failures.
 * @returns A finite numeric scalar.
 */
function requiredNumber(value: unknown, label: string): number {
  if (value === null || value === undefined || value === "") {
    throw new Error(`pedestrian graph ${label} is missing`);
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`pedestrian graph ${label} is not finite`);
  }
  return parsed;
}

/**
 * @param value Raw PostgreSQL scalar value.
 * @param label Database column name for failures.
 * @returns A safe non-negative integer.
 */
function nonNegativeInteger(value: unknown, label: string): number {
  const parsed = requiredNumber(value, label);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`pedestrian graph ${label} is not a non-negative integer`);
  }
  return parsed;
}

/**
 * @param value Raw PostgreSQL BIGINT value.
 * @param label Database column name for failures.
 * @returns A signed 64-bit integer.
 */
function bigintValue(value: unknown, label: string): bigint {
  if (typeof value === "number" && !Number.isSafeInteger(value)) {
    throw new Error(`pedestrian graph ${label} is not a safe integer`);
  }
  if (value === null || value === undefined || value === "") {
    throw new Error(`pedestrian graph ${label} is missing`);
  }
  try {
    const parsed = BigInt(value as string | number | bigint | boolean);
    if (BigInt.asIntN(64, parsed) !== parsed) {
      throw new Error(`pedestrian graph ${label} is outside BIGINT range`);
    }
    return parsed;
  } catch (error) {
    if (error instanceof Error) {
      throw error;
    }
    throw new Error(`pedestrian graph ${label} is not a BIGINT`);
  }
}

/**
 * @param value Raw nullable PostgreSQL numeric value.
 * @param label Database column name for failures.
 * @returns A finite number or NaN when the database value is NULL.
 */
function nullableNumber(value: unknown, label: string): number {
  if (value === null || value === undefined) {
    return Number.NaN;
  }
  return requiredNumber(value, label);
}

/**
 * @param value Raw nullable PostgreSQL enum value.
 * @param label Database column name for failures.
 * @returns An unsigned byte enum value, with NULL represented by zero.
 */
function nullableUint8(value: unknown, label: string): number {
  if (value === null || value === undefined) {
    return 0;
  }
  const parsed = nonNegativeInteger(value, label);
  if (parsed > 255) {
    throw new Error(`pedestrian graph ${label} is outside Uint8 range`);
  }
  return parsed;
}

/**
 * @param value Raw nullable PostgreSQL count value.
 * @param label Database column name for failures.
 * @returns An unsigned 16-bit count, with NULL represented by zero.
 */
function nullableUint16(value: unknown, label: string): number {
  if (value === null || value === undefined) {
    return 0;
  }
  const parsed = nonNegativeInteger(value, label);
  if (parsed > MAX_UINT16) {
    throw new Error(`pedestrian graph ${label} is outside Uint16 range`);
  }
  return parsed;
}

/**
 * @param value Raw nullable PostgreSQL text value.
 * @param label Database column name for failures.
 * @returns A text value, or null when the database value is NULL.
 */
function nullableText(value: unknown, label: string): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") {
    throw new Error(`pedestrian graph ${label} is not text`);
  }
  return value;
}

/**
 * @param value Raw PostgreSQL boolean value.
 * @param label Database column name for failures.
 * @returns The decoded boolean.
 */
function booleanValue(value: unknown, label: string): boolean {
  if (
    value === true ||
    value === 1 ||
    value === "1" ||
    value === "t" ||
    value === "true"
  ) {
    return true;
  }
  if (
    value === false ||
    value === 0 ||
    value === "0" ||
    value === "f" ||
    value === "false"
  ) {
    return false;
  }
  throw new Error(`pedestrian graph ${label} is not a boolean`);
}

/**
 * @param originalNodeId Sorted original database node identifiers.
 * @param nodeId Original database node identifier to resolve.
 * @returns The dense node index, or -1 when no node exists.
 */
function findNodeIndex(originalNodeId: BigInt64Array, nodeId: bigint): number {
  let low = 0;
  let high = originalNodeId.length - 1;
  while (low <= high) {
    const middle = low + Math.floor((high - low) / 2);
    const candidate = originalNodeId[middle];
    if (candidate === nodeId) {
      return middle;
    }
    if (candidate < nodeId) {
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  return -1;
}

/**
 * @param nodeCount Number of graph nodes from the version record.
 * @returns Preallocated typed storage for node and CSR offset data.
 */
function createNodeStorage(nodeCount: number): NodeStorage {
  const nodeStationId = new Int32Array(nodeCount);
  nodeStationId.fill(-1);
  return {
    nodeLon: new Float64Array(nodeCount),
    nodeLat: new Float64Array(nodeCount),
    nodeFlags: new Uint8Array(nodeCount),
    nodeStationId,
    originalNodeId: new BigInt64Array(nodeCount),
    adjOffset: new Int32Array(nodeCount + 1),
  };
}

/**
 * @param directedEdgeCount Number of directed graph edges from the version record.
 * @returns Preallocated typed storage for adjacency and edge attributes.
 */
function createEdgeStorage(directedEdgeCount: number): EdgeStorage {
  const edgeLengthM = new Float32Array(directedEdgeCount);
  const edgeSlope = new Float32Array(directedEdgeCount);
  const edgeWidthM = new Float32Array(directedEdgeCount);
  const edgeTraversalTimeS = new Float32Array(directedEdgeCount);
  edgeLengthM.fill(Number.NaN);
  edgeSlope.fill(Number.NaN);
  edgeWidthM.fill(Number.NaN);
  edgeTraversalTimeS.fill(Number.NaN);
  const edgeSidewalkId = new Int32Array(directedEdgeCount);
  edgeSidewalkId.fill(-1);
  const edgeStreetName = new Int32Array(directedEdgeCount);
  edgeStreetName.fill(-1);
  return {
    adjTarget: new Int32Array(directedEdgeCount),
    adjAttr: new Int32Array(directedEdgeCount),
    edgeOriginalId: new BigInt64Array(directedEdgeCount),
    edgeLengthM,
    edgeType: new Uint8Array(directedEdgeCount),
    edgeSlope,
    edgeSurface: new Uint8Array(directedEdgeCount),
    edgeSmoothness: new Uint8Array(directedEdgeCount),
    edgeWidthM,
    edgeWheelchair: new Uint8Array(directedEdgeCount),
    edgeStairCount: new Uint16Array(directedEdgeCount),
    edgeTraversalTimeS,
    edgeFlags: new Uint8Array(directedEdgeCount),
    edgeSidewalkId,
    edgeSidewalkRampCount: new Uint16Array(directedEdgeCount),
    edgeStreetName,
  };
}

/**
 * @param client Queryable PostgreSQL client.
 * @returns Whether `ped_osm_way_name` exists yet. The backfill table is
 * created by a standalone script and may not have run yet, so its absence
 * must never fail loading the graph itself.
 */
async function wayNameTableExists(client: PedGraphQueryable): Promise<boolean> {
  const result = await client.query<WayNameTableRow>(
    WAY_NAME_TABLE_EXISTS_QUERY,
  );
  const row = result.rows[0];
  if (row === undefined) return false;
  return booleanValue(row.table_exists, "table_exists");
}

/**
 * @param client Queryable PostgreSQL client.
 * @returns Whether `ped_ramp_edge` exists yet. It is created by a standalone
 * import script and may not have run yet, so its absence must never fail
 * loading the graph itself.
 */
async function rampEdgeTableExists(
  client: PedGraphQueryable,
): Promise<boolean> {
  const result = await client.query<WayNameTableRow>(
    RAMP_EDGE_TABLE_EXISTS_QUERY,
  );
  const row = result.rows[0];
  if (row === undefined) return false;
  return booleanValue(row.table_exists, "table_exists");
}

/**
 * @param client Queryable PostgreSQL client.
 * @param versionId Resolved graph version identifier.
 * @param edgeOriginalId Sorted original database edge identifiers, dense-index aligned.
 * @returns Curb ramp point coordinates keyed by dense edge attribute index.
 */
async function loadEdgeRampPoints(
  client: PedGraphQueryable,
  versionId: number,
  edgeOriginalId: BigInt64Array,
): Promise<ReadonlyMap<number, readonly [number, number][]>> {
  const result = await client.query<RampPointRow>(RAMP_POINTS_QUERY, [
    versionId,
  ]);
  const edgeRampPoints = new Map<number, [number, number][]>();
  for (const row of result.rows) {
    const edgeId = bigintValue(row.edge_id, "ramp edge_id");
    const attrIdx = findNodeIndex(edgeOriginalId, edgeId);
    if (attrIdx === -1) continue;
    const point: [number, number] = [
      requiredNumber(row.lon, "ramp point longitude"),
      requiredNumber(row.lat, "ramp point latitude"),
    ];
    const existing = edgeRampPoints.get(attrIdx);
    if (existing === undefined) {
      edgeRampPoints.set(attrIdx, [point]);
    } else {
      existing.push(point);
    }
  }
  return edgeRampPoints;
}

/**
 * @param client Queryable PostgreSQL client.
 * @returns Whether `ped_ramp_node` exists yet. It is created by the same
 * standalone import script as `ped_ramp_edge` and may not have run yet, so
 * its absence must never fail loading the graph itself.
 */
async function rampNodeTableExists(
  client: PedGraphQueryable,
): Promise<boolean> {
  const result = await client.query<WayNameTableRow>(
    RAMP_NODE_TABLE_EXISTS_QUERY,
  );
  const row = result.rows[0];
  if (row === undefined) return false;
  return booleanValue(row.table_exists, "table_exists");
}

/**
 * @param client Queryable PostgreSQL client.
 * @param versionId Resolved graph version identifier.
 * @param originalNodeId Sorted original database node identifiers, dense-index aligned.
 * @returns Dense node indexes with at least one matched curb ramp point.
 */
async function loadRampNodeIndexes(
  client: PedGraphQueryable,
  versionId: number,
  originalNodeId: BigInt64Array,
): Promise<number[]> {
  const result = await client.query<RampNodeIdRow>(RAMP_NODE_IDS_QUERY, [
    versionId,
  ]);
  const nodeIndexes: number[] = [];
  for (const row of result.rows) {
    const nodeId = bigintValue(row.node_id, "ramp node_id");
    const nodeIndex = findNodeIndex(originalNodeId, nodeId);
    if (nodeIndex === -1) continue;
    nodeIndexes.push(nodeIndex);
  }
  return nodeIndexes;
}

/**
 * @param value Raw nullable government sidewalk ramp count value.
 * @param label Database column name for failures.
 * @returns An unsigned 16-bit ramp count, rounded from the source float;
 * non-finite or negative values are treated as zero rather than thrown, since
 * a malformed count must never block loading the sidewalk match itself.
 */
function nonNegativeRoundedUint16(value: unknown): number {
  if (value === null || value === undefined || value === "") {
    return 0;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return 0;
  }
  return Math.min(MAX_UINT16, Math.round(parsed));
}

/**
 * @param client Queryable PostgreSQL client.
 * @param versionId Optional requested graph version identifier.
 * @returns The resolved version row.
 */
async function loadGraphVersion(
  client: PedGraphQueryable,
  versionId: number | undefined,
): Promise<{
  versionId: number;
  nodeCount: number;
  directedEdgeCount: number;
}> {
  const result =
    versionId === undefined
      ? await client.query<GraphVersionRow>(LATEST_VERSION_QUERY)
      : await client.query<GraphVersionRow>(VERSION_QUERY, [versionId]);
  const row = result.rows[0];
  if (row === undefined) {
    throw new Error("pedestrian graph version was not found");
  }
  const resolvedVersionId = nonNegativeInteger(row.id, "version id");
  const nodeCount = nonNegativeInteger(row.node_count, "node_count");
  const directedEdgeCount = nonNegativeInteger(
    row.directed_edge_count,
    "directed_edge_count",
  );
  if (nodeCount > MAX_INT32 || directedEdgeCount > MAX_INT32) {
    throw new Error("pedestrian graph exceeds Int32 CSR capacity");
  }
  return { versionId: resolvedVersionId, nodeCount, directedEdgeCount };
}

/**
 * @param client Queryable PostgreSQL client.
 * @param versionId Resolved graph version identifier.
 * @param storage Preallocated node storage to fill.
 * @returns Compact station tables whose reverse dictionary matches `nodeStationId`.
 * Indoor is station_id or node_type 7–12; entrance is node_type 4 or 11;
 * hasRealGeom is geom IS NOT NULL.
 */
async function loadNodes(
  client: PedGraphQueryable,
  versionId: number,
  storage: NodeStorage,
): Promise<StationTables> {
  const stationIndexes = new Map<string, number>();
  const stationIds: string[] = [];
  const stationRadii: number[] = [];
  let cursor = BigInt(MIN_BIGINT);
  let nodeIndex = 0;

  while (true) {
    const result = await client.query<NodeRow>(NODE_PAGE_QUERY, [
      versionId,
      cursor.toString(),
      PAGE_SIZE,
    ]);
    if (result.rows.length === 0) {
      break;
    }
    for (const row of result.rows) {
      if (nodeIndex >= storage.originalNodeId.length) {
        throw new Error(
          "pedestrian graph has more nodes than its version record",
        );
      }
      const nodeId = bigintValue(row.node_id, "node_id");
      if (nodeId <= cursor) {
        throw new Error("pedestrian graph node keyset order is invalid");
      }
      const nodeType = nullableUint8(row.node_type, "node_type");
      const stationId =
        row.station_id === null || row.station_id === undefined
          ? undefined
          : String(row.station_id);
      let flags = booleanValue(row.has_real_geom, "has_real_geom")
        ? NODE_FLAG.HAS_REAL_GEOM
        : 0;
      if (
        stationId !== undefined ||
        nodeType === NODE_TYPE.INDOOR_GENERIC ||
        nodeType === NODE_TYPE.INDOOR_STATION ||
        nodeType === NODE_TYPE.INDOOR_PLATFORM ||
        nodeType === NODE_TYPE.INDOOR_BOARDING_AREA ||
        nodeType === NODE_TYPE.INDOOR_ENTRANCE_EXIT ||
        nodeType === NODE_TYPE.INDOOR_OUTDOOR_CONNECTOR
      ) {
        flags |= NODE_FLAG.INDOOR;
      }
      if (
        nodeType === NODE_TYPE.ENTRANCE ||
        nodeType === NODE_TYPE.INDOOR_ENTRANCE_EXIT
      ) {
        flags |= NODE_FLAG.ENTRANCE;
      }
      storage.nodeLon[nodeIndex] = requiredNumber(row.lon, "node longitude");
      storage.nodeLat[nodeIndex] = requiredNumber(row.lat, "node latitude");
      storage.nodeFlags[nodeIndex] = flags;
      storage.originalNodeId[nodeIndex] = nodeId;
      if (stationId !== undefined) {
        let stationIndex = stationIndexes.get(stationId);
        if (stationIndex === undefined) {
          stationIndex = stationIds.length;
          stationIndexes.set(stationId, stationIndex);
          stationIds.push(stationId);
          stationRadii.push(Number.NaN);
        }
        storage.nodeStationId[nodeIndex] = stationIndex;
        const radius = nullableNumber(row.station_radius_m, "station_radius_m");
        const currentRadius = stationRadii[stationIndex];
        if (
          Number.isNaN(currentRadius) ||
          (!Number.isNaN(radius) && radius > currentRadius)
        ) {
          stationRadii[stationIndex] = radius;
        }
      }
      cursor = nodeId;
      nodeIndex += 1;
    }
    if (result.rows.length < PAGE_SIZE) {
      break;
    }
  }

  if (nodeIndex !== storage.originalNodeId.length) {
    throw new Error("pedestrian graph has fewer nodes than its version record");
  }
  return {
    stationIds: Object.freeze(stationIds),
    stationRadiusM: Float32Array.from(stationRadii),
  };
}

/**
 * @param originalNodeId Sorted original database node identifiers.
 * @param nodeId Raw edge endpoint identifier.
 * @param label Database column name for failures.
 * @returns The dense node index for the endpoint.
 */
function resolveEdgeNode(
  originalNodeId: BigInt64Array,
  nodeId: unknown,
  label: string,
): { denseId: number; originalId: bigint } {
  const originalId = bigintValue(nodeId, label);
  const denseId = findNodeIndex(originalNodeId, originalId);
  if (denseId === -1) {
    throw new Error(
      `pedestrian graph edge ${label} does not exist in ped_node`,
    );
  }
  return { denseId, originalId };
}

/**
 * @param client Queryable PostgreSQL client.
 * @param versionId Resolved graph version identifier.
 * @param originalNodeId Sorted original database node identifiers.
 * @param directedEdgeCount Expected edge count from the version record.
 * @returns Per-node degree counts and the physical undirected-edge total.
 */
async function countEdges(
  client: PedGraphQueryable,
  versionId: number,
  originalNodeId: BigInt64Array,
  directedEdgeCount: number,
): Promise<EdgeCountResult> {
  const degree = new Int32Array(originalNodeId.length);
  let cursor = BigInt(MIN_BIGINT);
  let edgeCount = 0;
  let undirectedEdgeCount = 0;
  let bidirectionalSelfLoops = 0;

  while (true) {
    const result = await client.query<EdgeCountRow>(EDGE_COUNT_PAGE_QUERY, [
      versionId,
      cursor.toString(),
      PAGE_SIZE,
    ]);
    if (result.rows.length === 0) {
      break;
    }
    for (const row of result.rows) {
      const edgeId = bigintValue(row.edge_id, "edge_id");
      if (edgeId <= cursor) {
        throw new Error("pedestrian graph edge keyset order is invalid");
      }
      if (edgeCount >= directedEdgeCount) {
        throw new Error(
          "pedestrian graph has more edges than its version record",
        );
      }
      const from = resolveEdgeNode(originalNodeId, row.from_node, "from_node");
      const to = resolveEdgeNode(originalNodeId, row.to_node, "to_node");
      if (degree[from.denseId] === MAX_INT32) {
        throw new Error("pedestrian graph node degree exceeds Int32 capacity");
      }
      degree[from.denseId] += 1;
      if (booleanValue(row.is_bidirectional, "is_bidirectional")) {
        if (from.originalId < to.originalId) {
          undirectedEdgeCount += 1;
        } else if (from.originalId === to.originalId) {
          bidirectionalSelfLoops += 1;
        }
      } else {
        undirectedEdgeCount += 1;
      }
      cursor = edgeId;
      edgeCount += 1;
    }
    if (result.rows.length < PAGE_SIZE) {
      break;
    }
  }

  if (edgeCount !== directedEdgeCount) {
    throw new Error("pedestrian graph has fewer edges than its version record");
  }
  if (bidirectionalSelfLoops % 2 !== 0) {
    throw new Error(
      "pedestrian graph has an unpaired bidirectional self-loop edge",
    );
  }
  return {
    degree,
    undirectedEdgeCount: undirectedEdgeCount + bidirectionalSelfLoops / 2,
  };
}

/**
 * @param adjOffset CSR offset array to populate.
 * @param degree Per-node outgoing degree counts.
 * @returns Nothing.
 */
function buildAdjOffset(adjOffset: Int32Array, degree: Int32Array): void {
  let total = 0;
  for (let index = 0; index < degree.length; index += 1) {
    adjOffset[index] = total;
    total += degree[index];
    if (total > MAX_INT32) {
      throw new Error("pedestrian graph adjacency exceeds Int32 capacity");
    }
  }
  adjOffset[degree.length] = total;
}

/**
 * @param client Queryable PostgreSQL client.
 * @param versionId Resolved graph version identifier.
 * @param originalNodeId Sorted original database node identifiers.
 * @param adjOffset CSR offsets built from the first edge pass.
 * @param storage Preallocated edge storage to fill.
 * @param edgeQuery Resolved edge page query, with or without the street-name join.
 * @returns Interned government sidewalk identifiers whose dense index matches
 * `storage.edgeSidewalkId`, and interned street names whose dense index
 * matches `storage.edgeStreetName`.
 */
async function fillEdges(
  client: PedGraphQueryable,
  versionId: number,
  originalNodeId: BigInt64Array,
  adjOffset: Int32Array,
  storage: EdgeStorage,
  edgeQuery: string,
): Promise<SidewalkTables & StreetNameTables> {
  const writeOffset = new Int32Array(adjOffset.length - 1);
  writeOffset.set(adjOffset.subarray(0, adjOffset.length - 1));
  const sidewalkIndexes = new Map<string, number>();
  const sidewalkIds: string[] = [];
  const streetNameIndexes = new Map<string, number>();
  const streetNames: string[] = [];
  let cursor = BigInt(MIN_BIGINT);
  let edgeIndex = 0;

  while (true) {
    const result = await client.query<EdgeRow>(edgeQuery, [
      versionId,
      cursor.toString(),
      PAGE_SIZE,
    ]);
    if (result.rows.length === 0) {
      break;
    }
    for (const row of result.rows) {
      const edgeId = bigintValue(row.edge_id, "edge_id");
      if (edgeId <= cursor) {
        throw new Error("pedestrian graph edge keyset order is invalid");
      }
      if (edgeIndex >= storage.adjTarget.length) {
        throw new Error(
          "pedestrian graph has more edges than its version record",
        );
      }
      const from = resolveEdgeNode(originalNodeId, row.from_node, "from_node");
      const to = resolveEdgeNode(originalNodeId, row.to_node, "to_node");
      const adjacencyIndex = writeOffset[from.denseId];
      if (adjacencyIndex >= adjOffset[from.denseId + 1]) {
        throw new Error(
          "pedestrian graph edge count changed between CSR passes",
        );
      }
      storage.adjTarget[adjacencyIndex] = to.denseId;
      storage.adjAttr[adjacencyIndex] = edgeIndex;
      storage.edgeOriginalId[edgeIndex] = edgeId;
      storage.edgeLengthM[edgeIndex] = nullableNumber(row.length_m, "length_m");
      const edgeType = nullableUint8(row.edge_type, "edge_type");
      storage.edgeType[edgeIndex] = edgeType;
      const sourceRef = nullableText(row.source_ref, "source_ref");
      storage.edgeSlope[edgeIndex] = nullableNumber(
        row.slope_longitudinal,
        "slope_longitudinal",
      );
      storage.edgeSurface[edgeIndex] = nullableUint8(row.surface, "surface");
      storage.edgeSmoothness[edgeIndex] = nullableUint8(
        row.smoothness,
        "smoothness",
      );
      storage.edgeWidthM[edgeIndex] = nullableNumber(row.width_m, "width_m");
      storage.edgeWheelchair[edgeIndex] = nullableUint8(
        row.wheelchair,
        "wheelchair",
      );
      storage.edgeStairCount[edgeIndex] = nullableUint16(
        row.stair_count,
        "stair_count",
      );
      storage.edgeTraversalTimeS[edgeIndex] = nullableNumber(
        row.traversal_time_s,
        "traversal_time_s",
      );
      let flags = booleanValue(row.has_ramp, "has_ramp")
        ? EDGE_FLAG.HAS_RAMP
        : 0;
      if (isGtfsIndoorEdge(sourceRef)) {
        flags |= EDGE_FLAG.INDOOR;
      }
      storage.edgeFlags[edgeIndex] = flags;
      const sidewalkSourceId = nullableText(
        row.sidewalk_source_id,
        "sidewalk_source_id",
      );
      if (sidewalkSourceId === null) {
        storage.edgeSidewalkId[edgeIndex] = -1;
        storage.edgeSidewalkRampCount[edgeIndex] = 0;
      } else {
        let sidewalkIndex = sidewalkIndexes.get(sidewalkSourceId);
        if (sidewalkIndex === undefined) {
          sidewalkIndex = sidewalkIds.length;
          sidewalkIndexes.set(sidewalkSourceId, sidewalkIndex);
          sidewalkIds.push(sidewalkSourceId);
        }
        storage.edgeSidewalkId[edgeIndex] = sidewalkIndex;
        storage.edgeSidewalkRampCount[edgeIndex] = nonNegativeRoundedUint16(
          row.sidewalk_ramp_count,
        );
      }
      const streetName = nullableText(row.street_name, "street_name");
      if (streetName === null) {
        storage.edgeStreetName[edgeIndex] = -1;
      } else {
        let streetNameIndex = streetNameIndexes.get(streetName);
        if (streetNameIndex === undefined) {
          streetNameIndex = streetNames.length;
          streetNameIndexes.set(streetName, streetNameIndex);
          streetNames.push(streetName);
        }
        storage.edgeStreetName[edgeIndex] = streetNameIndex;
      }
      writeOffset[from.denseId] += 1;
      cursor = edgeId;
      edgeIndex += 1;
    }
    if (result.rows.length < PAGE_SIZE) {
      break;
    }
  }

  if (edgeIndex !== storage.adjTarget.length) {
    throw new Error("pedestrian graph has fewer edges than its version record");
  }
  for (let nodeId = 0; nodeId < writeOffset.length; nodeId += 1) {
    if (writeOffset[nodeId] !== adjOffset[nodeId + 1]) {
      throw new Error("pedestrian graph edge count changed between CSR passes");
    }
  }
  return {
    sidewalkIds: Object.freeze(sidewalkIds),
    streetNames: Object.freeze(streetNames),
  };
}

/**
 * @param client Queryable PostgreSQL client.
 * @param versionId Optional graph version identifier; the active version is used when omitted.
 * @returns A dense CSR pedestrian graph backed only by typed arrays. `edgeWidthM`
 * carries net usable width only and never falls back to `ped_edge.width_m`, whose
 * gross sidewalk and carriageway values would read as known-passable clearance.
 */
export async function loadPedGraph(
  client: PedGraphQueryable,
  versionId?: number,
): Promise<PedGraph> {
  const version = await loadGraphVersion(client, versionId);
  const nodeStorage = createNodeStorage(version.nodeCount);
  const edgeStorage = createEdgeStorage(version.directedEdgeCount);
  const stationTables = await loadNodes(client, version.versionId, nodeStorage);
  const edgeCount = await countEdges(
    client,
    version.versionId,
    nodeStorage.originalNodeId,
    version.directedEdgeCount,
  );
  buildAdjOffset(nodeStorage.adjOffset, edgeCount.degree);
  if (
    nodeStorage.adjOffset[nodeStorage.adjOffset.length - 1] !==
    version.directedEdgeCount
  ) {
    throw new Error(
      "pedestrian graph CSR count does not match its version record",
    );
  }
  const hasWayNameTable = await wayNameTableExists(client);
  if (!hasWayNameTable) {
    console.warn(
      "[graph-loader] ped_osm_way_name not found; street names disabled until the backfill runs",
    );
  }
  const { sidewalkIds, streetNames } = await fillEdges(
    client,
    version.versionId,
    nodeStorage.originalNodeId,
    nodeStorage.adjOffset,
    edgeStorage,
    hasWayNameTable ? EDGE_PAGE_QUERY_WITH_STREET_NAME : EDGE_PAGE_QUERY,
  );
  const hasRampEdgeTable = await rampEdgeTableExists(client);
  if (!hasRampEdgeTable) {
    console.warn(
      "[graph-loader] ped_ramp_edge not found; ramp points disabled until the import runs",
    );
  }
  const edgeRampPoints = hasRampEdgeTable
    ? await loadEdgeRampPoints(
        client,
        version.versionId,
        edgeStorage.edgeOriginalId,
      )
    : new Map<number, readonly [number, number][]>();
  for (const attrIdx of edgeRampPoints.keys()) {
    edgeStorage.edgeFlags[attrIdx] |= EDGE_FLAG.HAS_KERB_RAMP;
  }

  const hasRampNodeTable = await rampNodeTableExists(client);
  if (!hasRampNodeTable) {
    console.warn(
      "[graph-loader] ped_ramp_node not found; node-level kerb ramps disabled until the import runs",
    );
  }
  if (hasRampNodeTable) {
    const rampNodeIndexes = await loadRampNodeIndexes(
      client,
      version.versionId,
      nodeStorage.originalNodeId,
    );
    for (const nodeIndex of rampNodeIndexes) {
      nodeStorage.nodeFlags[nodeIndex] |= NODE_FLAG.HAS_KERB_RAMP;
    }
  }

  return {
    versionId: version.versionId,
    nodeCount: version.nodeCount,
    directedEdgeCount: version.directedEdgeCount,
    undirectedEdgeCount: edgeCount.undirectedEdgeCount,
    nodeLon: nodeStorage.nodeLon,
    nodeLat: nodeStorage.nodeLat,
    nodeFlags: nodeStorage.nodeFlags,
    nodeStationId: nodeStorage.nodeStationId,
    stationIds: stationTables.stationIds,
    stationRadiusM: stationTables.stationRadiusM,
    originalNodeId: nodeStorage.originalNodeId,
    adjOffset: nodeStorage.adjOffset,
    adjTarget: edgeStorage.adjTarget,
    adjAttr: edgeStorage.adjAttr,
    edgeOriginalId: edgeStorage.edgeOriginalId,
    edgeLengthM: edgeStorage.edgeLengthM,
    edgeType: edgeStorage.edgeType,
    edgeSlope: edgeStorage.edgeSlope,
    edgeSurface: edgeStorage.edgeSurface,
    edgeSmoothness: edgeStorage.edgeSmoothness,
    edgeWidthM: edgeStorage.edgeWidthM,
    edgeWheelchair: edgeStorage.edgeWheelchair,
    edgeStairCount: edgeStorage.edgeStairCount,
    edgeTraversalTimeS: edgeStorage.edgeTraversalTimeS,
    edgeFlags: edgeStorage.edgeFlags,
    edgeSidewalkId: edgeStorage.edgeSidewalkId,
    sidewalkIds,
    edgeSidewalkRampCount: edgeStorage.edgeSidewalkRampCount,
    edgeStreetName: edgeStorage.edgeStreetName,
    streetNames,
    edgeRampPoints,
  };
}
