/**
 * Pure-walking route selection on the CSR pedestrian accessibility graph.
 *
 * This planner exists to make the difference between "this engine cannot
 * answer" and "this engine answered no on purpose" a first-class, structured
 * result. The service layer uses the distinction to make OTP2 fallback
 * transparent and to keep a policy/accessibility-blocked result from
 * escalating to an unprotected Valhalla route when OTP2 is unavailable.
 */

import {
  PED_GRAPH_MAX_SNAP_TOLERANCE_M,
  getPedGraphConfig,
  isWithinPedGraphCoverage,
} from "../../../../config/ped-graph";
import type { AccessibilityMode } from "../../../../types/route";
import { haversineMeters } from "../../../../utils/geo";
import { walkSpeedMps } from "../../scoring";
import { aStar, type RouteResult } from "./astar";
import type { CostProfile } from "./cost";
import {
  DIAGNOSTIC_ALLOW_ALL_FARE_ACCESS,
  FORBID_FARE_ACCESS,
} from "./fare-access";
import type { PedGraphQueryable } from "./graph-loader";
import { getPedGraphClient, getPedGraphRuntime } from "./graph-runtime";
import { EDGE_FLAG, EDGE_TYPE, SURFACE, type PedGraph } from "./graph.types";
import {
  findPedEdgeGeometries,
  type LngLat,
  type PedEdgeGeometry,
} from "./ped-graph-geometry.repository";
import type {
  CsrWalkAccessibility,
  CsrWalkOptions,
  CsrWalkPlan,
  CsrWalkResult,
} from "./csr-walk.types";
import { buildA11ySegments, type EdgeGeometrySpan } from "./a11y-segments";
import { buildCsrWalkSteps } from "./csr-steps";
import { collectRampPoints } from "./ramp-points";
import { sumSidewalkRampCount } from "./sidewalk-ramp-count";
import { snapToGraph, type EdgeIndex, type SnapResult } from "./spatial-index";

/**
 * Longitude/latitude tolerance for treating the last vertex of one edge and the
 * first vertex of the next as the same shared join, in degrees. Roughly 0.1 mm,
 * so it only ever collapses an exactly-shared node, never two distinct places.
 */
const JOIN_TOLERANCE_DEG = 1e-9;

/** Surfaces that are loose enough to report as `gravel` to the client. */
const LOOSE_SURFACES: ReadonlySet<number> = new Set([
  SURFACE.COMPACTED,
  SURFACE.FINE_GRAVEL,
  SURFACE.GRAVEL,
  SURFACE.PEBBLESTONE,
  SURFACE.ROCK,
  SURFACE.DIRT,
  SURFACE.EARTH,
  SURFACE.GROUND,
  SURFACE.MUD,
  SURFACE.SAND,
  SURFACE.GRASS,
  SURFACE.CLAY,
  SURFACE.UNPAVED,
  SURFACE.SOIL,
  SURFACE.CHIPPINGS,
  SURFACE.SHELLS,
  SURFACE.WOODCHIPS,
  SURFACE.MULCH,
  SURFACE.LEAVES,
]);

/** Surfaces that are firm enough to report as `paved` to the client. */
const FIRM_SURFACES: ReadonlySet<number> = new Set([
  SURFACE.ASPHALT,
  SURFACE.CONCRETE,
  SURFACE.CONCRETE_LANES,
  SURFACE.CONCRETE_PLATES,
  SURFACE.PAVING_STONES,
  SURFACE.SETT,
  SURFACE.COBBLESTONE,
  SURFACE.UNHEWN_COBBLESTONE,
  SURFACE.BRICKS,
  SURFACE.TILES,
  SURFACE.METAL,
  SURFACE.WOOD,
  SURFACE.RUBBER,
  SURFACE.PLASTIC,
  SURFACE.GRASS_PAVER,
  SURFACE.ARTIFICIAL_TURF,
  SURFACE.TARTAN,
  SURFACE.PAVED,
]);

export interface CsrWalkPoint {
  lat: number;
  lng: number;
}

/**
 * @param mode Requested accessibility mode.
 * @returns The cost profile for that mode at the strict relaxation level.
 */
function profileFor(mode: AccessibilityMode): CostProfile {
  return {
    name: mode,
    walkSpeedMps: walkSpeedMps(mode),
    relaxationLevel: 0,
  };
}

