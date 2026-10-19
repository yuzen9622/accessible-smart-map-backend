/**
 * Builds the in-memory CSR {@link PedGraph} for one venue so the existing
 * pedestrian `dijkstra` + `edgeCost` wheelchair model route it unchanged.
 *
 * Every venue edge is bidirectional and becomes two directed attributes.
 * Elevator rides carry a positive `edgeTraversalTimeS` (wait + per-floor ride
 * from the routing config), so `edgeCost` prices them by time; every other
 * edge is priced by its real length. The fare-gate edge type is never used,
 * so the default fail-closed fare policy cannot block a campus gate.
 */
import type { VenueRoutingConfig } from "../../config/routing";
import {
  EDGE_FLAG,
  EDGE_TYPE,
  NODE_FLAG,
  SMOOTHNESS,
  SURFACE,
  WHEELCHAIR,
  type PedGraph,
} from "../accessible-route/planners/pedestrian-a11y/graph.types";
import type { VenueData, VenueEdge, VenueNode } from "./venue.types";

export interface VenueGraph {
  venueId: string;
  version: number;
  graph: PedGraph;
  /** Venue node id → dense node index. */
  nodeIndex: Map<string, number>;
  /** Dense node index → venue node. */
  nodes: VenueNode[];
  /** Dense attribute index → source venue edge. */
  edgeOfAttr: VenueEdge[];
}

/**
 * @param edge Venue edge.
 * @returns The CSR edge type the cost model understands.
 */
export function edgeTypeOf(edge: VenueEdge): number {
  switch (edge.kind) {
    case "elevator":
      return EDGE_TYPE.INDOOR_ELEVATOR;
    case "escalator":
      return EDGE_TYPE.INDOOR_ESCALATOR;
    case "steps":
      return edge.indoor ? EDGE_TYPE.INDOOR_STAIRS : EDGE_TYPE.STEPS;
    case "corridor":
      return EDGE_TYPE.INDOOR_WALKWAY;
    case "crossing":
      return EDGE_TYPE.CROSSING;
    case "path":
      return EDGE_TYPE.PATH;
    case "pedestrian":
      return EDGE_TYPE.PEDESTRIAN;
    case "service":
      return EDGE_TYPE.SERVICE;
    case "footway":
      return edge.indoor ? EDGE_TYPE.INDOOR_WALKWAY : EDGE_TYPE.FOOTWAY;
  }
}

/**
 * @param table Enum table keyed by upper-case OSM value.
 * @param value OSM value (`paving_stones`, `concrete:plates`).
 * @returns The enum code, or 0 (UNKNOWN) for an unlisted value.
 */
function osmEnum(table: Record<string, number>, value?: string): number {
  if (!value) return 0;
  return table[value.toUpperCase().replace(/[:\s-]/g, "_")] ?? 0;
}

/**
 * @param tag Venue wheelchair tag.
 * @returns The CSR wheelchair code.
 */
function wheelchairCode(tag: VenueEdge["wheelchair"]): number {
  switch (tag) {
    case "no":
      return WHEELCHAIR.NO;
    case "limited":
      return WHEELCHAIR.LIMITED;
    case "yes":
      return WHEELCHAIR.YES;
    default:
      return WHEELCHAIR.UNKNOWN;
  }
}

/**
 * @param venue Compiled venue.
 * @param version Stored venue version the graph is built from.
 * @param config Elevator timing.
 * @returns The CSR graph plus id lookups.
 * @throws Error when an edge references a node that does not exist.
 */
