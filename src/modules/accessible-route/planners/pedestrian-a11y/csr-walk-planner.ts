/**
 * Pure-walking route selection on the CSR pedestrian accessibility graph.
 *
 * This planner exists to make the difference between "this engine cannot
 * answer" and "this engine answered no on purpose" a first-class, structured
 * result. The service layer uses the distinction to make OTP2 fallback
 * transparent and to keep a policy/accessibility-blocked result from
 * escalating to an unprotected Valhalla route when OTP2 is unavailable.
 */

import { isWithinPedGraphCoverage } from "../../../../config/ped-graph";
import { getRoutingConfig } from "../../../../config/routing";
import type { AccessibilityMode } from "../../../../types/route";
import { haversineMeters } from "../../../../utils/geo";
import { walkSpeedMps } from "../../scoring";
import {
  resolveEndpointPart,
  stopEndpointPart,
  searchAttachedRoute,
  type AttachedRoute,
  type EndpointPart,
} from "./endpoint-routing";
import type { CostProfile } from "./cost";
import {
  DIAGNOSTIC_ALLOW_ALL_FARE_ACCESS,
  FORBID_FARE_ACCESS,
  createTransitAuthorizedFareAccess,
} from "./fare-access";
import {
  isPedGraphQualification,
  type PedGraphQueryable,
} from "./graph-loader";
import { getPedGraphClient, getPedGraphRuntime } from "./graph-runtime";
import { findHazardEdgeIndexes } from "./hazard-edges.repository";
import {
  EDGE_FLAG,
  EDGE_TYPE,
  NODE_FLAG,
  SURFACE,
  type PedGraph,
} from "./graph.types";
import {
  findPedEdgeGeometries,
  findPedEndpointAttachments,
  findPedStopNodeId,
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
import { buildCsrStepStreetNames, buildCsrWalkSteps } from "./csr-steps";
import { collectRampPoints } from "./ramp-points";
import { sumSidewalkRampCount } from "./sidewalk-ramp-count";

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
  /** Internal exact GTFS identity; missing explicit identities fail closed. */
  stopId?: string;
  lat: number;
  lng: number;
}

/**
 * @param mode Requested accessibility mode.
 * @param pass Wheelchair search tier; normal walking retains stair eligibility.
 * @returns A profile that never relaxes unrelated known limits.
 */