/**
 * Directed reachability that ignores edge cost, accessibility feasibility, and
 * fare policy entirely — a pure walk of the CSR adjacency arrays.
 *
 * This is deliberately not `dijkstra` or an unweighted cost search: both skip
 * edges whose weight is non-finite, which would report a merely expensive or
 * infeasible corridor as a disconnected graph and license an OTP fallback that
 * bypasses the accessibility decision.
 *
 * @param graph CSR pedestrian graph.
 * @param from Dense source node identifier.
 * @param to Dense target node identifier.
 * @returns Whether any directed edge chain connects the two nodes.
 */
export function isTopologyReachable(
  graph: PedGraph,
  from: number,
  to: number,
): boolean {
  if (from === to) return true;
  const visited = new Uint8Array(graph.nodeCount);
  const queue = new Int32Array(graph.nodeCount);
  let head = 0;
  let tail = 0;
  visited[from] = 1;
  queue[tail] = from;
  tail += 1;
  while (head < tail) {
    const node = queue[head];
    head += 1;
    for (
      let adjacencyIndex = graph.adjOffset[node];
      adjacencyIndex < graph.adjOffset[node + 1];
      adjacencyIndex += 1
    ) {
      const target = graph.adjTarget[adjacencyIndex];
      if (target === to) return true;
      if (visited[target] !== 0) continue;
      visited[target] = 1;
      queue[tail] = target;
      tail += 1;
    }
  }
  return false;
}

/**
 * @param first One coordinate pair.
 * @param second Another coordinate pair.
 * @returns Whether both describe the same vertex within the join tolerance.
 */
function isSameVertex(first: LngLat, second: LngLat): boolean {
  return (
    Math.abs(first[0] - second[0]) <= JOIN_TOLERANCE_DEG &&
    Math.abs(first[1] - second[1]) <= JOIN_TOLERANCE_DEG
  );
}

/**
 * @param graph CSR pedestrian graph.
 * @param node Dense graph node identifier.
 * @returns That node's coordinate pair in WalkLeg polyline order.
 */
function nodeCoordinate(graph: PedGraph, node: number): LngLat {
  return [graph.nodeLon[node], graph.nodeLat[node]];
}

type GeometryAssembly =
  | {
      status: "ok";
      polyline: LngLat[];
      spans: EdgeGeometrySpan[];
      approximateIndoorSegmentCount: number;
    }
  | { status: "unavailable"; reason: string };

/**
 * Stitch the stored geometry of the selected directed edges into one polyline.
 *
 * Stored `ped_edge.geom` is already oriented `from_node -> to_node`, so edges
 * are concatenated exactly as traversed and never reversed. A geometry absence
 * is only proxy-eligible on an explicitly indoor edge; an outdoor edge without
 * a valid LineString cannot safely describe a CSR route and must fall back.
 *
 * @param graph CSR pedestrian graph.
 * @param nodePath Traversed dense node identifiers.
 * @param edgeAttrPath Selected directed edge attributes, in traversal order.
 * @param geometries Stored geometry disposition per selected edge.
 * @returns The joined polyline, or unavailable when an outdoor geometry is unusable.
 */
function assembleGeometry(
  graph: PedGraph,
  nodePath: Int32Array,
  edgeAttrPath: Int32Array,
  geometries: readonly PedEdgeGeometry[],
): GeometryAssembly {
  const polyline: LngLat[] = [];
  const spans: EdgeGeometrySpan[] = [];
  let approximateIndoorSegmentCount = 0;

  for (let step = 0; step < geometries.length; step += 1) {
    const geometry = geometries[step];
    let points: LngLat[];
    if (geometry.status === "line") {
      points = geometry.points;
    } else {
      const attrIdx = edgeAttrPath[step];
      if ((graph.edgeFlags[attrIdx] & EDGE_FLAG.INDOOR) === 0) {
        return {
          status: "unavailable",
          reason: `selected outdoor edge ${graph.edgeOriginalId[attrIdx].toString()} has ${geometry.status} geometry`,
        };
      }
      points = [
        nodeCoordinate(graph, nodePath[step]),
        nodeCoordinate(graph, nodePath[step + 1]),
      ];
      approximateIndoorSegmentCount += 1;
    }
    const startIndex = polyline.length === 0 ? 0 : polyline.length - 1;
    for (const point of points) {
      const previous = polyline[polyline.length - 1];
      if (previous !== undefined && isSameVertex(previous, point)) continue;
      polyline.push(point);
    }
    spans.push({
      startIndex,
      endIndex: Math.max(startIndex, polyline.length - 1),
    });
  }

  if (polyline.length === 0 && nodePath.length > 0) {
    polyline.push(nodeCoordinate(graph, nodePath[0]));
  }
  return { status: "ok", polyline, spans, approximateIndoorSegmentCount };
}