export function buildVenueGraph(
  venue: VenueData,
  version: number,
  config: Pick<VenueRoutingConfig, "elevatorWaitS" | "elevatorPerFloorS">,
): VenueGraph {
  const nodes = venue.nodes;
  const nodeIndex = new Map(nodes.map((n, i) => [n.id, i]));
  const nodeCount = nodes.length;

  const directed: { from: number; to: number; edge: VenueEdge }[] = [];
  for (const edge of venue.edges) {
    const a = nodeIndex.get(edge.from);
    const b = nodeIndex.get(edge.to);
    if (a === undefined || b === undefined) {
      throw new Error(
        `venue ${venue.venueId}: edge ${edge.id} references a missing node`,
      );
    }
    directed.push({ from: a, to: b, edge }, { from: b, to: a, edge });
  }
  const m = directed.length;

  const adjOffset = new Int32Array(nodeCount + 1);
  for (const d of directed) adjOffset[d.from + 1] += 1;
  for (let i = 1; i <= nodeCount; i += 1) adjOffset[i] += adjOffset[i - 1];
  const cursor = adjOffset.slice(0, nodeCount);
  const adjTarget = new Int32Array(m);
  const adjAttr = new Int32Array(m);

  const edgeLengthM = new Float32Array(m);
  const edgeType = new Uint8Array(m);
  const edgeSlope = new Float32Array(m).fill(Number.NaN);
  const edgeSurface = new Uint8Array(m);
  const edgeSmoothness = new Uint8Array(m);
  const edgeWidthM = new Float32Array(m).fill(Number.NaN);
  const edgeWheelchair = new Uint8Array(m);
  const edgeStairCount = new Uint16Array(m);
  const edgeTraversalTimeS = new Float32Array(m).fill(Number.NaN);
  const edgeFlags = new Uint8Array(m);
  const edgeOriginalId = new BigInt64Array(m);
  const edgeOfAttr: VenueEdge[] = new Array(m);

  directed.forEach((d, attr) => {
    const slot = cursor[d.from]++;
    adjTarget[slot] = d.to;
    adjAttr[slot] = attr;
    const e = d.edge;
    edgeOfAttr[attr] = e;
    edgeOriginalId[attr] = BigInt(attr);
    edgeLengthM[attr] = e.lengthM;
    edgeType[attr] = edgeTypeOf(e);
    if (e.slopeRatio !== undefined) edgeSlope[attr] = e.slopeRatio;
    if (e.widthM !== undefined) edgeWidthM[attr] = e.widthM;
    edgeSurface[attr] = osmEnum(SURFACE, e.surface);
    edgeSmoothness[attr] = osmEnum(SMOOTHNESS, e.smoothness);
    edgeWheelchair[attr] = wheelchairCode(e.wheelchair);
    edgeStairCount[attr] = e.stepCount ?? 0;
    if (e.kind === "elevator") {
      edgeTraversalTimeS[attr] =
        config.elevatorWaitS + (e.levelSpan ?? 1) * config.elevatorPerFloorS;
    }
    if (e.indoor) edgeFlags[attr] |= EDGE_FLAG.INDOOR;
  });

  const nodeFlags = new Uint8Array(nodeCount);
  nodes.forEach((n, i) => {
    if (n.indoor) nodeFlags[i] |= NODE_FLAG.INDOOR;
    if (n.kind === "entrance" || n.kind === "gate")
      nodeFlags[i] |= NODE_FLAG.ENTRANCE;
    if (n.kerbRamp) nodeFlags[i] |= NODE_FLAG.HAS_KERB_RAMP;
    nodeFlags[i] |= NODE_FLAG.HAS_REAL_GEOM;
  });

  const graph: PedGraph = {
    versionId: version,
    nodeCount,
    directedEdgeCount: m,
    undirectedEdgeCount: venue.edges.length,
    nodeLon: Float64Array.from(nodes, (n) => n.lng),
    nodeLat: Float64Array.from(nodes, (n) => n.lat),
    nodeFlags,
    nodeStationId: new Int32Array(nodeCount).fill(-1),
    stationIds: Object.freeze([]),
    stationRadiusM: new Float32Array(),
    originalNodeId: BigInt64Array.from(nodes, (_n, i) => BigInt(i)),
    adjOffset,
    adjTarget,
    adjAttr,
    edgeOriginalId,
    edgeLengthM,
    edgeType,
    edgeSlope,
    edgeSurface,
    edgeSmoothness,
    edgeWidthM,
    edgeWheelchair,
    edgeStairCount,
    edgeTraversalTimeS,
    edgeFlags,
    edgeSidewalkId: new Int32Array(m).fill(-1),
    sidewalkIds: Object.freeze([]),
    edgeSidewalkRampCount: new Uint16Array(m),
    edgeStreetName: new Int32Array(m).fill(-1),
    streetNames: Object.freeze([]),
    edgeRampPoints: new Map(),
  };

  return {
    venueId: venue.venueId,
    version,
    graph,
    nodeIndex,
    nodes,
    edgeOfAttr,
  };
}
