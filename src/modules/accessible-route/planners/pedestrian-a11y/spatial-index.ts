import Flatbush from "flatbush";
import { haversineMeters } from "../../../../utils/geo";
import { EDGE_TYPE, NODE_FLAG, type PedGraph } from "./graph.types";

const METERS_PER_DEGREE = 110_000;
const MIN_LONGITUDE_COSINE = 0.000_001;

export interface SnapResult {
  /** Chosen routable graph endpoint. */
  nodeId: number;
  /** Request-point distance to `nodeId`, in metres. */
  distanceM: number;
  edgeAttrIdx: number;
}

export interface EdgeIndex {
  graph: PedGraph;
  flatbush: Flatbush | null;
  edgeFromNode: Int32Array;
  edgeToNode: Int32Array;
  edgeAttrIdx: Int32Array;
  indexedEdgeCount: number;
}

/**
 * @param graph CSR pedestrian graph.
 * @param fromNode Directed edge source node.
 * @param toNode Directed edge target node.
 * @returns Whether the opposing directed edge is present in the adjacency.
 */
function hasReverseEdge(
  graph: PedGraph,
  fromNode: number,
  toNode: number,
): boolean {
  for (
    let adjacencyIndex = graph.adjOffset[toNode];
    adjacencyIndex < graph.adjOffset[toNode + 1];
    adjacencyIndex += 1
  ) {
    if (graph.adjTarget[adjacencyIndex] === fromNode) {
      return true;
    }
  }
  return false;
}

/**
 * @param graph CSR pedestrian graph.
 * @param fromNode Directed edge source node.
 * @param toNode Directed edge target node.
 * @returns Whether this directed edge contributes the sole indexed physical edge.
 * A one-way edge whose target sorts below its source has no opposing direction
 * to represent it, so the ascending-pair rule alone would drop it silently.
 */
function isIndexableEdge(
  graph: PedGraph,
  fromNode: number,
  toNode: number,
): boolean {
  return (
    (graph.nodeFlags[fromNode] & NODE_FLAG.HAS_REAL_GEOM) !== 0 &&
    (graph.nodeFlags[toNode] & NODE_FLAG.HAS_REAL_GEOM) !== 0 &&
    (fromNode < toNode || !hasReverseEdge(graph, fromNode, toNode))
  );
}

/**
 * @param graph CSR pedestrian graph.
 * @returns The number of physical edges eligible for the spatial index.
 */
function countIndexableEdges(graph: PedGraph): number {
  let count = 0;
  for (let fromNode = 0; fromNode < graph.nodeCount; fromNode += 1) {
    for (
      let adjacencyIndex = graph.adjOffset[fromNode];
      adjacencyIndex < graph.adjOffset[fromNode + 1];
      adjacencyIndex += 1
    ) {
      if (isIndexableEdge(graph, fromNode, graph.adjTarget[adjacencyIndex])) {
        count += 1;
      }
    }
  }
  return count;
}

/**
 * @param graph CSR pedestrian graph.
 * @returns A Flatbush-backed index for physical outdoor edge endpoint segments.
 */
export function buildEdgeIndex(graph: PedGraph): EdgeIndex {
  const indexedEdgeCount = countIndexableEdges(graph);
  const edgeFromNode = new Int32Array(indexedEdgeCount);
  const edgeToNode = new Int32Array(indexedEdgeCount);
  const edgeAttrIdx = new Int32Array(indexedEdgeCount);
  if (indexedEdgeCount === 0) {
    return {
      graph,
      flatbush: null,
      edgeFromNode,
      edgeToNode,
      edgeAttrIdx,
      indexedEdgeCount,
    };
  }
  const flatbush = new Flatbush(indexedEdgeCount);
  let indexPosition = 0;

  for (let fromNode = 0; fromNode < graph.nodeCount; fromNode += 1) {
    for (
      let adjacencyIndex = graph.adjOffset[fromNode];
      adjacencyIndex < graph.adjOffset[fromNode + 1];
      adjacencyIndex += 1
    ) {
      const toNode = graph.adjTarget[adjacencyIndex];
      if (!isIndexableEdge(graph, fromNode, toNode)) {
        continue;
      }
      const fromLon = graph.nodeLon[fromNode];
      const fromLat = graph.nodeLat[fromNode];
      const toLon = graph.nodeLon[toNode];
      const toLat = graph.nodeLat[toNode];
      flatbush.add(
        Math.min(fromLon, toLon),
        Math.min(fromLat, toLat),
        Math.max(fromLon, toLon),
        Math.max(fromLat, toLat),
      );
      edgeFromNode[indexPosition] = fromNode;
      edgeToNode[indexPosition] = toNode;
      edgeAttrIdx[indexPosition] = graph.adjAttr[adjacencyIndex];
      indexPosition += 1;
    }
  }

  flatbush.finish();
  return {
    graph,
    flatbush,
    edgeFromNode,
    edgeToNode,
    edgeAttrIdx,
    indexedEdgeCount,
  };
}

/**
 * @param latitude Latitude in degrees.
 * @param longitude Longitude in degrees.
 * @param toleranceM Search tolerance in metres.
 * @returns The longitude-latitude query bounds expanded by the tolerance.
 */
function queryBounds(
  latitude: number,
  longitude: number,
  toleranceM: number,
): [number, number, number, number] {
  const latitudePadding = toleranceM / METERS_PER_DEGREE;
  const longitudeCosine = Math.max(
    Math.abs(Math.cos((latitude * Math.PI) / 180)),
    MIN_LONGITUDE_COSINE,
  );
  const longitudePadding = toleranceM / (METERS_PER_DEGREE * longitudeCosine);
  return [
    longitude - longitudePadding,
    latitude - latitudePadding,
    longitude + longitudePadding,
    latitude + latitudePadding,
  ];
}

