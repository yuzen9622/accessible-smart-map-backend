import { BinaryMinHeap, type RouteResult } from "./astar";
import { edgeCost, type CostProfile } from "./cost";
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
 * @param profile Requested accessibility cost profile.
 * @returns Nothing.
 */
function assertWheelchairProfile(profile: CostProfile): void {
  if (profile.name !== "wheelchair") {
    throw new Error(`${profile.name} profile not implemented`);
  }
}

/**
 * @param parent Parent node for each settled route node.
 * @param from Dense graph start node identifier.
 * @param to Dense graph goal node identifier.
 * @param totalCost Final route cost in weighted metres.
 * @param expandedNodes Number of nodes removed from the open set for expansion.
 * @param reopenedNodes Number of closed nodes returned to the open set.
 * @returns A completed route result.
 */
function routeResult(
  parent: Int32Array,
  from: number,
  to: number,
  totalCost: number,
  expandedNodes: number,
  reopenedNodes: number,
): RouteResult {
  const reversedPath: number[] = [];
  let node = to;
  while (node !== from) {
    reversedPath.push(node);
    node = parent[node];
    if (node === -1) {
      throw new Error("route parent chain is incomplete");
    }
  }
  reversedPath.push(from);
  reversedPath.reverse();
  return {
    nodePath: Int32Array.from(reversedPath),
    totalCost,
    expandedNodes,
    reopenedNodes,
  };
}

/**
 * @param graph CSR pedestrian graph.
 * @param from Dense graph start node identifier.
 * @param to Dense graph goal node identifier.
 * @param profile Requested accessibility cost profile.
 * @returns The lowest-cost route, or null when no feasible route exists.
 */
export function dijkstra(
  graph: PedGraph,
  from: number,
  to: number,
  profile: CostProfile,
): RouteResult | null {
  assertWheelchairProfile(profile);
  if (!isValidNode(graph, from) || !isValidNode(graph, to)) {
    return null;
  }
  if (from === to) {
    return {
      nodePath: Int32Array.of(from),
      totalCost: 0,
      expandedNodes: 0,
      reopenedNodes: 0,
    };
  }
  const gScore = new Float64Array(graph.nodeCount);
  gScore.fill(Number.POSITIVE_INFINITY);
  const parent = new Int32Array(graph.nodeCount);
  parent.fill(-1);
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
      return routeResult(
        parent,
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
      const edgeCostM = edgeCost(graph, attrIdx, profile);
      if (!Number.isFinite(edgeCostM)) {
        continue;
      }
      const target = graph.adjTarget[adjacencyIndex];
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
      open.push(target, tentativeCost);
    }
  }
  return null;
}