/**
 * @param polyline Selected graph geometry.
 * @param from Requested segment origin.
 * @param to Requested segment destination.
 * @returns Geometry with the counted straight snap connectors at both ends,
 * plus the index shift an unshifted origin connector applies to `polyline`.
 */
function addSnapConnectors(
  polyline: readonly LngLat[],
  from: CsrWalkPoint,
  to: CsrWalkPoint,
): { polyline: LngLat[]; indexOffset: number } {
  const connected = [...polyline];
  const origin: LngLat = [from.lng, from.lat];
  const destination: LngLat = [to.lng, to.lat];
  let indexOffset = 0;
  const first = connected[0];
  if (first === undefined || !isSameVertex(origin, first)) {
    connected.unshift(origin);
    indexOffset = 1;
  }
  const last = connected[connected.length - 1];
  if (last === undefined || !isSameVertex(last, destination)) {
    connected.push(destination);
  }
  return { polyline: connected, indexOffset };
}

/**
 * @param graph CSR pedestrian graph.
 * @param nodePath Traversed dense node identifiers.
 * @param attrIdx Dense edge attribute identifier.
 * @param step Position of this edge in the traversal.
 * @returns The edge's ground length, falling back to its endpoint separation
 * only when it is not an approximate indoor proxy edge.
 */
function edgeGroundDistanceM(
  graph: PedGraph,
  nodePath: Int32Array,
  attrIdx: number,
  step: number,
): number {
  const lengthM = graph.edgeLengthM[attrIdx];
  if (Number.isFinite(lengthM) && lengthM >= 0) return lengthM;
  return haversineMeters(
    graph.nodeLat[nodePath[step]],
    graph.nodeLon[nodePath[step]],
    graph.nodeLat[nodePath[step + 1]],
    graph.nodeLon[nodePath[step + 1]],
  );
}

/**
 * Source-backed accessibility observations for the selected edges.
 *
 * Every dimension stays `null` / `unknown` when the graph carries no
 * measurement for it, so absent data is never rendered as a favourable value.
 *
 * @param graph CSR pedestrian graph.
 * @param edgeAttrPath Dense edge attribute identifiers, in traversal order.
 * @returns The observed accessibility summary for the path.
 */
function summarizeAccessibility(
  graph: PedGraph,
  edgeAttrPath: Int32Array,
): CsrWalkAccessibility {
  if (edgeAttrPath.length === 0) {
    return {
      maxSlopePercent: null,
      crossings: null,
      crossingsWithCurbRamp: null,
      minPathWidthCm: null,
      surfaceType: "unknown",
    };
  }

  let maxSlopePercent: number | null = null;
  let minPathWidthCm: number | null = null;
  let crossings = 0;
  let crossingsWithCurbRamp = 0;
  let sawLooseSurface = false;
  let sawFirmSurface = false;

  for (const attrIdx of edgeAttrPath) {
    const slopeRatio = graph.edgeSlope[attrIdx];
    if (Number.isFinite(slopeRatio)) {
      const slopePercent = Math.abs(slopeRatio) * 100;
      maxSlopePercent =
        maxSlopePercent === null
          ? slopePercent
          : Math.max(maxSlopePercent, slopePercent);
    }

    const widthM = graph.edgeWidthM[attrIdx];
    if (Number.isFinite(widthM) && widthM > 0) {
      const widthCm = widthM * 100;
      minPathWidthCm =
        minPathWidthCm === null ? widthCm : Math.min(minPathWidthCm, widthCm);
    }

    if (graph.edgeType[attrIdx] === EDGE_TYPE.CROSSING) {
      crossings += 1;
      if ((graph.edgeFlags[attrIdx] & EDGE_FLAG.HAS_RAMP) !== 0) {
        crossingsWithCurbRamp += 1;
      }
    }

    const surface = graph.edgeSurface[attrIdx];
    if (LOOSE_SURFACES.has(surface)) sawLooseSurface = true;
    else if (FIRM_SURFACES.has(surface)) sawFirmSurface = true;
  }

  return {
    maxSlopePercent:
      maxSlopePercent === null ? null : Math.round(maxSlopePercent * 10) / 10,
    crossings,
    crossingsWithCurbRamp: crossings === 0 ? null : crossingsWithCurbRamp,
    minPathWidthCm: minPathWidthCm === null ? null : Math.round(minPathWidthCm),
    surfaceType: sawLooseSurface
      ? "gravel"
      : sawFirmSurface
        ? "paved"
        : "unknown",
  };
}