export function profileFor(
  mode: AccessibilityMode,
  pass: "step-free" | "stairs-fallback" = "step-free",
): CostProfile {
  const profile: CostProfile = {
    name: mode,
    walkSpeedMps: walkSpeedMps(mode),
    relaxationLevel: 0,
  };
  return mode === "wheelchair"
    ? {
        ...profile,
        forbidStairs: pass === "step-free",
        stairsFallback: pass === "stairs-fallback",
      }
    : profile;
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
 * @param nodePath Dense node sequence traversed by the route, one longer than
 * `edgeAttrPath`; `nodePath[i]`/`nodePath[i + 1]` are the endpoints of
 * `edgeAttrPath[i]`.
 * @param edgeAttrPath Dense edge attribute identifiers, in traversal order.
 * @returns The observed accessibility summary for the path.
 */
function summarizeAccessibility(
  graph: PedGraph,
  nodePath: Int32Array,
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

  for (let index = 0; index < edgeAttrPath.length; index += 1) {
    const attrIdx = edgeAttrPath[index];
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
      const hasOsmRampTag =
        (graph.edgeFlags[attrIdx] & EDGE_FLAG.HAS_RAMP) !== 0;
      const fromNode = nodePath[index];
      const toNode = nodePath[index + 1];
      const bothEndpointsHaveKerbRamp =
        (graph.nodeFlags[fromNode] & NODE_FLAG.HAS_KERB_RAMP) !== 0 &&
        (graph.nodeFlags[toNode] & NODE_FLAG.HAS_KERB_RAMP) !== 0;
      if (hasOsmRampTag || bothEndpointsHaveKerbRamp) {
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

interface SelectedPiece {
  attr: number;
  from: number;
  to: number;
  geometry: PedEdgeGeometry;
  distanceM: number;
  durationS: number;
}

class RequestBudgetExhausted extends Error {}

async function beforeDeadline<T>(
  deadlineMs: number,
  work: () => Promise<T>,
): Promise<T> {
  const remaining = deadlineMs - Date.now();
  if (remaining <= 0) throw new RequestBudgetExhausted();
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      work(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new RequestBudgetExhausted()),
          remaining,
        );
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function selectedPieces(
  client: PedGraphQueryable,
  graph: PedGraph,
  selected: AttachedRoute,
  profile: CostProfile,
  deadlineMs: number,
): Promise<SelectedPiece[]> {
  const pieces: SelectedPiece[] = [];
  const addPartial = (part: EndpointPart | undefined) => {
    if (!part || part.distanceM === 0) return;
    const time = graph.edgeTraversalTimeS[part.attr];
    pieces.push({
      attr: part.attr,
      from: part.from,
      to: part.to,
      geometry: { status: "line", points: part.points },
      distanceM: part.distanceM,
      durationS:
        (graph.edgeFlags[part.attr] & EDGE_FLAG.INDOOR) !== 0 &&
        Number.isFinite(time) &&
        time >= 0
          ? time * part.fraction
          : part.distanceM / profile.walkSpeedMps,
    });
  };
  if (selected.direct) {
    addPartial(selected.direct);
    return pieces;
  }
  addPartial(selected.origin);
  const route = selected.route;
  const geometries = await beforeDeadline(deadlineMs, () =>
    findPedEdgeGeometries(
      client,
      graph.versionId,
      Array.from(route.edgeAttrPath, (attr) => graph.edgeOriginalId[attr]),
    ),
  );
  for (let i = 0; i < route.edgeAttrPath.length; i++) {
    const attr = route.edgeAttrPath[i];
    const nodes = Int32Array.of(route.nodePath[i], route.nodePath[i + 1]);
    const measurement = measurePath(
      graph,
      nodes,
      Int32Array.of(attr),
      [geometries[i]],
      profile,
    );
    if (measurement.status !== "ok") throw new Error(measurement.reason);
    pieces.push({
      attr,
      from: nodes[0],
      to: nodes[1],
      geometry: geometries[i],
      distanceM: measurement.distanceM,
      durationS: measurement.durationS,
    });
  }
  addPartial(selected.destination);
  return pieces;
}

export async function planCsrWalkRoute(
  points: readonly CsrWalkPoint[],
  options: CsrWalkOptions,
): Promise<CsrWalkResult> {
  const deadlineMs =
    options.deadlineMs ?? Date.now() + getRoutingConfig().planBudgetMs;
  if (!Number.isFinite(deadlineMs) || Date.now() >= deadlineMs)
    return { status: "budget_exhausted" };
  if (
    points.length < 2 ||
    !points.every((p) => Number.isFinite(p.lng) && Number.isFinite(p.lat))
  )
    return { status: "outside_coverage" };
  try {
    if (
      options.fareAccess &&
      options.fareAccess.mode !== "forbid" &&
      options.fareAccess.mode !== "transit_authorized"
    )
      return {
        status: "unavailable",
        reason: "invalid served fare access mode",
      };
    const fareAccess =
      options.fareAccess?.mode === "transit_authorized"
        ? createTransitAuthorizedFareAccess(
            options.fareAccess.authorizedStationIds,
          )
        : FORBID_FARE_ACCESS;
    const runtime = options.context
      ? { status: "ready" as const, snapshot: options.context }
      : await beforeDeadline(deadlineMs, getPedGraphRuntime);
    if (Date.now() >= deadlineMs) return { status: "budget_exhausted" };
    if (runtime.status !== "ready") return runtime;
    const { graph } = runtime.snapshot;
    const policy = graph.qualification;
    if (!isPedGraphQualification(policy))
      return {
        status: "unavailable",
        reason: "graph lacks persisted sidewalk-v1 qualification",
      };
    if (!points.every((p) => isWithinPedGraphCoverage(p, policy.extent)))
      return { status: "outside_coverage" };
    const client = await beforeDeadline(deadlineMs, getPedGraphClient);
    const avoidPoints = options.avoidPoints;
    const excluded = avoidPoints?.length
      ? await beforeDeadline(deadlineMs, () =>
          findHazardEdgeIndexes(client, graph, avoidPoints),
        )
      : new Set<number>();
    const identityParts = await Promise.all(
      points.map(async (point) => {
        const stopId = point.stopId;
        if (stopId === undefined) return undefined;
        const nodeId = await beforeDeadline(deadlineMs, () =>
          findPedStopNodeId(client, graph.versionId, stopId),
        );
        if (nodeId === undefined)
          throw new Error("explicit GTFS stop absent from pinned graph");
        return stopEndpointPart(graph, nodeId);
      }),
    );
    const attachments = [];
    let missingAttachment = false;
    for (let i = 0; i < points.length - 1; i++) {
      if (Date.now() >= deadlineMs) return { status: "budget_exhausted" };
      const found = await beforeDeadline(deadlineMs, () =>
        findPedEndpointAttachments(
          client,
          graph.versionId,
          policy.sourceVersionId,
          [points[i].lng, points[i].lat],
          [points[i + 1].lng, points[i + 1].lat],
        ),
      );
      const origin = identityParts[i];
      const destination = identityParts[i + 1];
      const attached = {
        origins: origin
          ? [origin]
          : found.origins.map((p) => resolveEndpointPart(graph, p)),
        destinations: destination
          ? [destination]
          : found.destinations.map((p) => resolveEndpointPart(graph, p)),
        direct:
          origin || destination
            ? []
            : found.direct.map((p) => resolveEndpointPart(graph, p)),
      };
      if (!attached.origins.length || !attached.destinations.length)
        missingAttachment = true;
      attachments.push(attached);
    }
    const strictProfile = profileFor(options.mode);
    if (options.mode !== "wheelchair" && options.avoidStairs)
      strictProfile.stairsAvoidanceMultiplier = 12;
    const strict = attachments.map((a) =>
      searchAttachedRoute(
        graph,
        a,
        strictProfile,
        excluded,
        deadlineMs,
        fareAccess,
      ),
    );
    if (strict.some((r) => r.status === "budget_exhausted"))
      return { status: "budget_exhausted" };
    if (missingAttachment) {
      for (let i = 0; i < strict.length; i++) {
        if (strict[i].status !== "unreachable") continue;
        const gate = searchAttachedRoute(
          graph,
          attachments[i],
          strictProfile,
          excluded,
          deadlineMs,
          DIAGNOSTIC_ALLOW_ALL_FARE_ACCESS,
        );
        if (gate.status === "budget_exhausted")
          return { status: "budget_exhausted" };
        if (gate.status === "found") return { status: "fare_policy_blocked" };
      }
      return {
        status: "unavailable",
        reason:
          "origin or destination has no unambiguous qualified surface or mapped-edge attachment",
      };
    }
    const plans: CsrWalkPlan[] = [];
    for (let i = 0; i < attachments.length; i++) {
      let result = strict[i];
      let profile = strictProfile;
      let stairsFallback = false;
      if (
        result.status === "unreachable" &&
        options.mode === "wheelchair" &&
        options.allowStairsFallback !== false
      ) {
        profile = profileFor(options.mode, "stairs-fallback");
        result = searchAttachedRoute(
          graph,
          attachments[i],
          profile,
          excluded,
          deadlineMs,
          fareAccess,
        );
        stairsFallback = result.status === "found";
      }
      if (result.status === "budget_exhausted")
        return { status: "budget_exhausted" };
      if (result.status === "unreachable") {
        const gate = searchAttachedRoute(
          graph,
          attachments[i],
          profile,
          excluded,
          deadlineMs,
          DIAGNOSTIC_ALLOW_ALL_FARE_ACCESS,
        );
        if (gate.status === "budget_exhausted")
          return { status: "budget_exhausted" };
        if (gate.status === "found") return { status: "fare_policy_blocked" };
        const topology = searchAttachedRoute(
          graph,
          attachments[i],
          profile,
          excluded,
          deadlineMs,
          fareAccess,
          true,
        );
        if (topology.status === "budget_exhausted")
          return { status: "budget_exhausted" };
        return {
          status:
            topology.status === "found"
              ? "accessibility_blocked"
              : "topology_disconnected",
        };
      }
      const { selected } = result;
      const pieces = await selectedPieces(
        client,
        graph,
        selected,
        profile,
        deadlineMs,
      );
      const attrs = Int32Array.from(pieces.map((p) => p.attr));
      const nodes = Int32Array.from(
        pieces.length
          ? [pieces[0].from, ...pieces.map((p) => p.to)]
          : [selected.route.nodePath[0]],
      );
      const geometry = assembleGeometry(
        graph,
        nodes,
        attrs,
        pieces.map((p) => p.geometry),
      );
      if (geometry.status !== "ok") return geometry;
      if (!pieces.length && !identityParts[i] && !identityParts[i + 1])
        geometry.polyline = [
          [points[i].lng, points[i].lat],
          [points[i + 1].lng, points[i + 1].lat],
        ];
      const steps = buildCsrWalkSteps(
        graph,
        nodes,
        attrs,
        geometry.spans,
        geometry.polyline,
        0,
        options.mode,
      );
      steps.forEach((step, index) => {
        step.distanceM = pieces[index].distanceM;
      });
      const a11ySegments = buildA11ySegments(graph, attrs, geometry.spans, 0);
      for (const segment of a11ySegments) {
        if (segment.distanceM === null) continue;
        const distance = pieces.reduce((sum, piece, index) => {
          const span = geometry.spans[index];
          return span.startIndex >= segment.startIndex &&
            span.endIndex <= segment.endIndex
            ? sum + piece.distanceM
            : sum;
        }, 0);
        segment.distanceM = Math.round(distance * 10) / 10;
      }
      const stepStreetNames = buildCsrStepStreetNames(graph, attrs, steps);
      plans.push({
        policy,
        fareAccess,
        stairsFallback,
        selectedEdgeIds: Array.from(attrs, (attr) =>
          graph.edgeOriginalId[attr].toString(),
        ),
        polyline: geometry.polyline,
        distanceM: pieces.reduce((sum, p) => sum + p.distanceM, 0),
        durationS: pieces.reduce((sum, p) => sum + p.durationS, 0),
        graphVersionId: graph.versionId,
        approximateIndoorSegmentCount: geometry.approximateIndoorSegmentCount,
        accessibility: summarizeAccessibility(graph, nodes, attrs),
        a11ySegments,
        steps,
        ...(stepStreetNames.length ? { stepStreetNames } : {}),
        sidewalkRampCount: sumSidewalkRampCount(graph, attrs),
        a11yPoints: collectRampPoints(graph, attrs),
        diagnostics: {
          expandedNodes: selected.route.expandedNodes,
          reopenedNodes: selected.route.reopenedNodes,
          edgeCount: attrs.length,
          totalCostM: selected.route.totalCost,
          relaxationLevel: profile.relaxationLevel,
          originSnapDistanceM: selected.origin?.distanceM ?? 0,
          destinationSnapDistanceM: selected.destination?.distanceM ?? 0,
        },
      });
    }
    return Date.now() >= deadlineMs
      ? { status: "budget_exhausted" }
      : { status: "ok", plans };
  } catch (error) {
    return error instanceof RequestBudgetExhausted || Date.now() >= deadlineMs
      ? { status: "budget_exhausted" }
      : {
          status: "unavailable",
          reason:
            error instanceof Error
              ? error.message
              : "pedestrian route evidence unavailable",
        };
  }
}
