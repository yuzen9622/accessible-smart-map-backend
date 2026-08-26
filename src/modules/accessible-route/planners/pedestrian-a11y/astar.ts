import { haversineMeters } from "../../../../utils/geo";
import { edgeCost, type CostProfile } from "./cost";
import type { PedGraph } from "./graph.types";

const INITIAL_HEAP_CAPACITY = 64;

export interface RouteResult {
  nodePath: Int32Array;
  totalCost: number;
  expandedNodes: number;
  reopenedNodes: number;
}

/**
 * @param keyA First queue key.
 * @param nodeA First node identifier.
 * @param keyB Second queue key.
 * @param nodeB Second node identifier.
 * @returns Whether the first entry has higher queue priority.
 */
function hasHigherPriority(
  keyA: number,
  nodeA: number,
  keyB: number,
  nodeB: number,
): boolean {
  return keyA < keyB || (keyA === keyB && nodeA < nodeB);
}

export class BinaryMinHeap {
  private keys: Float64Array;
  private nodes: Int32Array;
  private count = 0;
  private mostRecentKey = Number.NaN;

  /**
   * @param initialCapacity Number of entries to preallocate.
   */
  constructor(initialCapacity = INITIAL_HEAP_CAPACITY) {
    const capacity = Math.max(1, initialCapacity);
    this.keys = new Float64Array(capacity);
    this.nodes = new Int32Array(capacity);
  }

  /**
   * @returns The number of entries currently stored.
   */
  get size(): number {
    return this.count;
  }

  /**
   * @returns The key associated with the most recently popped node.
   */
  get lastKey(): number {
    return this.mostRecentKey;
  }

  /**
   * @param node Dense graph node identifier.
   * @param key Finite priority key.
   * @returns Nothing.
   */
  push(node: number, key: number): void {
    if (!Number.isFinite(key)) {
      throw new Error("binary heap key must be finite");
    }
    this.ensureCapacity();
    let index = this.count;
    this.count += 1;
    while (index > 0) {
      const parentIndex = Math.floor((index - 1) / 2);
      const parentKey = this.keys[parentIndex];
      const parentNode = this.nodes[parentIndex];
      if (!hasHigherPriority(key, node, parentKey, parentNode)) {
        break;
      }
      this.keys[index] = parentKey;
      this.nodes[index] = parentNode;
      index = parentIndex;
    }
    this.keys[index] = key;
    this.nodes[index] = node;
  }

  /**
   * @returns The next dense graph node identifier, or -1 when empty.
   */
  pop(): number {
    if (this.count === 0) {
      this.mostRecentKey = Number.NaN;
      return -1;
    }
    const node = this.nodes[0];
    this.mostRecentKey = this.keys[0];
    this.count -= 1;
    if (this.count === 0) {
      return node;
    }
    const tailKey = this.keys[this.count];
    const tailNode = this.nodes[this.count];
    let index = 0;
    while (true) {
      const leftChild = index * 2 + 1;
      if (leftChild >= this.count) {
        break;
      }
      const rightChild = leftChild + 1;
      const childIndex =
        rightChild < this.count &&
        hasHigherPriority(
          this.keys[rightChild],
          this.nodes[rightChild],
          this.keys[leftChild],
          this.nodes[leftChild],
        )
          ? rightChild
          : leftChild;
      if (
        hasHigherPriority(
          tailKey,
          tailNode,
          this.keys[childIndex],
          this.nodes[childIndex],
        )
      ) {
        break;
      }
      this.keys[index] = this.keys[childIndex];
      this.nodes[index] = this.nodes[childIndex];
      index = childIndex;
    }
    this.keys[index] = tailKey;
    this.nodes[index] = tailNode;
    return node;
  }

  /**
   * @returns Nothing.
   */
  private ensureCapacity(): void {
    if (this.count < this.keys.length) {
      return;
    }
    const nextKeys = new Float64Array(this.keys.length * 2);
    const nextNodes = new Int32Array(this.nodes.length * 2);
    nextKeys.set(this.keys);
    nextNodes.set(this.nodes);
    this.keys = nextKeys;
    this.nodes = nextNodes;
  }
}

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
 * @param node Dense graph node identifier.
 * @returns The station-radius correction in metres.
 */
function stationRadiusOf(graph: PedGraph, node: number): number {
  const stationId = graph.nodeStationId[node];
  if (stationId === -1) {
    return 0;
  }
  const radius = graph.stationRadiusM[stationId];
  return Number.isFinite(radius) ? radius : 0;
}

/**
 * @param graph CSR pedestrian graph.
 * @param node Dense graph node identifier.
 * @param goal Dense graph goal node identifier.
 * @returns An admissible straight-line lower bound in weighted metres.
 */
export function heuristicCost(
  graph: PedGraph,
  node: number,
  goal: number,
): number {
  if (!isValidNode(graph, node) || !isValidNode(graph, goal)) {
    return 0;
  }
  const distanceM = haversineMeters(
    graph.nodeLat[node],
    graph.nodeLon[node],
    graph.nodeLat[goal],
    graph.nodeLon[goal],
  );
  if (!Number.isFinite(distanceM)) {
    return 0;
  }
  return Math.max(0, distanceM - stationRadiusOf(graph, node));
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
export function aStar(
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
  open.push(from, heuristicCost(graph, from, to));
  let expandedNodes = 0;
  let reopenedNodes = 0;

  while (open.size > 0) {
    const node = open.pop();
    const priority = open.lastKey;
    if (node === -1) {
      break;
    }
    const expectedPriority = gScore[node] + heuristicCost(graph, node, to);
    if (priority !== expectedPriority || closed[node] !== 0) {
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
      const priorityKey = tentativeCost + heuristicCost(graph, target, to);
      if (!Number.isFinite(priorityKey)) {
        continue;
      }
      open.push(target, priorityKey);
    }
  }
  return null;
}