/**
 * @param graph CSR pedestrian graph.
 * @param nodePath Traversed dense node identifiers.
 * @param edgeAttrPath Dense edge attribute identifiers, in traversal order.
 * @param geometries Stored geometry disposition per selected edge.
 * @param profile Cost profile that produced the path.
 * @returns Ground distance and duration, or unavailable when a proxy edge lacks
 * a source-backed traversal time for its otherwise unknowable distance.
 */
function measurePath(
  graph: PedGraph,
  nodePath: Int32Array,
  edgeAttrPath: Int32Array,
  geometries: readonly PedEdgeGeometry[],
  profile: CostProfile,
):
  | { status: "ok"; distanceM: number; durationS: number }
  | { status: "unavailable"; reason: string } {
  let distanceM = 0;
  let durationS = 0;

  for (let step = 0; step < edgeAttrPath.length; step += 1) {
    const attrIdx = edgeAttrPath[step];
    const isIndoor = (graph.edgeFlags[attrIdx] & EDGE_FLAG.INDOOR) !== 0;
    const lengthM = graph.edgeLengthM[attrIdx];
    const hasStoredLength = Number.isFinite(lengthM) && lengthM >= 0;
    const geometry = geometries[step];
    const usesIndoorProxy = isIndoor && geometry?.status !== "line";
    const traversalTimeS = graph.edgeTraversalTimeS[attrIdx];

    if (usesIndoorProxy && !hasStoredLength) {
      if (!Number.isFinite(traversalTimeS) || traversalTimeS <= 0) {
        return {
          status: "unavailable",
          reason: `selected indoor proxy edge ${graph.edgeOriginalId[attrIdx].toString()} has no positive traversal_time_s`,
        };
      }
      // This is the same base-distance conversion used by `baseCost`: station
      // nodes may share a centroid proxy, so their coordinate separation would
      // falsely turn a traversable indoor path into a zero-metre route.
      const estimatedDistanceM = traversalTimeS * profile.walkSpeedMps;
      if (!Number.isFinite(estimatedDistanceM) || estimatedDistanceM <= 0) {
        return {
          status: "unavailable",
          reason: `selected indoor proxy edge ${graph.edgeOriginalId[attrIdx].toString()} has an invalid traversal distance`,
        };
      }
      distanceM += estimatedDistanceM;
      durationS += traversalTimeS;
      continue;
    }

    const groundDistanceM = edgeGroundDistanceM(graph, nodePath, attrIdx, step);
    distanceM += groundDistanceM;
    durationS +=
      isIndoor && Number.isFinite(traversalTimeS) && traversalTimeS >= 0
        ? traversalTimeS
        : groundDistanceM / profile.walkSpeedMps;
  }

  return { status: "ok", distanceM, durationS };
}

/** Why one segment of a CSR walking request produced no path. */
type SegmentBlock =
  | { status: "unavailable"; reason: string }
  | { status: "topology_disconnected" }
  | { status: "fare_policy_blocked" }
  | { status: "accessibility_blocked" };

type SegmentOutcome =
  | {
      status: "ok";
      route: RouteResult;
      origin: SnapResult;
      destination: SnapResult;
      from: CsrWalkPoint;
      to: CsrWalkPoint;
    }
  | SegmentBlock;

/**
 * Plan and classify exactly one origin/destination pair.
 *
 * The classification order is load-bearing: the fare-gate probe runs before any
 * other explanation is considered, so a path that only a fare gate blocked can
 * never be misreported as an accessibility or topology problem (which would
 * license an OTP fallback straight through the paid area).
 *
 * @param graph CSR pedestrian graph.
 * @param index Flatbush-backed physical edge index.
 * @param from Segment origin coordinate.
 * @param to Segment destination coordinate.
 * @param profile Cost profile for the requested mode.
 * @returns The selected path, or the reason there is none.
 */
