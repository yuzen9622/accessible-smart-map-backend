import { physicalWidthAllows, searchPedGraph, type RouteResult } from "./astar";
import { edgeCost, type CostProfile } from "./cost";
import {
  canTraverseFareGate,
  FORBID_FARE_ACCESS,
  type FareAccessPolicy,
} from "./fare-access";
import type { PedGraph } from "./graph.types";
import type { PedEndpointPart } from "./ped-graph-geometry.repository";

export interface EndpointPart extends PedEndpointPart {
  attr: number;
  from: number;
  to: number;
  node: number;
}

export function denseId(ids: BigInt64Array, raw: string): number {
  const id = BigInt(raw);
  let low = 0;
  let high = ids.length - 1;
  while (low <= high) {
    const middle = (low + high) >>> 1;
    if (ids[middle] === id) return middle;
    if (ids[middle] < id) low = middle + 1;
    else high = middle - 1;
  }
  throw new Error("endpoint evidence is absent from the pinned graph");
}

export function resolveEndpointPart(
  graph: PedGraph,
  part: PedEndpointPart,
): EndpointPart {
  return {
    ...part,
    attr: denseId(graph.edgeOriginalId, part.edgeId),
    from: denseId(graph.originalNodeId, part.fromNodeId),
    to: denseId(graph.originalNodeId, part.toNodeId),
    node: denseId(graph.originalNodeId, part.nodeId),
  };
}

/** Zero-length identity attachment: sentinel attr is never costed or emitted as an edge. */
export function stopEndpointPart(
  graph: PedGraph,
  nodeId: string,
): EndpointPart {
  const node = denseId(graph.originalNodeId, nodeId);
  return {
    edgeId: "",
    fromNodeId: nodeId,
    toNodeId: nodeId,
    nodeId,
    attr: -1,
    from: node,
    to: node,
    node,
    points: [[graph.nodeLon[node], graph.nodeLat[node]]],
    distanceM: 0,
    fraction: 0,
    plane: "gtfs-identity",
  };
}

export function endpointCost(
  graph: PedGraph,
  part: EndpointPart,
  profile: CostProfile,
  excluded: ReadonlySet<number>,
  fare: FareAccessPolicy,
): number {
  if (part.distanceM === 0) return 0;
  if (
    !physicalWidthAllows(graph, part.attr, profile) ||
    excluded.has(part.attr) ||
    !canTraverseFareGate(graph, part.from, part.to, part.attr, fare)
  )
    return Infinity;
  const cost = edgeCost(graph, part.attr, profile, part.from, part.to);
  return Number.isFinite(cost) ? cost * part.fraction : Infinity;
}

export interface AttachedRoute {
  route: RouteResult;
  origin?: EndpointPart;
  destination?: EndpointPart;
  direct?: EndpointPart;
}

export function searchAttachedRoute(
  graph: PedGraph,
  attachments: {
    origins: EndpointPart[];
    destinations: EndpointPart[];
    direct: EndpointPart[];
  },
  profile: CostProfile,
  excludedEdges: ReadonlySet<number>,
  deadlineMs: number,
  fareAccess: FareAccessPolicy = FORBID_FARE_ACCESS,
  topologyOnly = false,
):
  | { status: "found"; selected: AttachedRoute }
  | { status: "unreachable" }
  | { status: "budget_exhausted" } {
  if (Date.now() >= deadlineMs) return { status: "budget_exhausted" };
  const costOf = (part: EndpointPart) =>
    topologyOnly
      ? 0
      : endpointCost(graph, part, profile, excludedEdges, fareAccess);
  const origins = attachments.origins.filter((p) => Number.isFinite(costOf(p)));
  const destinations = attachments.destinations.filter((p) =>
    Number.isFinite(costOf(p)),
  );
  let best: AttachedRoute | undefined;
  for (const direct of attachments.direct) {
    const cost = costOf(direct);
    if (Number.isFinite(cost) && (!best || cost < best.route.totalCost)) {
      best = {
        direct,
        route: {
          nodePath: Int32Array.of(direct.from, direct.to),
          edgeAttrPath: Int32Array.of(direct.attr),
          totalCost: cost,
          expandedNodes: 0,
          reopenedNodes: 0,
        },
      };
    }
  }
  if (origins.length && destinations.length) {
    const outcome = searchPedGraph(
      graph,
      origins[0].node,
      destinations[0].node,
      profile,
      {
        deadlineMs,
        fareAccess,
        excludedEdges,
        topologyOnly,
        sources: origins.map((p) => ({ node: p.node, cost: costOf(p) })),
        targets: destinations.map((p) => ({ node: p.node, cost: costOf(p) })),
      },
    );
    if (outcome.status === "budget_exhausted") return outcome;
    if (
      outcome.status === "found" &&
      (!best || outcome.route.totalCost < best.route.totalCost)
    ) {
      best = {
        route: outcome.route,
        origin: origins[outcome.route.sourceIndex ?? 0],
        destination: destinations[outcome.route.targetIndex ?? 0],
      };
    }
  }
  if (Date.now() >= deadlineMs) return { status: "budget_exhausted" };
  return best ? { status: "found", selected: best } : { status: "unreachable" };
}