/**
 * @param graph CSR pedestrian graph.
 * @param fromNode Directed edge source node.
 * @param toNode Directed edge target node.
 * @param lat Query latitude in degrees.
 * @param lon Query longitude in degrees.
 * @returns The closest routable endpoint and its request-point distance.
 */
function closestEndpoint(
  graph: PedGraph,
  fromNode: number,
  toNode: number,
  lat: number,
  lon: number,
): Pick<SnapResult, "nodeId" | "distanceM"> {
  const fromDistance = haversineMeters(
    lat,
    lon,
    graph.nodeLat[fromNode],
    graph.nodeLon[fromNode],
  );
  const toDistance = haversineMeters(
    lat,
    lon,
    graph.nodeLat[toNode],
    graph.nodeLon[toNode],
  );
  return fromDistance <= toDistance
    ? { nodeId: fromNode, distanceM: fromDistance }
    : { nodeId: toNode, distanceM: toDistance };
}

/**
 * @param index Flatbush-backed physical edge index.
 * @param lat Query latitude in degrees.
 * @param lon Query longitude in degrees.
 * @param toleranceM Maximum snapping distance in metres.
 * @returns The closest routable endpoint and attribute index, or null outside tolerance.
 */
export function snapToGraph(
  index: EdgeIndex,
  lat: number,
  lon: number,
  toleranceM: number,
): SnapResult | null {
  if (
    !Number.isFinite(lat) ||
    !Number.isFinite(lon) ||
    !Number.isFinite(toleranceM) ||
    toleranceM < 0
  ) {
    return null;
  }
  if (index.flatbush === null) {
    return null;
  }
  const candidates = index.flatbush.search(
    ...queryBounds(lat, lon, toleranceM),
  );
  let result: SnapResult | null = null;

  for (const candidate of candidates) {
    const fromNode = index.edgeFromNode[candidate];
    const toNode = index.edgeToNode[candidate];
    const endpoint = closestEndpoint(index.graph, fromNode, toNode, lat, lon);
    if (
      endpoint.distanceM > toleranceM ||
      (result !== null && endpoint.distanceM >= result.distanceM)
    ) {
      continue;
    }
    result = {
      ...endpoint,
      edgeAttrIdx: index.edgeAttrIdx[candidate],
    };
  }

  return result;
}

export interface OutdoorPoint {
  lat: number;
  lng: number;
  /** Request-point distance to the projected point, in metres. */
  distanceM: number;
}

const NON_OUTDOOR_EDGE_TYPES: ReadonlySet<number> = new Set([
  EDGE_TYPE.STEPS,
  EDGE_TYPE.OSM_ELEVATOR,
  EDGE_TYPE.INDOOR_WALKWAY,
  EDGE_TYPE.INDOOR_STAIRS,
  EDGE_TYPE.INDOOR_MOVING_WALKWAY,
  EDGE_TYPE.INDOOR_ESCALATOR,
  EDGE_TYPE.INDOOR_ELEVATOR,
]);

/**
 * Closest point on an outdoor, step-free walkway segment — the street-level
 * spot a router should start or end at. Indoor, stair and elevator edges are
 * skipped so a coordinate above an underground concourse resolves to the
 * street, not the concourse.
 *
 * @param index Flatbush-backed physical edge index.
 * @param lat Query latitude in degrees.
 * @param lon Query longitude in degrees.
 * @param toleranceM Maximum distance in metres.
 * @returns The projected point, or null when no outdoor walkway is in range.
 */
export function nearestOutdoorPoint(
  index: EdgeIndex,
  lat: number,
  lon: number,
  toleranceM: number,
): OutdoorPoint | null {
  if (
    index.flatbush === null ||
    !Number.isFinite(lat) ||
    !Number.isFinite(lon) ||
    !Number.isFinite(toleranceM) ||
    toleranceM < 0
  ) {
    return null;
  }
  const { graph } = index;
  const cosLat = Math.max(
    Math.cos((lat * Math.PI) / 180),
    MIN_LONGITUDE_COSINE,
  );
  let best: OutdoorPoint | null = null;
  for (const candidate of index.flatbush.search(
    ...queryBounds(lat, lon, toleranceM),
  )) {
    const fromNode = index.edgeFromNode[candidate];
    const toNode = index.edgeToNode[candidate];
    if (
      ((graph.nodeFlags[fromNode] | graph.nodeFlags[toNode]) &
        NODE_FLAG.INDOOR) !==
        0 ||
      NON_OUTDOOR_EDGE_TYPES.has(graph.edgeType[index.edgeAttrIdx[candidate]])
    ) {
      continue;
    }
    const ax = (graph.nodeLon[fromNode] - lon) * cosLat;
    const ay = graph.nodeLat[fromNode] - lat;
    const bx = (graph.nodeLon[toNode] - lon) * cosLat;
    const by = graph.nodeLat[toNode] - lat;
    const dx = bx - ax;
    const dy = by - ay;
    const lengthSq = dx * dx + dy * dy;
    const t =
      lengthSq === 0
        ? 0
        : Math.min(1, Math.max(0, -(ax * dx + ay * dy) / lengthSq));
    const pointLat = lat + ay + t * dy;
    const pointLng = lon + (ax + t * dx) / cosLat;
    const distanceM = haversineMeters(lat, lon, pointLat, pointLng);
    if (distanceM > toleranceM || (best && distanceM >= best.distanceM)) {
      continue;
    }
    best = { lat: pointLat, lng: pointLng, distanceM };
  }
  return best;
}