function planSegment(
  graph: PedGraph,
  index: EdgeIndex,
  from: CsrWalkPoint,
  to: CsrWalkPoint,
  profile: CostProfile,
): SegmentOutcome {
  const origin = snapToGraph(
    index,
    from.lat,
    from.lng,
    PED_GRAPH_MAX_SNAP_TOLERANCE_M,
  );
  if (origin === null) {
    return {
      status: "unavailable",
      reason: `origin has no graph edge within ${PED_GRAPH_MAX_SNAP_TOLERANCE_M}m`,
    };
  }
  const destination = snapToGraph(
    index,
    to.lat,
    to.lng,
    PED_GRAPH_MAX_SNAP_TOLERANCE_M,
  );
  if (destination === null) {
    return {
      status: "unavailable",
      reason: `destination has no graph edge within ${PED_GRAPH_MAX_SNAP_TOLERANCE_M}m`,
    };
  }

  const constrained = aStar(
    graph,
    origin.nodeId,
    destination.nodeId,
    profile,
    FORBID_FARE_ACCESS,
  );
  if (constrained !== null) {
    return { status: "ok", route: constrained, origin, destination, from, to };
  }

  // Gate probe: same profile and graph, but a planner-local diagnostic policy
  // opens every gate. This remains separate from served authorization: it only
  // answers whether a gate was binding, and its route is discarded. It also
  // catches a malformed gate whose endpoint station IDs are blank or mismatched
  // (which must stay fail-closed for normal traversal) so it can never be
  // misreported as an accessibility block.
  const gateProbe = aStar(
    graph,
    origin.nodeId,
    destination.nodeId,
    profile,
    DIAGNOSTIC_ALLOW_ALL_FARE_ACCESS,
  );
  if (gateProbe !== null) return { status: "fare_policy_blocked" };

  return isTopologyReachable(graph, origin.nodeId, destination.nodeId)
    ? { status: "accessibility_blocked" }
    : { status: "topology_disconnected" };
}

/**
 * Blocking reasons in decreasing precedence.
 *
 * A deliberate policy "no" on any segment outranks a can't-answer on another:
 * if one segment is fare-blocked, replanning the whole route with OTP2 would
 * route that segment through the paid shortcut the policy just refused.
 */
const BLOCK_PRECEDENCE = [
  "fare_policy_blocked",
  "accessibility_blocked",
  "topology_disconnected",
  "unavailable",
] as const;

/**
 * @param blocks Every blocking segment outcome for the request.
 * @returns The single outcome that must be reported for the whole request.
 */
function highestPrecedenceBlock(blocks: readonly SegmentBlock[]): SegmentBlock {
  for (const status of BLOCK_PRECEDENCE) {
    const match = blocks.find((block) => block.status === status);
    if (match !== undefined) return match;
  }
  return blocks[0];
}

/**
 * Plan a pure-walking route across ordered points on the CSR pedestrian graph.
 *
 * Each adjacent pair of `points` becomes one plan, and `plans` is returned in
 * exactly the requested order, so the caller can map waypoints to legs without
 * re-sorting. The whole request resolves to a single status: any segment that
 * cannot be served decides the outcome for all of them, because a partially
 * CSR-planned route would claim protection it did not apply end to end.
 *
 * @param points Ordered origin, waypoint, and destination coordinates.
 * @param options Requested accessibility mode.
 * @returns Ordered plans, or the structured reason there are none.
 */
