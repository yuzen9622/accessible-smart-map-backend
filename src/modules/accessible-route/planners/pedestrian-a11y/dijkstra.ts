import { BinaryMinHeap, buildRouteResult, type RouteResult } from "./astar";
import { edgeCost, type CostProfile } from "./cost";
import {
  FORBID_FARE_ACCESS,
  canTraverseFareGate,
  normalizeFareAccessPolicy,
  type FareAccessPolicy,
} from "./fare-access";
import type { PedGraph } from "./graph.types";

/**
 * @param graph CSR pedestrian graph.
 * @param node Dense graph node identifier.
 * @returns Whether the node is present in the graph.
 */
function isValidNode(graph: PedGraph, node: number): boolean {
  return Number.isInteger(node) && node >= 0 && node < graph.nodeCount;
}

/**
 * @param graph CSR pedestrian graph.
 * @param from Dense graph start node identifier.
 * @param to Dense graph goal node identifier.
 * @param profile Requested accessibility cost profile.
 * @param fareAccess Immutable gate policy; omitted routes use frozen fail-closed forbid.
 * @returns The lowest-cost route, or null when no feasible route exists.
 */
export function dijkstra(
  graph: PedGraph,
  from: number,
  to: number,
  profile: CostProfile,
  fareAccess: FareAccessPolicy = FORBID_FARE_ACCESS,
): RouteResult | null {
  const normalizedFareAccess = normalizeFareAccessPolicy(fareAccess);
  if (!isValidNode(graph, from) || !isValidNode(graph, to)) {
    return null;
  }
  if (from === to) {
    return {
      nodePath: Int32Array.of(from),
      edgeAttrPath: new Int32Array(0),
      totalCost: 0,
      expandedNodes: 0,
      reopenedNodes: 0,
    };
  }
  const gScore = new Float64Array(graph.nodeCount);
  gScore.fill(Number.POSITIVE_INFINITY);
  const parent = new Int32Array(graph.nodeCount);
  parent.fill(-1);
  const parentEdgeAttr = new Int32Array(graph.nodeCount);
  parentEdgeAttr.fill(-1);
  const closed = new Uint8Array(graph.nodeCount);
  const open = new BinaryMinHeap();
  gScore[from] = 0;
  open.push(from, 0);
  let expandedNodes = 0;
  let reopenedNodes = 0;

  while (open.size > 0) {
    const node = open.pop();
    const priority = open.lastKey;
    if (node === -1) {
      break;
    }
    if (priority !== gScore[node] || closed[node] !== 0) {
      continue;
    }
    closed[node] = 1;
    expandedNodes += 1;
    if (node === to) {
      return buildRouteResult(
        parent,
        parentEdgeAttr,
        from,
        to,
        gScore[to],
        expandedNodes,
        reopenedNodes,
      );
    }
    for (
      let adjacencyIndex = graph.adjOffset[node];
      adjacencyIndex < graph.adjOffset[node + 1];
      adjacencyIndex += 1
    ) {
      const attrIdx = graph.adjAttr[adjacencyIndex];
      const target = graph.adjTarget[adjacencyIndex];
      if (
        !canTraverseFareGate(graph, node, target, attrIdx, normalizedFareAccess)
      ) {
        continue;
      }
      const edgeCostM = edgeCost(graph, attrIdx, profile, node, target);
      if (!Number.isFinite(edgeCostM)) {
        continue;
      }
      const tentativeCost = gScore[node] + edgeCostM;
      if (!Number.isFinite(tentativeCost) || tentativeCost >= gScore[target]) {
        continue;
      }
      if (closed[target] !== 0) {
        closed[target] = 0;
        reopenedNodes += 1;
      }
      gScore[target] = tentativeCost;
      parent[target] = node;
      parentEdgeAttr[target] = attrIdx;
      open.push(target, tentativeCost);
    }
  }
  return null;
}
