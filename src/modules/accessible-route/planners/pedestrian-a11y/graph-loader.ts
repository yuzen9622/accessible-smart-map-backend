import { EDGE_FLAG, NODE_FLAG, NODE_TYPE, type PedGraph } from "./graph.types";

const PAGE_SIZE = 10_000;
const MIN_BIGINT = "-9223372036854775808";
const MAX_INT32 = 2_147_483_647;
const MAX_UINT16 = 65_535;

const LATEST_VERSION_QUERY = `
  SELECT id, node_count, directed_edge_count
  FROM ped_graph_version
  ORDER BY built_at DESC, id DESC
  LIMIT 1
`;

const VERSION_QUERY = `
  SELECT id, node_count, directed_edge_count
  FROM ped_graph_version
  WHERE id = $1
`;

const NODE_PAGE_QUERY = `
  SELECT
    node_id::text AS node_id,
    ST_X(proxy_geom) AS lon,
    ST_Y(proxy_geom) AS lat,
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
    geom IS NULL AS is_indoor
  FROM ped_edge
  WHERE version_id = $1 AND edge_id > $2
  ORDER BY edge_id
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
  is_indoor: unknown;
}

interface NodeStorage {
  nodeLon: Float64Array;
  nodeLat: Float64Array;
  nodeFlags: Uint8Array;
  nodeStationId: Int32Array;
  originalNodeId: BigInt64Array;
  adjOffset: Int32Array;
}

interface EdgeStorage {
  adjTarget: Int32Array;
  adjAttr: Int32Array;
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
  return {
    adjTarget: new Int32Array(directedEdgeCount),
    adjAttr: new Int32Array(directedEdgeCount),
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
  };
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
 * @returns The compact station-radius table. Indoor is station_id or node_type 7–12;
 * entrance is node_type 4 or 11; hasRealGeom is geom IS NOT NULL.
 */
async function loadNodes(
  client: PedGraphQueryable,
  versionId: number,
  storage: NodeStorage,
): Promise<Float32Array> {
  const stationIndexes = new Map<string, number>();
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
      storage.nodeLon[nodeIndex] = requiredNumber(
        row.lon,
        "proxy_geom longitude",
      );
      storage.nodeLat[nodeIndex] = requiredNumber(
        row.lat,
        "proxy_geom latitude",
      );
      storage.nodeFlags[nodeIndex] = flags;
      storage.originalNodeId[nodeIndex] = nodeId;
      if (stationId !== undefined) {
        let stationIndex = stationIndexes.get(stationId);
        if (stationIndex === undefined) {
          stationIndex = stationRadii.length;
          stationIndexes.set(stationId, stationIndex);
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
  return Float32Array.from(stationRadii);
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
 * @returns Nothing.
 */
async function fillEdges(
  client: PedGraphQueryable,
  versionId: number,
  originalNodeId: BigInt64Array,
  adjOffset: Int32Array,
  storage: EdgeStorage,
): Promise<void> {
  const writeOffset = new Int32Array(adjOffset.length - 1);
  writeOffset.set(adjOffset.subarray(0, adjOffset.length - 1));
  let cursor = BigInt(MIN_BIGINT);
  let edgeIndex = 0;

  while (true) {
    const result = await client.query<EdgeRow>(EDGE_PAGE_QUERY, [
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
      storage.edgeLengthM[edgeIndex] = nullableNumber(row.length_m, "length_m");
      storage.edgeType[edgeIndex] = nullableUint8(row.edge_type, "edge_type");
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
      if (booleanValue(row.is_indoor, "is_indoor")) {
        flags |= EDGE_FLAG.INDOOR;
      }
      storage.edgeFlags[edgeIndex] = flags;
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
}

/**
 * @param client Queryable PostgreSQL client.
 * @param versionId Optional graph version identifier; the newest version is used when omitted.
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
  const stationRadiusM = await loadNodes(
    client,
    version.versionId,
    nodeStorage,
  );
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
  await fillEdges(
    client,
    version.versionId,
    nodeStorage.originalNodeId,
    nodeStorage.adjOffset,
    edgeStorage,
  );

  return {
    versionId: version.versionId,
    nodeCount: version.nodeCount,
    directedEdgeCount: version.directedEdgeCount,
    undirectedEdgeCount: edgeCount.undirectedEdgeCount,
    nodeLon: nodeStorage.nodeLon,
    nodeLat: nodeStorage.nodeLat,
    nodeFlags: nodeStorage.nodeFlags,
    nodeStationId: nodeStorage.nodeStationId,
    stationRadiusM,
    originalNodeId: nodeStorage.originalNodeId,
    adjOffset: nodeStorage.adjOffset,
    adjTarget: edgeStorage.adjTarget,
    adjAttr: edgeStorage.adjAttr,
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
  };
}