export async function planCsrWalkRoute(
  points: readonly CsrWalkPoint[],
  options: CsrWalkOptions,
): Promise<CsrWalkResult> {
  if (points.length < 2) {
    return { status: "outside_coverage" };
  }

  const { csrWalkEnabled } = getPedGraphConfig();
  // A deployment that never enabled CSR walking is not a degraded deployment:
  // OTP2 is its primary walk engine, so this reads as unrepresented coverage
  // rather than a runtime failure that should warn on every request.
  if (!csrWalkEnabled) {
    return { status: "outside_coverage" };
  }

  if (!points.every((point) => isWithinPedGraphCoverage(point))) {
    return { status: "outside_coverage" };
  }

  // Evaluate representability only after the deployment and geographic gates:
  // an explicit combination outside Taipei (or while CSR is disabled) remains
  // an ordinary OTP-primary request, not a degraded CSR failure.
  const avoidStairs = options.avoidStairs ?? options.mode === "wheelchair";
  if (avoidStairs !== (options.mode === "wheelchair")) {
    return { status: "unsupported_constraints" };
  }

  const runtime = await getPedGraphRuntime();
  if (runtime.status !== "ready") {
    return { status: "unavailable", reason: runtime.reason };
  }

  const { graph, index } = runtime.snapshot;
  const profile = profileFor(options.mode);

  const outcomes = points
    .slice(0, -1)
    .map((from, segmentIndex) =>
      planSegment(graph, index, from, points[segmentIndex + 1], profile),
    );

  const blocks = outcomes.filter(
    (outcome): outcome is SegmentBlock => outcome.status !== "ok",
  );
  if (blocks.length > 0) {
    const block = highestPrecedenceBlock(blocks);
    return block.status === "unavailable"
      ? { status: "unavailable", reason: block.reason }
      : { status: block.status };
  }

  const served = outcomes.filter(
    (outcome): outcome is Extract<SegmentOutcome, { status: "ok" }> =>
      outcome.status === "ok",
  );

  let client: PedGraphQueryable;
  try {
    client = await getPedGraphClient();
  } catch (error: unknown) {
    return {
      status: "unavailable",
      reason:
        error instanceof Error
          ? error.message
          : "pedestrian graph client unavailable",
    };
  }

  const plans: CsrWalkPlan[] = [];
  for (const segment of served) {
    const { route, origin, destination, from, to } = segment;
    const edgeIds = Array.from(
      route.edgeAttrPath,
      (attrIdx) => graph.edgeOriginalId[attrIdx],
    );

    let geometries: PedEdgeGeometry[];
    try {
      geometries = await findPedEdgeGeometries(
        client,
        graph.versionId,
        edgeIds,
      );
    } catch (error: unknown) {
      return {
        status: "unavailable",
        reason:
          error instanceof Error
            ? error.message
            : "selected edge geometry read failed",
      };
    }

    const geometry = assembleGeometry(
      graph,
      route.nodePath,
      route.edgeAttrPath,
      geometries,
    );
    if (geometry.status === "unavailable") {
      return { status: "unavailable", reason: geometry.reason };
    }
    const pathMeasurement = measurePath(
      graph,
      route.nodePath,
      route.edgeAttrPath,
      geometries,
      profile,
    );
    if (pathMeasurement.status === "unavailable") {
      return { status: "unavailable", reason: pathMeasurement.reason };
    }
    const connectorDistanceM = origin.distanceM + destination.distanceM;
    const connectorDurationS = connectorDistanceM / profile.walkSpeedMps;
    const connectors = addSnapConnectors(geometry.polyline, from, to);

    plans.push({
      polyline: connectors.polyline,
      distanceM: pathMeasurement.distanceM + connectorDistanceM,
      durationS: pathMeasurement.durationS + connectorDurationS,
      graphVersionId: graph.versionId,
      approximateIndoorSegmentCount: geometry.approximateIndoorSegmentCount,
      accessibility: summarizeAccessibility(graph, route.edgeAttrPath),
      a11ySegments: buildA11ySegments(
        graph,
        route.edgeAttrPath,
        geometry.spans,
        connectors.indexOffset,
      ),
      steps: buildCsrWalkSteps(
        graph,
        route.nodePath,
        route.edgeAttrPath,
        geometry.spans,
        connectors.polyline,
        connectors.indexOffset,
        options.mode,
      ),
      sidewalkRampCount: sumSidewalkRampCount(graph, route.edgeAttrPath),
      a11yPoints: collectRampPoints(graph, route.edgeAttrPath),
      diagnostics: {
        expandedNodes: route.expandedNodes,
        reopenedNodes: route.reopenedNodes,
        edgeCount: route.edgeAttrPath.length,
        totalCostM: route.totalCost,
        relaxationLevel: profile.relaxationLevel,
        originSnapDistanceM: origin.distanceM,
        destinationSnapDistanceM: destination.distanceM,
      },
    });
  }

  return { status: "ok", plans };
}
