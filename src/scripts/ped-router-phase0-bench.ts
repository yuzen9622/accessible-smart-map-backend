import fs from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { Pool } from "pg";
import {
  BinaryMinHeap,
  aStar,
  type RouteResult,
} from "../modules/accessible-route/planners/pedestrian-a11y/astar";
import {
  WHEELCHAIR_MAX_RELAXATION_LEVEL,
  WHEELCHAIR_WALK_SPEED_MPS,
  edgeCost,
  type CostProfile,
} from "../modules/accessible-route/planners/pedestrian-a11y/cost";
import { loadPedGraph } from "../modules/accessible-route/planners/pedestrian-a11y/graph-loader";
import {
  EDGE_FLAG,
  EDGE_TYPE,
  NODE_FLAG,
  type PedGraph,
} from "../modules/accessible-route/planners/pedestrian-a11y/graph.types";
import {
  buildEdgeIndex,
  snapToGraph,
  type EdgeIndex,
  type SnapResult,
} from "../modules/accessible-route/planners/pedestrian-a11y/spatial-index";
import {
  canTraverseFareGate,
  FORBID_FARE_ACCESS,
} from "../modules/accessible-route/planners/pedestrian-a11y/fare-access";
import { resolvePlannedPathSteps } from "./ped-router-planned-path";
import { haversineMeters } from "../utils/geo";

const DEFAULT_OUTPUT_PATH = "/tmp/ped-phase0-bench.json";
const DEFAULT_SAMPLE_COUNT = 120;
const DEFAULT_SEED = 20_260_825;
const MIN_RETAINED_LATENCY_SAMPLES = 100;
const WARMUP_COUNT = 10;
const SNAP_TOLERANCE_M = 50;
const MIN_SNAP_SAMPLES = 200;
const CONNECTIVITY_SAMPLE_COUNT = 100;
const MIN_OD_DISTANCE_M = 300;
const MAX_OD_DISTANCE_M = 3_000;
const SIX_CITY_SCALE = 4.1;
const HOT_RELOAD_MULTIPLIER = 2;
const MAX_PAIR_ATTEMPTS = 10_000;
const MAX_INDOOR_ROUTE_ATTEMPTS = 1_000;
const MAX_ANCHOR_EXPANSIONS = 10_000;
const UNREACHABLE_PROBE_COUNT = 100;
const SEED_CONNECTIVITY = 0x22f8_3a71;
const SEED_SNAP = 0x77c5_10d3;
const SEED_LATENCY = 0x4d9b_067f;
const SEED_UNREACHABLE = 0x1a2e_8c45;
const SEED_DECISION = 0x5f31_9d0b;
const SEED_INDOOR = 0x6e84_bac1;

type Coordinate = [number, number];
type JsonRecord = Record<string, unknown>;
type EdgeValue = (attrIdx: number) => number;

interface BenchmarkOptions {
  databaseUrl: string;
  outputPath: string;
  samples: number;
  seed: number;
}

interface NumberSummary {
  count: number;
  min: number | null;
  p50: number | null;
  p95: number | null;
  p99: number | null;
  max: number | null;
}

interface NodePair {
  from: number;
  to: number;
}

interface EdgeTopology {
  from: Int32Array;
  to: Int32Array;
}

interface PathStep {
  from: number;
  to: number;
  attrIdx: number;
  value: number;
}

interface PlannedRoute {
  pair: NodePair;
  profile: CostProfile;
  result: RouteResult;
  steps: PathStep[];
}

interface MeasuredRoute extends PlannedRoute {
  milliseconds: number;
}

interface ReverseEdges {
  offset: Int32Array;
  source: Int32Array;
}

interface ComponentData {
  parent: Int32Array;
  primaryComponent: number[];
}

interface BetweenPairSampling {
  fromNodes: number[];
  toNodes: number[];
  random: () => number;
  count: number;
}

interface SearchWorkspace {
  visited: Int32Array;
  queue: Int32Array;
  mark: number;
}

interface DbGeometryRow {
  attr_idx: number | string;
  from_node: string;
  to_node: string;
  geometry_json: string | null;
}

interface EdgeGeometry {
  coordinates: Coordinate[] | null;
}

interface ManualCandidate {
  inputPair: NodePair;
  route: PlannedRoute;
  startSnap: SnapResult;
  endSnap: SnapResult;
}

interface UnconstrainedRoute {
  nodePath: Int32Array;
  totalDistanceM: number;
}

interface RouteDistanceMetrics {
  actualGroundDistanceM: number;
  indoorTraversalDistanceEquivalentM: number;
  totalDistanceEquivalentM: number;
  hasIndoorEdge: boolean;
}

const edgeTypeNameByCode = new Map<number, string>(
  Object.entries(EDGE_TYPE).map(([name, code]) => [code, name]),
);

/**
 * @param value Candidate CLI numeric value.
 * @param label Argument label used in validation errors.
 * @returns A positive integer.
 */
function positiveInteger(value: string, label: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${label} must be a positive integer`);
  }
  return parsed;
}

/**
 * @param argv Command-line arguments excluding the executable and script path.
 * @returns Validated benchmark options.
 */
function parseOptions(argv: string[]): BenchmarkOptions {
  let databaseUrl = process.env.PED_GRAPH_DATABASE_URL;
  let outputPath = DEFAULT_OUTPUT_PATH;
  let samples = DEFAULT_SAMPLE_COUNT;
  let seed = DEFAULT_SEED;

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const value = argv[index + 1];
    if (argument === "--") continue;
    if (argument === "--db-url") {
      if (!value) throw new Error("--db-url requires a value");
      databaseUrl = value;
      index += 1;
      continue;
    }
    if (argument === "--out") {
      if (!value) throw new Error("--out requires a value");
      outputPath = value;
      index += 1;
      continue;
    }
    if (argument === "--samples") {
      if (!value) throw new Error("--samples requires a value");
      samples = positiveInteger(value, "--samples");
      index += 1;
      continue;
    }
    if (argument === "--seed") {
      if (!value) throw new Error("--seed requires a value");
      seed = positiveInteger(value, "--seed");
      index += 1;
      continue;
    }
    throw new Error(`unknown argument: ${argument}`);
  }

  if (!databaseUrl) {
    throw new Error("--db-url or PED_GRAPH_DATABASE_URL is required");
  }
  if (samples < MIN_RETAINED_LATENCY_SAMPLES) {
    throw new Error(
      `--samples must be at least ${MIN_RETAINED_LATENCY_SAMPLES} after warmup`,
    );
  }
  if (seed > 0xffff_ffff) {
    throw new Error("--seed must fit in an unsigned 32-bit integer");
  }

  return { databaseUrl, outputPath, samples, seed };
}

/**
 * @param seed Fixed unsigned seed.
 * @returns A deterministic pseudo-random number generator.
 */
function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state += 0x6d2b_79f5;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
}

/**
 * @param seed Base seed.
 * @param salt Stable stream-specific salt.
 * @returns A derived unsigned seed.
 */
function derivedSeed(seed: number, salt: number): number {
  return (seed ^ salt) >>> 0;
}

/**
 * @param values Numeric observations.
 * @param proportion Zero-to-one percentile proportion.
 * @returns The floor-index percentile, or null for no observations.
 */
function percentile(values: number[], proportion: number): number | null {
  if (values.length === 0) return null;
  const ordered = [...values].sort((left, right) => left - right);
  const index = Math.min(
    ordered.length - 1,
    Math.floor((ordered.length - 1) * proportion),
  );
  return ordered[index];
}

/**
 * @param values Numeric observations.
 * @returns Minimum, p50, p95, p99, and maximum values.
 */
function summarize(values: number[]): NumberSummary {
  if (values.length === 0) {
    return { count: 0, min: null, p50: null, p95: null, p99: null, max: null };
  }
  return {
    count: values.length,
    min: Math.min(...values),
    p50: percentile(values, 0.5),
    p95: percentile(values, 0.95),
    p99: percentile(values, 0.99),
    max: Math.max(...values),
  };
}

/**
 * @param numerator Observed count.
 * @param denominator Eligible count.
 * @returns Fraction and percentage, or null values for no denominator.
 */
function rate(
  numerator: number,
  denominator: number,
): {
  numerator: number;
  denominator: number;
  rate: number | null;
  percent: number | null;
} {
  const fraction = denominator === 0 ? null : numerator / denominator;
  return {
    numerator,
    denominator,
    rate: fraction,
    percent: fraction === null ? null : fraction * 100,
  };
}

/**
 * @param bytes Byte count.
 * @returns Binary-megabyte value using 1024 squared bytes.
 */
function megabytes(bytes: number): number {
  return bytes / (1024 * 1024);
}

/**
 * @returns Whether a forced garbage collector was available and invoked.
 */
function collectGarbage(): boolean {
  const runtime = global as typeof global & { gc?: () => void };
  if (typeof runtime.gc !== "function") return false;
  runtime.gc();
  return true;
}

/**
 * @param value Unknown JSON value.
 * @param label Context used in validation errors.
 * @returns A non-array JSON record.
 */
function requiredRecord(value: unknown, label: string): JsonRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as JsonRecord;
}

/**
 * @param value Unknown numeric database or JSON value.
 * @param label Context used in validation errors.
 * @returns A finite number.
 */
function requiredNumber(value: unknown, label: string): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`${label} must be a finite number`);
  }
  return parsed;
}

/**
 * @param graph Loaded CSR graph.
 * @returns A wheelchair profile for the requested relaxation level.
 */
function wheelchairProfile(relaxationLevel: number): CostProfile {
  return {
    name: "wheelchair",
    walkSpeedMps: WHEELCHAIR_WALK_SPEED_MPS,
    relaxationLevel,
  };
}

/**
 * @param code Edge type code.
 * @returns The graph dictionary name for the code.
 */
function edgeTypeName(code: number): string {
  const name = edgeTypeNameByCode.get(code);
  if (name === undefined) {
    throw new Error(`unknown edge_type code: ${code}`);
  }
  return name;
}

/**
 * @param graph Loaded CSR graph.
 * @returns Exact byte counts for every typed-array graph field.
 */
function typedArrayFootprint(graph: PedGraph): {
  bytes: number;
  bytesByField: Record<string, number>;
} {
  const bytesByField: Record<string, number> = {};
  for (const [field, value] of Object.entries(graph)) {
    if (!ArrayBuffer.isView(value)) continue;
    bytesByField[field] = value.byteLength;
  }
  const bytes = Object.values(bytesByField).reduce(
    (total, fieldBytes) => total + fieldBytes,
    0,
  );
  return { bytes, bytesByField };
}

/**
 * @param graph Loaded CSR graph.
 * @returns Full edge-type distribution keyed by graph dictionary names.
 */
function edgeTypeDistribution(
  graph: PedGraph,
): Record<string, { code: number; count: number }> {
  const counts = new Map<number, number>();
  for (const code of graph.edgeType) {
    counts.set(code, (counts.get(code) ?? 0) + 1);
  }
  const distribution: Record<string, { code: number; count: number }> = {};
  for (const [name, code] of Object.entries(EDGE_TYPE)) {
    distribution[name] = { code, count: counts.get(code) ?? 0 };
  }
  for (const code of counts.keys()) {
    edgeTypeName(code);
  }
  return distribution;
}

/**
 * @param graph Loaded CSR graph.
 * @returns Dense node identifiers that have physical geometry.
 */
function physicalNodeIds(graph: PedGraph): number[] {
  const nodes: number[] = [];
  for (let node = 0; node < graph.nodeCount; node += 1) {
    if ((graph.nodeFlags[node] & NODE_FLAG.HAS_REAL_GEOM) !== 0) {
      nodes.push(node);
    }
  }
  return nodes;
}

/**
 * @param graph Loaded CSR graph.
 * @param pair Candidate route endpoints.
 * @returns Great-circle separation in metres.
 */
function pairDistanceM(graph: PedGraph, pair: NodePair): number {
  return haversineMeters(
    graph.nodeLat[pair.from],
    graph.nodeLon[pair.from],
    graph.nodeLat[pair.to],
    graph.nodeLon[pair.to],
  );
}

/**
 * @param graph Loaded CSR graph.
 * @param nodes Candidate dense node identifiers.
 * @param random Deterministic random generator.
 * @param count Requested pair count.
 * @returns Pairs separated by the configured spatial range.
 */
function samplePairs(
  graph: PedGraph,
  nodes: number[],
  random: () => number,
  count: number,
): NodePair[] {
  if (nodes.length < 2) {
    throw new Error("fewer than two physical graph nodes are available");
  }
  const pairs: NodePair[] = [];
  const seen = new Set<number>();
  while (pairs.length < count) {
    let selected: NodePair | undefined;
    for (let attempt = 0; attempt < MAX_PAIR_ATTEMPTS; attempt += 1) {
      const from = nodes[Math.floor(random() * nodes.length)];
      const to = nodes[Math.floor(random() * nodes.length)];
      if (from === to) continue;
      const pair = { from, to };
      const key = from * graph.nodeCount + to;
      if (seen.has(key)) continue;
      const distanceM = pairDistanceM(graph, pair);
      if (distanceM < MIN_OD_DISTANCE_M || distanceM > MAX_OD_DISTANCE_M) {
        continue;
      }
      selected = pair;
      seen.add(key);
      break;
    }
    if (selected === undefined) {
      throw new Error(
        "unable to sample a node pair in the configured distance range",
      );
    }
    pairs.push(selected);
  }
  return pairs;
}

/**
 * @param graph Loaded CSR graph.
 * @param from Start node.
 * @param to Goal node.
 * @param visited Reusable visit-mark array.
 * @param queue Reusable BFS queue.
 * @param mark Current visit mark.
 * @returns Whether a directed structural path exists.
 */
function structuralReachable(
  graph: PedGraph,
  from: number,
  to: number,
  visited: Int32Array,
  queue: Int32Array,
  mark: number,
): boolean {
  let head = 0;
  let tail = 0;
  visited[from] = mark;
  queue[tail] = from;
  tail += 1;
  while (head < tail) {
    const node = queue[head];
    head += 1;
    if (node === to) return true;
    for (
      let adjacencyIndex = graph.adjOffset[node];
      adjacencyIndex < graph.adjOffset[node + 1];
      adjacencyIndex += 1
    ) {
      const target = graph.adjTarget[adjacencyIndex];
      if (visited[target] === mark) continue;
      visited[target] = mark;
      queue[tail] = target;
      tail += 1;
    }
  }
  return false;
}

/**
 * @param graph Loaded CSR graph.
 * @param nodes Physical-node candidates.
 * @param seed Base deterministic seed.
 * @returns A directed structural connectivity sample summary.
 */
function connectivitySample(
  graph: PedGraph,
  nodes: number[],
  seed: number,
): {
  requested: number;
  sampled: number;
  reachable: number;
  unreachable: number;
  rate: number | null;
  percent: number | null;
  distanceRangeM: { min: number; max: number };
  seed: number;
} {
  const random = seededRandom(seed);
  const pairs = samplePairs(graph, nodes, random, CONNECTIVITY_SAMPLE_COUNT);
  const visited = new Int32Array(graph.nodeCount);
  const queue = new Int32Array(graph.nodeCount);
  let reachable = 0;
  for (let index = 0; index < pairs.length; index += 1) {
    if (
      structuralReachable(
        graph,
        pairs[index].from,
        pairs[index].to,
        visited,
        queue,
        index + 1,
      )
    ) {
      reachable += 1;
    }
  }
  const summary = rate(reachable, pairs.length);
  return {
    requested: CONNECTIVITY_SAMPLE_COUNT,
    sampled: pairs.length,
    reachable,
    unreachable: pairs.length - reachable,
    rate: summary.rate,
    percent: summary.percent,
    distanceRangeM: { min: MIN_OD_DISTANCE_M, max: MAX_OD_DISTANCE_M },
    seed,
  };
}

/**
 * @param graph Loaded CSR graph.
 * @returns A finite-edge marker for strict wheelchair routing.
 */
function strictFeasibility(
  graph: PedGraph,
  topology: EdgeTopology,
): Uint8Array {
  const feasible = new Uint8Array(graph.directedEdgeCount);
  const profile = wheelchairProfile(0);
  for (let attrIdx = 0; attrIdx < graph.directedEdgeCount; attrIdx += 1) {
    feasible[attrIdx] =
      canTraverseFareGate(
        graph,
        topology.from[attrIdx],
        topology.to[attrIdx],
        attrIdx,
        FORBID_FARE_ACCESS,
      ) &&
      Number.isFinite(
        edgeCost(
          graph,
          attrIdx,
          profile,
          topology.from[attrIdx],
          topology.to[attrIdx],
        ),
      )
        ? 1
        : 0;
  }
  return feasible;
}

/**
 * @param graph Loaded CSR graph.
 * @returns Attribute-indexed edge endpoints.
 */
function buildEdgeTopology(graph: PedGraph): EdgeTopology {
  const from = new Int32Array(graph.directedEdgeCount);
  const to = new Int32Array(graph.directedEdgeCount);
  from.fill(-1);
  to.fill(-1);
  for (let node = 0; node < graph.nodeCount; node += 1) {
    for (
      let adjacencyIndex = graph.adjOffset[node];
      adjacencyIndex < graph.adjOffset[node + 1];
      adjacencyIndex += 1
    ) {
      const attrIdx = graph.adjAttr[adjacencyIndex];
      if (from[attrIdx] !== -1) {
        throw new Error(`edge attribute ${attrIdx} appears more than once`);
      }
      from[attrIdx] = node;
      to[attrIdx] = graph.adjTarget[adjacencyIndex];
    }
  }
  for (let attrIdx = 0; attrIdx < from.length; attrIdx += 1) {
    if (from[attrIdx] === -1 || to[attrIdx] === -1) {
      throw new Error(`edge attribute ${attrIdx} is absent from CSR adjacency`);
    }
  }
  return { from, to };
}

/**
 * @param parent Union-find parent array.
 * @param node Node whose representative is requested.
 * @returns The representative node after path compression.
 */
function findRoot(parent: Int32Array, node: number): number {
  let root = node;
  while (parent[root] !== root) {
    root = parent[root];
  }
  let current = node;
  while (parent[current] !== current) {
    const next = parent[current];
    parent[current] = root;
    current = next;
  }
  return root;
}

/**
 * @param parent Union-find parent array.
 * @param sizes Component sizes.
 * @param left First node.
 * @param right Second node.
 * @returns Nothing.
 */
function unionNodes(
  parent: Int32Array,
  sizes: Int32Array,
  left: number,
  right: number,
): void {
  let leftRoot = findRoot(parent, left);
  let rightRoot = findRoot(parent, right);
  if (leftRoot === rightRoot) return;
  if (sizes[leftRoot] < sizes[rightRoot]) {
    [leftRoot, rightRoot] = [rightRoot, leftRoot];
  }
  parent[rightRoot] = leftRoot;
  sizes[leftRoot] += sizes[rightRoot];
}

/**
 * @param graph Loaded CSR graph.
 * @param topology Attribute-indexed edge endpoints.
 * @param feasible Strict-wheelchair feasibility marker.
 * @returns Physical node components linked by finite reciprocal edges.
 */
function buildBidirectionalComponents(
  graph: PedGraph,
  topology: EdgeTopology,
  feasible: Uint8Array,
): ComponentData {
  const parent = new Int32Array(graph.nodeCount);
  const sizes = new Int32Array(graph.nodeCount);
  for (let node = 0; node < graph.nodeCount; node += 1) {
    parent[node] = node;
    sizes[node] = 1;
  }
  const edgeKeys = new Set<number>();
  for (let attrIdx = 0; attrIdx < feasible.length; attrIdx += 1) {
    if (feasible[attrIdx] === 0) continue;
    edgeKeys.add(
      topology.from[attrIdx] * graph.nodeCount + topology.to[attrIdx],
    );
  }
  for (let attrIdx = 0; attrIdx < feasible.length; attrIdx += 1) {
    if (feasible[attrIdx] === 0) continue;
    const from = topology.from[attrIdx];
    const to = topology.to[attrIdx];
    if (edgeKeys.has(to * graph.nodeCount + from)) {
      unionNodes(parent, sizes, from, to);
    }
  }
  const byRoot = new Map<number, number[]>();
  for (const node of physicalNodeIds(graph)) {
    const root = findRoot(parent, node);
    const component = byRoot.get(root);
    if (component === undefined) {
      byRoot.set(root, [node]);
    } else {
      component.push(node);
    }
  }
  const components = [...byRoot.values()].sort(
    (left, right) => right.length - left.length || left[0] - right[0],
  );
  const primaryComponent = components[0];
  if (primaryComponent === undefined || primaryComponent.length < 2) {
    throw new Error(
      "no strict-wheelchair reciprocal component has two physical nodes",
    );
  }
  return { parent, primaryComponent };
}

/**
 * @param graph Loaded CSR graph.
 * @param topology Attribute-indexed edge endpoints.
 * @param feasible Strict-wheelchair feasibility marker.
 * @returns Reverse adjacency for finite strict-wheelchair edges.
 */
function buildReverseEdges(
  graph: PedGraph,
  topology: EdgeTopology,
  feasible: Uint8Array,
): ReverseEdges {
  const degree = new Int32Array(graph.nodeCount);
  let count = 0;
  for (let attrIdx = 0; attrIdx < feasible.length; attrIdx += 1) {
    if (feasible[attrIdx] === 0) continue;
    degree[topology.to[attrIdx]] += 1;
    count += 1;
  }
  const offset = new Int32Array(graph.nodeCount + 1);
  for (let node = 0; node < graph.nodeCount; node += 1) {
    offset[node + 1] = offset[node] + degree[node];
  }
  const source = new Int32Array(count);
  const writeOffset = new Int32Array(graph.nodeCount);
  writeOffset.set(offset.subarray(0, graph.nodeCount));
  for (let attrIdx = 0; attrIdx < feasible.length; attrIdx += 1) {
    if (feasible[attrIdx] === 0) continue;
    const target = topology.to[attrIdx];
    source[writeOffset[target]] = topology.from[attrIdx];
    writeOffset[target] += 1;
  }
  return { offset, source };
}

/**
 * @param graph Loaded CSR graph.
 * @returns A reusable breadth-first-search workspace.
 */
function createSearchWorkspace(graph: PedGraph): SearchWorkspace {
  return {
    visited: new Int32Array(graph.nodeCount),
    queue: new Int32Array(graph.nodeCount),
    mark: 0,
  };
}

/**
 * @param graph Loaded CSR graph.
 * @param start Search starting node.
 * @param feasible Strict-wheelchair feasibility marker.
 * @param reverse Reverse strict-wheelchair adjacency.
 * @param workspace Reusable search workspace.
 * @param direction Search direction.
 * @returns A physically located reachable anchor, or null.
 */
function findPhysicalAnchor(
  graph: PedGraph,
  start: number,
  feasible: Uint8Array,
  reverse: ReverseEdges,
  workspace: SearchWorkspace,
  direction: "forward" | "reverse",
): number | null {
  if (workspace.mark >= 2_147_483_646) {
    workspace.visited.fill(0);
    workspace.mark = 0;
  }
  workspace.mark += 1;
  const mark = workspace.mark;
  let head = 0;
  let tail = 0;
  workspace.visited[start] = mark;
  workspace.queue[tail] = start;
  tail += 1;
  let expanded = 0;
  while (head < tail && expanded < MAX_ANCHOR_EXPANSIONS) {
    const node = workspace.queue[head];
    head += 1;
    expanded += 1;
    if ((graph.nodeFlags[node] & NODE_FLAG.HAS_REAL_GEOM) !== 0) {
      return node;
    }
    if (direction === "forward") {
      for (
        let adjacencyIndex = graph.adjOffset[node];
        adjacencyIndex < graph.adjOffset[node + 1];
        adjacencyIndex += 1
      ) {
        const attrIdx = graph.adjAttr[adjacencyIndex];
        if (feasible[attrIdx] === 0) continue;
        const target = graph.adjTarget[adjacencyIndex];
        if (workspace.visited[target] === mark) continue;
        workspace.visited[target] = mark;
        workspace.queue[tail] = target;
        tail += 1;
      }
    } else {
      for (
        let reverseIndex = reverse.offset[node];
        reverseIndex < reverse.offset[node + 1];
        reverseIndex += 1
      ) {
        const source = reverse.source[reverseIndex];
        if (workspace.visited[source] === mark) continue;
        workspace.visited[source] = mark;
        workspace.queue[tail] = source;
        tail += 1;
      }
    }
  }
  return null;
}

/**
 * @param graph Loaded CSR graph.
 * @param nodePath Unconstrained node sequence.
 * @param edgeValue Unconstrained edge value function.
 * @returns Ordered unfiltered adjacency edges for the node sequence.
 */
function resolveUnconstrainedPathSteps(
  graph: PedGraph,
  nodePath: Int32Array,
  edgeValue: EdgeValue,
): PathStep[] {
  const steps: PathStep[] = [];
  for (let index = 0; index < nodePath.length - 1; index += 1) {
    const from = nodePath[index];
    const to = nodePath[index + 1];
    let selectedAttrIdx = -1;
    let selectedValue = Number.POSITIVE_INFINITY;
    for (
      let adjacencyIndex = graph.adjOffset[from];
      adjacencyIndex < graph.adjOffset[from + 1];
      adjacencyIndex += 1
    ) {
      if (graph.adjTarget[adjacencyIndex] !== to) continue;
      const attrIdx = graph.adjAttr[adjacencyIndex];
      const value = edgeValue(attrIdx);
      if (!Number.isFinite(value) || value >= selectedValue) continue;
      selectedAttrIdx = attrIdx;
      selectedValue = value;
    }
    if (selectedAttrIdx === -1) {
      throw new Error(`route step ${from} -> ${to} has no finite edge`);
    }
    steps.push({ from, to, attrIdx: selectedAttrIdx, value: selectedValue });
  }
  return steps;
}

/**
 * @param actual Observed numeric value.
 * @param expected Reference numeric value.
 * @returns Relative error using one as the minimum scale.
 */
function relativeError(actual: number, expected: number): number {
  return Math.abs(actual - expected) / Math.max(1, Math.abs(expected));
}

/**
 * @param graph Loaded CSR graph.
 * @param pair Route endpoints.
 * @param profile Wheelchair profile used for planning.
 * @returns A planned route with resolved edge attributes, or null.
 */
function planWithProfile(
  graph: PedGraph,
  pair: NodePair,
  profile: CostProfile,
): PlannedRoute | null {
  const result = aStar(graph, pair.from, pair.to, profile);
  if (result === null) return null;
  const edgeValue = (attrIdx: number, from: number, to: number) =>
    edgeCost(graph, attrIdx, profile, from, to);
  const steps = resolvePlannedPathSteps(graph, result.nodePath, edgeValue);
  const resolvedTotalCost = steps.reduce(
    (total, step) => total + step.value,
    0,
  );
  if (relativeError(resolvedTotalCost, result.totalCost) > 1e-9) {
    throw new Error(
      "resolved route edges do not reproduce the CSR search total cost",
    );
  }
  return { pair, profile, result, steps };
}

/**
 * @param graph Loaded CSR graph.
 * @param pairs Guaranteed strict-wheelchair-reachable pairs.
 * @param retainedSamples Number of timing measurements retained after warmup.
 * @returns Warmup-free current `h=0` Dijkstra-equivalent core timing observations.
 */
function measureCoreLatency(
  graph: PedGraph,
  pairs: NodePair[],
  retainedSamples: number,
): MeasuredRoute[] {
  if (pairs.length !== retainedSamples + WARMUP_COUNT) {
    throw new Error(
      "latency pair count does not match warmup and retained sample counts",
    );
  }
  const profile = wheelchairProfile(0);
  for (let index = 0; index < WARMUP_COUNT; index += 1) {
    if (aStar(graph, pairs[index].from, pairs[index].to, profile) === null) {
      throw new Error(
        "a strict-wheelchair warmup OD was unexpectedly unreachable",
      );
    }
  }
  const measured: MeasuredRoute[] = [];
  for (let index = WARMUP_COUNT; index < pairs.length; index += 1) {
    const pair = pairs[index];
    const startedAt = performance.now();
    const result = aStar(graph, pair.from, pair.to, profile);
    const milliseconds = performance.now() - startedAt;
    if (result === null) {
      throw new Error(
        "a strict-wheelchair timing OD was unexpectedly unreachable",
      );
    }
    const edgeValue = (attrIdx: number, from: number, to: number) =>
      edgeCost(graph, attrIdx, profile, from, to);
    const steps = resolvePlannedPathSteps(graph, result.nodePath, edgeValue);
    measured.push({ pair, profile, result, steps, milliseconds });
  }
  return measured;
}

/**
 * @param graph Loaded CSR graph.
 * @param sampling Candidate node sets, random source, and requested count.
 * @returns Source-target pairs in the configured spatial range.
 */
function samplePairsBetween(
  graph: PedGraph,
  sampling: BetweenPairSampling,
): NodePair[] {
  const { fromNodes, toNodes, random, count } = sampling;
  if (fromNodes.length === 0 || toNodes.length === 0) {
    throw new Error("one of the requested OD node sets is empty");
  }
  const pairs: NodePair[] = [];
  const seen = new Set<number>();
  while (pairs.length < count) {
    let selected: NodePair | undefined;
    for (let attempt = 0; attempt < MAX_PAIR_ATTEMPTS; attempt += 1) {
      const from = fromNodes[Math.floor(random() * fromNodes.length)];
      const to = toNodes[Math.floor(random() * toNodes.length)];
      if (from === to) continue;
      const pair = { from, to };
      const key = from * graph.nodeCount + to;
      if (seen.has(key)) continue;
      const distanceM = pairDistanceM(graph, pair);
      if (distanceM < MIN_OD_DISTANCE_M || distanceM > MAX_OD_DISTANCE_M) {
        continue;
      }
      selected = pair;
      seen.add(key);
      break;
    }
    if (selected === undefined) {
      throw new Error(
        "unable to sample an OD in the configured distance range",
      );
    }
    pairs.push(selected);
  }
  return pairs;
}

/**
 * @param graph Loaded CSR graph.
 * @param candidates Candidate OD pairs selected across strict components.
 * @returns Measured latency distribution inputs for actual unreachable ODs.
 */
function measureUnreachableLatency(
  graph: PedGraph,
  candidates: NodePair[],
): {
  candidateCount: number;
  unreachableCount: number;
  reachableCount: number;
  milliseconds: number[];
} {
  const profile = wheelchairProfile(0);
  const milliseconds: number[] = [];
  let reachableCount = 0;
  for (const pair of candidates) {
    const startedAt = performance.now();
    const result = aStar(graph, pair.from, pair.to, profile);
    const elapsed = performance.now() - startedAt;
    if (result === null) {
      milliseconds.push(elapsed);
      continue;
    }
    reachableCount += 1;
  }
  return {
    candidateCount: candidates.length,
    unreachableCount: milliseconds.length,
    reachableCount,
    milliseconds,
  };
}

/**
 * @param graph Loaded CSR graph.
 * @param attrIdx Edge attribute index.
 * @returns Unconstrained distance in metres, or infinity when the base is invalid.
 */
function unconstrainedEdgeDistanceM(graph: PedGraph, attrIdx: number): number {
  const indoor = (graph.edgeFlags[attrIdx] & EDGE_FLAG.INDOOR) !== 0;
  const value = indoor
    ? graph.edgeTraversalTimeS[attrIdx] * WHEELCHAIR_WALK_SPEED_MPS
    : graph.edgeLengthM[attrIdx];
  return Number.isFinite(value) && value >= 0
    ? value
    : Number.POSITIVE_INFINITY;
}

/**
 * @param parent Parent pointers indexed by dense node.
 * @param from Route source node.
 * @param to Route target node.
 * @returns A forward node path.
 */
function reconstructNodePath(
  parent: Int32Array,
  from: number,
  to: number,
): Int32Array {
  const reversePath: number[] = [];
  let current = to;
  while (current !== from) {
    reversePath.push(current);
    current = parent[current];
    if (current === -1 || reversePath.length > parent.length) {
      throw new Error("route parent chain is incomplete");
    }
  }
  reversePath.push(from);
  reversePath.reverse();
  return Int32Array.from(reversePath);
}

/**
 * @param graph Loaded CSR graph.
 * @param pair Route endpoints.
 * @returns A pure-distance shortest route without wheelchair penalties or infeasibility.
 */
function unconstrainedDijkstra(
  graph: PedGraph,
  pair: NodePair,
): UnconstrainedRoute | null {
  if (pair.from === pair.to) {
    return { nodePath: Int32Array.of(pair.from), totalDistanceM: 0 };
  }
  const distance = new Float64Array(graph.nodeCount);
  distance.fill(Number.POSITIVE_INFINITY);
  const parent = new Int32Array(graph.nodeCount);
  parent.fill(-1);
  const closed = new Uint8Array(graph.nodeCount);
  const open = new BinaryMinHeap();
  distance[pair.from] = 0;
  open.push(pair.from, 0);
  while (open.size > 0) {
    const node = open.pop();
    const priority = open.lastKey;
    if (node === -1) break;
    if (priority !== distance[node] || closed[node] !== 0) continue;
    closed[node] = 1;
    if (node === pair.to) {
      return {
        nodePath: reconstructNodePath(parent, pair.from, pair.to),
        totalDistanceM: distance[pair.to],
      };
    }
    for (
      let adjacencyIndex = graph.adjOffset[node];
      adjacencyIndex < graph.adjOffset[node + 1];
      adjacencyIndex += 1
    ) {
      const attrIdx = graph.adjAttr[adjacencyIndex];
      const edgeDistanceM = unconstrainedEdgeDistanceM(graph, attrIdx);
      if (!Number.isFinite(edgeDistanceM)) continue;
      const target = graph.adjTarget[adjacencyIndex];
      const tentativeDistance = distance[node] + edgeDistanceM;
      if (tentativeDistance >= distance[target]) continue;
      distance[target] = tentativeDistance;
      parent[target] = node;
      open.push(target, tentativeDistance);
    }
  }
  return null;
}

/**
 * @param graph Loaded CSR graph.
 * @param steps Resolved route edges.
 * @returns Physical and indoor distance totals for the route.
 */
function routeDistanceMetrics(
  graph: PedGraph,
  steps: PathStep[],
): RouteDistanceMetrics {
  let actualGroundDistanceM = 0;
  let indoorTraversalDistanceEquivalentM = 0;
  let hasIndoorEdge = false;
  for (const step of steps) {
    const indoor = (graph.edgeFlags[step.attrIdx] & EDGE_FLAG.INDOOR) !== 0;
    if (indoor) {
      const distanceEquivalentM = unconstrainedEdgeDistanceM(
        graph,
        step.attrIdx,
      );
      if (!Number.isFinite(distanceEquivalentM)) {
        throw new Error(
          "indoor route edge lacks a traversal distance equivalent",
        );
      }
      indoorTraversalDistanceEquivalentM += distanceEquivalentM;
      hasIndoorEdge = true;
      continue;
    }
    const lengthM = graph.edgeLengthM[step.attrIdx];
    if (!Number.isFinite(lengthM)) {
      throw new Error("outdoor route edge lacks physical length");
    }
    actualGroundDistanceM += lengthM;
  }
  return {
    actualGroundDistanceM,
    indoorTraversalDistanceEquivalentM,
    totalDistanceEquivalentM:
      actualGroundDistanceM + indoorTraversalDistanceEquivalentM,
    hasIndoorEdge,
  };
}

/**
 * @param graph Loaded CSR graph.
 * @param pairs Evaluation OD pairs.
 * @returns First-feasible wheelchair route records across relaxation levels.
 */
function evaluateDecisionRoutes(
  graph: PedGraph,
  pairs: NodePair[],
): {
  routes: PlannedRoute[];
  unrouteableCount: number;
  inspectedEdgeCount: number;
  strictViolationEdgeCount: number;
  silentViolationRouteCount: number;
  markedViolationRouteCount: number;
  detourRatios: number[];
  detourExcludedIndoorCount: number;
  detourExcludedZeroDistanceCount: number;
} {
  const routes: PlannedRoute[] = [];
  let unrouteableCount = 0;
  let inspectedEdgeCount = 0;
  let strictViolationEdgeCount = 0;
  let silentViolationRouteCount = 0;
  let markedViolationRouteCount = 0;
  const detourRatios: number[] = [];
  let detourExcludedIndoorCount = 0;
  let detourExcludedZeroDistanceCount = 0;
  const strictProfile = wheelchairProfile(0);

  for (const pair of pairs) {
    let planned: PlannedRoute | null = null;
    for (
      let relaxationLevel = 0;
      relaxationLevel <= WHEELCHAIR_MAX_RELAXATION_LEVEL;
      relaxationLevel += 1
    ) {
      planned = planWithProfile(
        graph,
        pair,
        wheelchairProfile(relaxationLevel),
      );
      if (planned !== null) break;
    }
    if (planned === null) {
      unrouteableCount += 1;
      continue;
    }
    routes.push(planned);
    const strictViolations = planned.steps.filter(
      (step) =>
        !Number.isFinite(
          edgeCost(graph, step.attrIdx, strictProfile, step.from, step.to),
        ),
    );
    const hasViolation = strictViolations.length > 0;
    const degradedProxy = planned.profile.relaxationLevel > 0;
    inspectedEdgeCount += planned.steps.length;
    strictViolationEdgeCount += strictViolations.length;
    if (hasViolation && !degradedProxy) silentViolationRouteCount += 1;
    if (hasViolation && degradedProxy) markedViolationRouteCount += 1;

    const unrestricted = unconstrainedDijkstra(graph, planned.pair);
    if (unrestricted === null) {
      throw new Error("a wheelchair route had no unconstrained shortest route");
    }
    const wheelchairMetrics = routeDistanceMetrics(graph, planned.steps);
    const unrestrictedSteps = resolveUnconstrainedPathSteps(
      graph,
      unrestricted.nodePath,
      (attrIdx) => unconstrainedEdgeDistanceM(graph, attrIdx),
    );
    const unrestrictedMetrics = routeDistanceMetrics(graph, unrestrictedSteps);
    if (wheelchairMetrics.hasIndoorEdge || unrestrictedMetrics.hasIndoorEdge) {
      detourExcludedIndoorCount += 1;
      continue;
    }
    if (unrestrictedMetrics.actualGroundDistanceM <= 0) {
      detourExcludedZeroDistanceCount += 1;
      continue;
    }
    detourRatios.push(
      wheelchairMetrics.actualGroundDistanceM /
        unrestrictedMetrics.actualGroundDistanceM,
    );
  }

  return {
    routes,
    unrouteableCount,
    inspectedEdgeCount,
    strictViolationEdgeCount,
    silentViolationRouteCount,
    markedViolationRouteCount,
    detourRatios,
    detourExcludedIndoorCount,
    detourExcludedZeroDistanceCount,
  };
}

/**
 * @param graph Loaded CSR graph.
 * @param index Physical edge index.
 * @param inputPair Input graph nodes used as exact-coordinate route requests.
 * @param profile Wheelchair profile used for planning after snapping.
 * @returns A snapped and planned route candidate, or null when no route exists.
 */
function prepareManualCandidate(
  graph: PedGraph,
  index: EdgeIndex,
  inputPair: NodePair,
  profile: CostProfile,
): ManualCandidate | null {
  const startSnap = snapToGraph(
    index,
    graph.nodeLat[inputPair.from],
    graph.nodeLon[inputPair.from],
    SNAP_TOLERANCE_M,
  );
  const endSnap = snapToGraph(
    index,
    graph.nodeLat[inputPair.to],
    graph.nodeLon[inputPair.to],
    SNAP_TOLERANCE_M,
  );
  if (startSnap === null || endSnap === null) {
    throw new Error(
      "an exact physical route endpoint did not snap within tolerance",
    );
  }
  const route = planWithProfile(
    graph,
    { from: startSnap.nodeId, to: endSnap.nodeId },
    profile,
  );
  if (route === null) return null;
  return { inputPair, route, startSnap, endSnap };
}

/**
 * @param graph Loaded CSR graph.
 * @param candidate Planned route candidate.
 * @returns Whether the route includes an indoor dictionary edge type.
 */
function routeUsesIndoorEdgeType(
  graph: PedGraph,
  candidate: PlannedRoute,
): boolean {
  return candidate.steps.some((step) =>
    edgeTypeName(graph.edgeType[step.attrIdx]).startsWith("INDOOR_"),
  );
}

/**
 * @param graph Loaded CSR graph.
 * @returns Deterministically ordered pairs of real station entrance nodes.
 */
function stationEntrancePairs(graph: PedGraph): NodePair[] {
  const entrancesByStation = new Map<number, number[]>();
  for (let node = 0; node < graph.nodeCount; node += 1) {
    if (
      graph.nodeStationId[node] < 0 ||
      (graph.nodeFlags[node] & NODE_FLAG.ENTRANCE) === 0 ||
      (graph.nodeFlags[node] & NODE_FLAG.HAS_REAL_GEOM) === 0
    ) {
      continue;
    }
    const station = graph.nodeStationId[node];
    const entrances = entrancesByStation.get(station);
    if (entrances === undefined) {
      entrancesByStation.set(station, [node]);
    } else {
      entrances.push(node);
    }
  }
  const pairs: NodePair[] = [];
  for (const entrances of entrancesByStation.values()) {
    for (let left = 0; left < entrances.length; left += 1) {
      for (let right = left + 1; right < entrances.length; right += 1) {
        pairs.push({ from: entrances[left], to: entrances[right] });
      }
    }
  }
  return pairs;
}

/**
 * @param graph Loaded CSR graph.
 * @returns Exterior physical-node pairs attached to the same station subgraph.
 */
function stationConnectorExteriorPairs(graph: PedGraph): NodePair[] {
  const exteriorNodesByStation = new Map<number, Set<number>>();
  const exterior = (node: number): boolean =>
    (graph.nodeFlags[node] & NODE_FLAG.HAS_REAL_GEOM) !== 0 &&
    (graph.nodeFlags[node] & NODE_FLAG.INDOOR) === 0;
  const addExteriorNode = (station: number, node: number): void => {
    const nodes = exteriorNodesByStation.get(station);
    if (nodes === undefined) {
      exteriorNodesByStation.set(station, new Set([node]));
    } else {
      nodes.add(node);
    }
  };
  for (let from = 0; from < graph.nodeCount; from += 1) {
    for (
      let adjacencyIndex = graph.adjOffset[from];
      adjacencyIndex < graph.adjOffset[from + 1];
      adjacencyIndex += 1
    ) {
      const to = graph.adjTarget[adjacencyIndex];
      if (graph.nodeStationId[from] >= 0 && exterior(to)) {
        addExteriorNode(graph.nodeStationId[from], to);
      }
      if (graph.nodeStationId[to] >= 0 && exterior(from)) {
        addExteriorNode(graph.nodeStationId[to], from);
      }
    }
  }
  const pairs: NodePair[] = [];
  for (const nodes of exteriorNodesByStation.values()) {
    const values = [...nodes];
    for (let left = 0; left < values.length; left += 1) {
      for (let right = left + 1; right < values.length; right += 1) {
        pairs.push({ from: values[left], to: values[right] });
      }
    }
  }
  return pairs;
}

/**
 * @param pairs Ordered node pairs.
 * @param random Deterministic random generator.
 * @returns A shuffled copy of the pairs.
 */
function shuffledPairs(pairs: NodePair[], random: () => number): NodePair[] {
  const shuffled = [...pairs];
  for (let index = shuffled.length - 1; index > 0; index -= 1) {
    const other = Math.floor(random() * (index + 1));
    [shuffled[index], shuffled[other]] = [shuffled[other], shuffled[index]];
  }
  return shuffled;
}

/**
 * @param graph Loaded CSR graph.
 * @param index Physical edge index.
 * @param topology Attribute-indexed edge endpoints.
 * @param feasible Strict-wheelchair feasibility marker.
 * @param reverse Reverse strict-wheelchair adjacency.
 * @param random Deterministic random generator.
 * @returns A snapped strict-wheelchair route that contains indoor edge types.
 */
function findIndoorManualCandidate(
  graph: PedGraph,
  index: EdgeIndex,
  topology: EdgeTopology,
  feasible: Uint8Array,
  reverse: ReverseEdges,
  random: () => number,
): ManualCandidate {
  const strictProfile = wheelchairProfile(0);
  const directCandidates = [
    ...shuffledPairs(stationConnectorExteriorPairs(graph), random),
    ...stationEntrancePairs(graph),
  ];
  for (const pair of directCandidates) {
    const candidate = prepareManualCandidate(graph, index, pair, strictProfile);
    if (candidate !== null && routeUsesIndoorEdgeType(graph, candidate.route)) {
      return candidate;
    }
  }
  const indoorAttrs: number[] = [];
  for (let attrIdx = 0; attrIdx < feasible.length; attrIdx += 1) {
    if (feasible[attrIdx] === 0) continue;
    if (edgeTypeName(graph.edgeType[attrIdx]).startsWith("INDOOR_")) {
      indoorAttrs.push(attrIdx);
    }
  }
  if (indoorAttrs.length === 0) {
    throw new Error("the graph has no strict-wheelchair-feasible indoor edges");
  }
  const workspace = createSearchWorkspace(graph);
  for (let attempt = 0; attempt < MAX_INDOOR_ROUTE_ATTEMPTS; attempt += 1) {
    const attrIdx = indoorAttrs[Math.floor(random() * indoorAttrs.length)];
    const start = findPhysicalAnchor(
      graph,
      topology.from[attrIdx],
      feasible,
      reverse,
      workspace,
      "reverse",
    );
    const end = findPhysicalAnchor(
      graph,
      topology.to[attrIdx],
      feasible,
      reverse,
      workspace,
      "forward",
    );
    if (start === null || end === null || start === end) continue;
    const candidate = prepareManualCandidate(
      graph,
      index,
      { from: start, to: end },
      strictProfile,
    );
    if (candidate !== null && routeUsesIndoorEdgeType(graph, candidate.route)) {
      return candidate;
    }
  }
  throw new Error(
    "unable to plan a strict-wheelchair route containing indoor edges",
  );
}

/**
 * @param pool PostgreSQL pool.
 * @param versionId Loaded graph version identifier.
 * @param samples Requested geometry-coordinate sample count.
 * @param random Deterministic random generator.
 * @returns Coordinates interpolated on real stored edge geometries.
 */
async function samplePhysicalEdgeCoordinates(
  pool: Pool,
  versionId: number,
  samples: number,
  random: () => number,
): Promise<Coordinate[]> {
  const idsResult = await pool.query<{ edge_id: string }>(
    `
      SELECT edge_id::text AS edge_id
      FROM ped_edge
      WHERE version_id = $1
        AND geom IS NOT NULL
        AND NOT ST_IsEmpty(geom)
        AND ST_NPoints(geom) >= 2
      ORDER BY edge_id
    `,
    [versionId],
  );
  if (idsResult.rows.length < samples) {
    throw new Error(
      "the graph has fewer physical edges than requested snap samples",
    );
  }
  const edgeIds: string[] = [];
  const fractions: number[] = [];
  const selectedIndexes = new Set<number>();
  while (edgeIds.length < samples) {
    const index = Math.floor(random() * idsResult.rows.length);
    if (selectedIndexes.has(index)) continue;
    selectedIndexes.add(index);
    edgeIds.push(idsResult.rows[index].edge_id);
    fractions.push(random());
  }
  const pointsResult = await pool.query<{
    sample_index: number | string;
    lon: number | string;
    lat: number | string;
  }>(
    `
      WITH requested AS (
        SELECT edge_id, fraction, ordinality::integer AS sample_index
        FROM unnest($2::bigint[], $3::double precision[]) WITH ORDINALITY
          AS input(edge_id, fraction, ordinality)
      )
      SELECT
        requested.sample_index,
        ST_X(ST_LineInterpolatePoint(ped_edge.geom, requested.fraction)) AS lon,
        ST_Y(ST_LineInterpolatePoint(ped_edge.geom, requested.fraction)) AS lat
      FROM requested
      JOIN ped_edge ON ped_edge.edge_id = requested.edge_id
      WHERE ped_edge.version_id = $1
      ORDER BY requested.sample_index
    `,
    [versionId, edgeIds, fractions],
  );
  if (pointsResult.rows.length !== samples) {
    throw new Error("not all requested physical edge samples were returned");
  }
  return pointsResult.rows.map((row) => [
    requiredNumber(row.lon, "sample longitude"),
    requiredNumber(row.lat, "sample latitude"),
  ]);
}

/**
 * @param pool PostgreSQL pool.
 * @param versionId Loaded graph version identifier.
 * @returns Attribute coverage counts from the source edge records.
 */
async function loadAttributeCoverage(
  pool: Pool,
  versionId: number,
): Promise<{
  total: number;
  slope: number;
  surface: number;
  smoothness: number;
  effectiveWidth: number;
  wheelchair: number;
  stairCount: number;
}> {
  const result = await pool.query<{
    total: number | string;
    slope: number | string;
    surface: number | string;
    smoothness: number | string;
    effective_width: number | string;
    wheelchair: number | string;
    stair_count: number | string;
  }>(
    `
      SELECT
        count(*)::integer AS total,
        count(*) FILTER (WHERE slope_longitudinal IS NOT NULL)::integer AS slope,
        count(*) FILTER (WHERE surface IS NOT NULL)::integer AS surface,
        count(*) FILTER (WHERE smoothness IS NOT NULL)::integer AS smoothness,
        count(*) FILTER (WHERE effective_width_m IS NOT NULL)::integer AS effective_width,
        count(*) FILTER (WHERE wheelchair IS NOT NULL)::integer AS wheelchair,
        count(*) FILTER (WHERE stair_count IS NOT NULL)::integer AS stair_count
      FROM ped_edge
      WHERE version_id = $1
    `,
    [versionId],
  );
  const row = result.rows[0];
  if (row === undefined)
    throw new Error("attribute coverage query returned no row");
  return {
    total: requiredNumber(row.total, "coverage total"),
    slope: requiredNumber(row.slope, "slope coverage"),
    surface: requiredNumber(row.surface, "surface coverage"),
    smoothness: requiredNumber(row.smoothness, "smoothness coverage"),
    effectiveWidth: requiredNumber(
      row.effective_width,
      "effective width coverage",
    ),
    wheelchair: requiredNumber(row.wheelchair, "wheelchair coverage"),
    stairCount: requiredNumber(row.stair_count, "stair count coverage"),
  };
}

/**
 * @param known Known-attribute count.
 * @param total Total edge count.
 * @returns A non-unknown attribute coverage record.
 */
function coverageMetric(
  known: number,
  total: number,
): {
  known: number;
  unknown: number;
  total: number;
  nonUnknownRate: number | null;
  nonUnknownPercent: number | null;
} {
  const summary = rate(known, total);
  return {
    known,
    unknown: total - known,
    total,
    nonUnknownRate: summary.rate,
    nonUnknownPercent: summary.percent,
  };
}

/**
 * @param pool PostgreSQL pool.
 * @param versionId Loaded graph version identifier.
 * @returns Parsed version notes.
 */
async function loadNotes(pool: Pool, versionId: number): Promise<JsonRecord> {
  const result = await pool.query<{ notes: string | null }>(
    "SELECT notes FROM ped_graph_version WHERE id = $1",
    [versionId],
  );
  const row = result.rows[0];
  if (row === undefined || row.notes === null) {
    throw new Error("ped_graph_version notes are missing");
  }
  try {
    return requiredRecord(JSON.parse(row.notes), "ped_graph_version notes");
  } catch (error) {
    throw new Error(
      `ped_graph_version notes are not valid JSON: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

/**
 * @param notes Parsed graph-version notes.
 * @returns Directly persisted entrance and station-radius measurements.
 */
function entranceMatchingMetrics(notes: JsonRecord): {
  source: string;
  taipeiPrimary50m: JsonRecord;
  nationalContext: JsonRecord;
  distanceDistributionM: JsonRecord;
  thresholdSuccessRates: JsonRecord;
  stationRadiusM: JsonRecord;
  stationScaleComparison: {
    lowerBoundM: number;
    upperBoundM: number;
    p50M: number;
    p95M: number;
    maxM: number;
    p50Within100To300M: boolean;
    p95AtMost300M: boolean;
    maxAtMost300M: boolean;
  };
} {
  const matching = requiredRecord(notes.entrance_matching, "entrance_matching");
  const stationRadius = requiredRecord(
    notes.station_radius_m,
    "station_radius_m",
  );
  const distribution = requiredRecord(
    stationRadius.distribution,
    "station_radius_m.distribution",
  );
  const p50M = requiredNumber(distribution.p50, "station radius p50");
  const p95M = requiredNumber(distribution.p95, "station radius p95");
  const maxM = requiredNumber(distribution.max, "station radius max");
  return {
    source: "ped_graph_version.notes",
    taipeiPrimary50m: requiredRecord(
      matching.primary_taipei_50m,
      "primary_taipei_50m",
    ),
    nationalContext: requiredRecord(
      matching.national_context,
      "national_context",
    ),
    distanceDistributionM: requiredRecord(
      matching.distance_distribution_m,
      "distance_distribution_m",
    ),
    thresholdSuccessRates: requiredRecord(
      matching.thresholds_m,
      "thresholds_m",
    ),
    stationRadiusM: distribution,
    stationScaleComparison: {
      lowerBoundM: 100,
      upperBoundM: 300,
      p50M,
      p95M,
      maxM,
      p50Within100To300M: p50M >= 100 && p50M <= 300,
      p95AtMost300M: p95M <= 300,
      maxAtMost300M: maxM <= 300,
    },
  };
}

/**
 * @param pool PostgreSQL pool.
 * @param graph Loaded CSR graph.
 * @param topology Attribute-indexed edge endpoints.
 * @param attrIds Route edge attribute identifiers.
 * @returns Exact database geometries matched to loader attribute ordering.
 */
async function loadRouteGeometries(
  pool: Pool,
  graph: PedGraph,
  topology: EdgeTopology,
  attrIds: number[],
): Promise<Map<number, EdgeGeometry>> {
  const uniqueAttrIds = [...new Set(attrIds)].sort(
    (left, right) => left - right,
  );
  const result = await pool.query<DbGeometryRow>(
    `
      WITH requested AS (
        SELECT DISTINCT requested_attr_idx::integer AS attr_idx
        FROM unnest($2::integer[]) AS values(requested_attr_idx)
      ),
      indexed_edges AS (
        SELECT
          (row_number() OVER (ORDER BY edge_id) - 1)::integer AS attr_idx,
          from_node::text AS from_node,
          to_node::text AS to_node,
          ST_AsGeoJSON(geom) AS geometry_json
        FROM ped_edge
        WHERE version_id = $1
      )
      SELECT
        indexed_edges.attr_idx,
        indexed_edges.from_node,
        indexed_edges.to_node,
        indexed_edges.geometry_json
      FROM requested
      JOIN indexed_edges USING (attr_idx)
      ORDER BY indexed_edges.attr_idx
    `,
    [graph.versionId, uniqueAttrIds],
  );
  if (result.rows.length !== uniqueAttrIds.length) {
    throw new Error(
      "not all manual-route edge attributes were found in PostGIS",
    );
  }
  const geometries = new Map<number, EdgeGeometry>();
  for (const row of result.rows) {
    const attrIdx = requiredNumber(row.attr_idx, "geometry attribute index");
    if (
      !Number.isInteger(attrIdx) ||
      attrIdx < 0 ||
      attrIdx >= graph.directedEdgeCount
    ) {
      throw new Error(
        "PostGIS geometry attribute index is outside the loaded graph",
      );
    }
    const expectedFrom =
      graph.originalNodeId[topology.from[attrIdx]].toString();
    const expectedTo = graph.originalNodeId[topology.to[attrIdx]].toString();
    if (row.from_node !== expectedFrom || row.to_node !== expectedTo) {
      throw new Error(
        "PostGIS edge ordering does not match the loaded CSR attributes",
      );
    }
    geometries.set(attrIdx, {
      coordinates: parseLineStringCoordinates(row.geometry_json),
    });
  }
  return geometries;
}

/**
 * @param geometryJson Nullable GeoJSON LineString text.
 * @returns Parsed LineString coordinates, or null for geometryless edges.
 */
function parseLineStringCoordinates(
  geometryJson: string | null,
): Coordinate[] | null {
  if (geometryJson === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(geometryJson);
  } catch {
    throw new Error("stored edge geometry is not valid GeoJSON");
  }
  const geometry = requiredRecord(parsed, "stored edge geometry");
  if (geometry.type !== "LineString" || !Array.isArray(geometry.coordinates)) {
    throw new Error("stored edge geometry is not a LineString");
  }
  const coordinates = geometry.coordinates.map((coordinate, index) => {
    if (!Array.isArray(coordinate) || coordinate.length < 2) {
      throw new Error(`LineString coordinate ${index} is invalid`);
    }
    const longitude = requiredNumber(coordinate[0], "LineString longitude");
    const latitude = requiredNumber(coordinate[1], "LineString latitude");
    return [longitude, latitude] as Coordinate;
  });
  if (coordinates.length < 2) {
    throw new Error("stored LineString has fewer than two coordinates");
  }
  return coordinates;
}

/**
 * @param left First longitude-latitude coordinate.
 * @param right Second longitude-latitude coordinate.
 * @returns Squared coordinate-space distance used only for endpoint orientation.
 */
function coordinateDistanceSquared(
  left: Coordinate,
  right: Coordinate,
): number {
  return (left[0] - right[0]) ** 2 + (left[1] - right[1]) ** 2;
}

/**
 * @param coordinates Edge coordinate sequence.
 * @param expectedFrom Route edge source coordinate.
 * @returns Coordinates oriented from the route source to its target.
 */
function orientCoordinates(
  coordinates: Coordinate[],
  expectedFrom: Coordinate,
): Coordinate[] {
  const startDistance = coordinateDistanceSquared(coordinates[0], expectedFrom);
  const endDistance = coordinateDistanceSquared(
    coordinates[coordinates.length - 1],
    expectedFrom,
  );
  return endDistance < startDistance ? [...coordinates].reverse() : coordinates;
}

/**
 * @param full Existing route coordinates.
 * @param segment Next oriented edge coordinates.
 * @returns Nothing.
 */
function appendCoordinates(full: Coordinate[], segment: Coordinate[]): void {
  if (full.length === 0) {
    full.push(...segment);
    return;
  }
  const last = full[full.length - 1];
  const first = segment[0];
  if (coordinateDistanceSquared(last, first) < 1e-18) {
    full.push(...segment.slice(1));
    return;
  }
  full.push(...segment);
}

/**
 * @param graph Loaded CSR graph.
 * @param steps Resolved route edges.
 * @param geometries Database edge geometries indexed by attribute identifier.
 * @returns Full route coordinate sequence and geometryless segment count.
 */
function routeCoordinates(
  graph: PedGraph,
  steps: PathStep[],
  geometries: Map<number, EdgeGeometry>,
): { coordinates: Coordinate[]; proxySegmentCount: number } {
  const coordinates: Coordinate[] = [];
  let proxySegmentCount = 0;
  for (const step of steps) {
    const source: Coordinate = [
      graph.nodeLon[step.from],
      graph.nodeLat[step.from],
    ];
    const target: Coordinate = [graph.nodeLon[step.to], graph.nodeLat[step.to]];
    const geometry = geometries.get(step.attrIdx);
    if (geometry === undefined) {
      throw new Error(
        `manual-route edge ${step.attrIdx} has no geometry record`,
      );
    }
    const segment =
      geometry.coordinates === null
        ? [source, target]
        : orientCoordinates(geometry.coordinates, source);
    if (geometry.coordinates === null) proxySegmentCount += 1;
    appendCoordinates(coordinates, segment);
  }
  return { coordinates, proxySegmentCount };
}

/**
 * @param graph Loaded CSR graph.
 * @param steps Resolved route edges.
 * @returns Ordered edge-type count summary.
 */
function edgeTypeSummary(
  graph: PedGraph,
  steps: PathStep[],
): Array<{ edgeType: string; count: number }> {
  const counts = new Map<string, number>();
  for (const step of steps) {
    const name = edgeTypeName(graph.edgeType[step.attrIdx]);
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  return [...counts.entries()].map(([edgeType, count]) => ({
    edgeType,
    count,
  }));
}

/**
 * @param graph Loaded CSR graph.
 * @param candidate Snapped planned manual route.
 * @param label Route label.
 * @param geometries Database edge geometries indexed by attribute identifier.
 * @returns JSON-serializable manual-route evidence.
 */
function serializeManualRoute(
  graph: PedGraph,
  candidate: ManualCandidate,
  label: string,
  geometries: Map<number, EdgeGeometry>,
): {
  label: string;
  coordinateOrder: string;
  start: {
    latitude: number;
    longitude: number;
    snapDistanceM: number;
    snappedNodeId: number;
    snappedOriginalNodeId: string;
  };
  end: {
    latitude: number;
    longitude: number;
    snapDistanceM: number;
    snappedNodeId: number;
    snappedOriginalNodeId: string;
  };
  nodeCount: number;
  totalCost: number;
  actualGroundDistanceM: number;
  indoorTraversalDistanceEquivalentM: number;
  totalDistanceEquivalentM: number;
  containsIndoorEdge: boolean;
  edgeTypeSequenceSummary: Array<{ edgeType: string; count: number }>;
  coordinates: Coordinate[];
  geoJsonLineString: string;
  proxyGeometrySegmentCount: number;
} {
  const metrics = routeDistanceMetrics(graph, candidate.route.steps);
  const sequence = routeCoordinates(graph, candidate.route.steps, geometries);
  const start = candidate.inputPair.from;
  const end = candidate.inputPair.to;
  return {
    label,
    coordinateOrder: "[longitude, latitude]",
    start: {
      latitude: graph.nodeLat[start],
      longitude: graph.nodeLon[start],
      snapDistanceM: candidate.startSnap.distanceM,
      snappedNodeId: candidate.startSnap.nodeId,
      snappedOriginalNodeId:
        graph.originalNodeId[candidate.startSnap.nodeId].toString(),
    },
    end: {
      latitude: graph.nodeLat[end],
      longitude: graph.nodeLon[end],
      snapDistanceM: candidate.endSnap.distanceM,
      snappedNodeId: candidate.endSnap.nodeId,
      snappedOriginalNodeId:
        graph.originalNodeId[candidate.endSnap.nodeId].toString(),
    },
    nodeCount: candidate.route.result.nodePath.length,
    totalCost: candidate.route.result.totalCost,
    actualGroundDistanceM: metrics.actualGroundDistanceM,
    indoorTraversalDistanceEquivalentM:
      metrics.indoorTraversalDistanceEquivalentM,
    totalDistanceEquivalentM: metrics.totalDistanceEquivalentM,
    containsIndoorEdge: routeUsesIndoorEdgeType(graph, candidate.route),
    edgeTypeSequenceSummary: edgeTypeSummary(graph, candidate.route.steps),
    coordinates: sequence.coordinates,
    geoJsonLineString: JSON.stringify({
      type: "LineString",
      coordinates: sequence.coordinates,
    }),
    proxyGeometrySegmentCount: sequence.proxySegmentCount,
  };
}

/**
 * @param output Benchmark output object.
 * @returns Nothing.
 */
function printSummary(output: {
  graph_version_id: number;
  acceptance: {
    "0-1": {
      nodeCount: number;
      directedEdgeCount: number;
      undirectedSegmentCount: number;
      connectivitySample: {
        reachable: number;
        sampled: number;
        percent: number | null;
      };
    };
    "0-2": {
      typedArrayFootprint: { megabytes: number; bytesPerDirectedEdge: number };
    };
    "0-3": {
      taipeiPrimary50m: JsonRecord;
      stationScaleComparison: { p95M: number; p95AtMost300M: boolean };
    };
    "0-4": {
      snapFailure: {
        failures: number;
        samples: number;
        failurePercent: number | null;
      };
      aStarCoreLatency: { milliseconds: NumberSummary };
    };
    "0-5": {
      silentHardConstraintViolationRateUsingRelaxationLevelDegradedProxy: {
        measurable: boolean;
        value: { percent: number | null };
      };
      markedHardConstraintViolationRateUsingRelaxationLevelDegradedProxy: {
        measurable: boolean;
        value: { percent: number | null };
      };
      wheelchairGroundDistanceDetourRatio: {
        measurable: boolean;
        value: { medianRatio: number | null };
      };
      aStarCoreLatency: {
        measurable: boolean;
        value: { p50Ms: number | null; p95Ms: number | null };
      };
    };
  };
  manualRoutes: Array<{
    label: string;
    containsIndoorEdge: boolean;
    nodeCount: number;
    totalCost: number;
  }>;
  outputPath: string;
}): void {
  const zeroOne = output.acceptance["0-1"];
  const zeroTwo = output.acceptance["0-2"];
  const zeroThree = output.acceptance["0-3"];
  const zeroFour = output.acceptance["0-4"];
  const zeroFive = output.acceptance["0-5"];
  const taipeiSuccess = requiredNumber(
    zeroThree.taipeiPrimary50m.success,
    "summary Taipei matching success",
  );
  const taipeiDenominator = requiredNumber(
    zeroThree.taipeiPrimary50m.denominator,
    "summary Taipei matching denominator",
  );
  console.log(
    `[ped-router-bench] graph_version_id=${output.graph_version_id} nodes=${zeroOne.nodeCount} directed_edges=${zeroOne.directedEdgeCount} undirected_segments=${zeroOne.undirectedSegmentCount}`,
  );
  console.log(
    `[ped-router-bench] connectivity=${zeroOne.connectivitySample.reachable}/${zeroOne.connectivitySample.sampled} (${zeroOne.connectivitySample.percent?.toFixed(3) ?? "n/a"}%)`,
  );
  console.log(
    `[ped-router-bench] typed_array_mb=${zeroTwo.typedArrayFootprint.megabytes.toFixed(3)} bytes_per_directed_edge=${zeroTwo.typedArrayFootprint.bytesPerDirectedEdge.toFixed(3)}`,
  );
  console.log(
    `[ped-router-bench] entrance_matching_taipei_50m=${taipeiSuccess}/${taipeiDenominator} station_radius_p95_m=${zeroThree.stationScaleComparison.p95M.toFixed(3)} p95_at_most_300=${zeroThree.stationScaleComparison.p95AtMost300M}`,
  );
  console.log(
    `[ped-router-bench] snap_failures_50m=${zeroFour.snapFailure.failures}/${zeroFour.snapFailure.samples} (${zeroFour.snapFailure.failurePercent?.toFixed(3) ?? "n/a"}%)`,
  );
  console.log(
    `[ped-router-bench] csr_search_h0_core_ms p50=${zeroFour.aStarCoreLatency.milliseconds.p50?.toFixed(3) ?? "n/a"} p95=${zeroFour.aStarCoreLatency.milliseconds.p95?.toFixed(3) ?? "n/a"} p99=${zeroFour.aStarCoreLatency.milliseconds.p99?.toFixed(3) ?? "n/a"}`,
  );
  console.log(
    `[ped-router-bench] measurable silent_proxy=${zeroFive.silentHardConstraintViolationRateUsingRelaxationLevelDegradedProxy.measurable}:${zeroFive.silentHardConstraintViolationRateUsingRelaxationLevelDegradedProxy.value.percent?.toFixed(3) ?? "n/a"}% marked_proxy=${zeroFive.markedHardConstraintViolationRateUsingRelaxationLevelDegradedProxy.measurable}:${zeroFive.markedHardConstraintViolationRateUsingRelaxationLevelDegradedProxy.value.percent?.toFixed(3) ?? "n/a"}% detour=${zeroFive.wheelchairGroundDistanceDetourRatio.measurable}:${zeroFive.wheelchairGroundDistanceDetourRatio.value.medianRatio?.toFixed(6) ?? "n/a"} latency=${zeroFive.aStarCoreLatency.measurable}:${zeroFive.aStarCoreLatency.value.p95Ms?.toFixed(3) ?? "n/a"}ms`,
  );
  for (const route of output.manualRoutes) {
    console.log(
      `[ped-router-bench] manual_route=${route.label} nodes=${route.nodeCount} total_cost=${route.totalCost.toFixed(3)} contains_indoor_edge=${route.containsIndoorEdge}`,
    );
  }
  console.log(`[ped-router-bench] json=${output.outputPath}`);
}

/**
 * @returns Nothing.
 */
async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2));
  const pool = new Pool({ connectionString: options.databaseUrl });
  try {
    await pool.query("SELECT 1");
    const garbageCollectionAvailableBeforeLoad = collectGarbage();
    const memoryBefore = process.memoryUsage();
    const graph = await loadPedGraph(pool);
    const garbageCollectionAvailableAfterLoad = collectGarbage();
    const memoryAfter = process.memoryUsage();
    const footprint = typedArrayFootprint(graph);
    const notes = await loadNotes(pool, graph.versionId);
    const coverage = await loadAttributeCoverage(pool, graph.versionId);
    const physicalNodes = physicalNodeIds(graph);
    const connectivity = connectivitySample(
      graph,
      physicalNodes,
      derivedSeed(options.seed, SEED_CONNECTIVITY),
    );
    const index = buildEdgeIndex(graph);
    const snapCoordinates = await samplePhysicalEdgeCoordinates(
      pool,
      graph.versionId,
      Math.max(MIN_SNAP_SAMPLES, options.samples),
      seededRandom(derivedSeed(options.seed, SEED_SNAP)),
    );
    const snapFailures = snapCoordinates.filter(
      ([longitude, latitude]) =>
        snapToGraph(index, latitude, longitude, SNAP_TOLERANCE_M) === null,
    ).length;

    const topology = buildEdgeTopology(graph);
    const feasible = strictFeasibility(graph, topology);
    const components = buildBidirectionalComponents(graph, topology, feasible);
    const latencyPairs = samplePairs(
      graph,
      components.primaryComponent,
      seededRandom(derivedSeed(options.seed, SEED_LATENCY)),
      options.samples + WARMUP_COUNT,
    );
    const measuredRoutes = measureCoreLatency(
      graph,
      latencyPairs,
      options.samples,
    );
    const coreMilliseconds = measuredRoutes.map((route) => route.milliseconds);
    const coreExpandedNodes = measuredRoutes.map(
      (route) => route.result.expandedNodes,
    );
    const coreReopenedNodes = measuredRoutes.map(
      (route) => route.result.reopenedNodes,
    );

    const primaryRoot = findRoot(
      components.parent,
      components.primaryComponent[0],
    );
    const outsidePrimaryComponent = physicalNodes.filter(
      (node) => findRoot(components.parent, node) !== primaryRoot,
    );
    const unreachableCandidates = samplePairsBetween(graph, {
      fromNodes: components.primaryComponent,
      toNodes: outsidePrimaryComponent,
      random: seededRandom(derivedSeed(options.seed, SEED_UNREACHABLE)),
      count: UNREACHABLE_PROBE_COUNT,
    });
    const unreachable = measureUnreachableLatency(graph, unreachableCandidates);

    const decisionPairs = samplePairs(
      graph,
      physicalNodes,
      seededRandom(derivedSeed(options.seed, SEED_DECISION)),
      options.samples,
    );
    const decisions = evaluateDecisionRoutes(graph, decisionPairs);
    const silentRate = rate(
      decisions.silentViolationRouteCount,
      decisions.routes.length,
    );
    const markedRate = rate(
      decisions.markedViolationRouteCount,
      decisions.routes.length,
    );
    const detourSummary = summarize(decisions.detourRatios);

    const firstManual = prepareManualCandidate(
      graph,
      index,
      measuredRoutes[0].pair,
      wheelchairProfile(0),
    );
    const secondManual = prepareManualCandidate(
      graph,
      index,
      measuredRoutes[1].pair,
      wheelchairProfile(0),
    );
    if (firstManual === null || secondManual === null) {
      throw new Error(
        "a sampled strict-wheelchair manual route became unreachable after snapping",
      );
    }
    const reverse = buildReverseEdges(graph, topology, feasible);
    const indoorManual = findIndoorManualCandidate(
      graph,
      index,
      topology,
      feasible,
      reverse,
      seededRandom(derivedSeed(options.seed, SEED_INDOOR)),
    );
    const manualCandidates = [firstManual, secondManual, indoorManual];
    const manualAttrIds = manualCandidates.flatMap((candidate) =>
      candidate.route.steps.map((step) => step.attrIdx),
    );
    const routeGeometries = await loadRouteGeometries(
      pool,
      graph,
      topology,
      manualAttrIds,
    );
    const manualRoutes = manualCandidates.map((candidate, indexNumber) =>
      serializeManualRoute(
        graph,
        candidate,
        indexNumber === 2 ? "indoor_route" : `route_${indexNumber + 1}`,
        routeGeometries,
      ),
    );
    if (!manualRoutes.some((route) => route.containsIndoorEdge)) {
      throw new Error("manual route output has no indoor edge");
    }

    const memoryDelta = {
      heapUsedBytes: memoryAfter.heapUsed - memoryBefore.heapUsed,
      arrayBuffersBytes: memoryAfter.arrayBuffers - memoryBefore.arrayBuffers,
      garbageCollectionAvailableBeforeLoad,
      garbageCollectionAvailableAfterLoad,
    };
    const output = {
      graph_version_id: graph.versionId,
      seed: options.seed,
      outputPath: options.outputPath,
      sampling: {
        latencyRetainedSamples: options.samples,
        warmupSamplesDiscarded: WARMUP_COUNT,
        snapSamples: snapCoordinates.length,
        connectivitySamples: CONNECTIVITY_SAMPLE_COUNT,
        decisionSamples: decisionPairs.length,
        unreachableProbeCandidates: unreachableCandidates.length,
        odDistanceRangeM: { min: MIN_OD_DISTANCE_M, max: MAX_OD_DISTANCE_M },
        percentileMethod: "floor((n - 1) * p)",
      },
      acceptance: {
        "0-1": {
          nodeCount: graph.nodeCount,
          directedEdgeCount: graph.directedEdgeCount,
          undirectedSegmentCount: graph.undirectedEdgeCount,
          edgeTypeDistribution: edgeTypeDistribution(graph),
          attributeCoverage: {
            slope: coverageMetric(coverage.slope, coverage.total),
            surface: coverageMetric(coverage.surface, coverage.total),
            smoothness: coverageMetric(coverage.smoothness, coverage.total),
            widthEffective: coverageMetric(
              coverage.effectiveWidth,
              coverage.total,
            ),
            wheelchair: coverageMetric(coverage.wheelchair, coverage.total),
            stairCount: coverageMetric(coverage.stairCount, coverage.total),
          },
          connectivitySample: connectivity,
        },
        "0-2": {
          typedArrayFootprint: {
            bytes: footprint.bytes,
            megabytes: megabytes(footprint.bytes),
            bytesByField: footprint.bytesByField,
            bytesPerDirectedEdge: footprint.bytes / graph.directedEdgeCount,
            megabyteDefinition: "bytes / 1024^2",
          },
          sixCityExtrapolation: {
            scale: SIX_CITY_SCALE,
            residentBytes: footprint.bytes * SIX_CITY_SCALE,
            residentMegabytes: megabytes(footprint.bytes * SIX_CITY_SCALE),
            hotReloadMultiplier: HOT_RELOAD_MULTIPLIER,
            hotReloadPeakBytes:
              footprint.bytes * SIX_CITY_SCALE * HOT_RELOAD_MULTIPLIER,
            hotReloadPeakMegabytes: megabytes(
              footprint.bytes * SIX_CITY_SCALE * HOT_RELOAD_MULTIPLIER,
            ),
          },
          secondaryProcessMemoryDelta: {
            heapUsedBytes: memoryDelta.heapUsedBytes,
            heapUsedMegabytes: megabytes(memoryDelta.heapUsedBytes),
            arrayBuffersBytes: memoryDelta.arrayBuffersBytes,
            arrayBuffersMegabytes: megabytes(memoryDelta.arrayBuffersBytes),
            garbageCollectionAvailableBeforeLoad:
              memoryDelta.garbageCollectionAvailableBeforeLoad,
            garbageCollectionAvailableAfterLoad:
              memoryDelta.garbageCollectionAvailableAfterLoad,
          },
        },
        "0-3": entranceMatchingMetrics(notes),
        "0-4": {
          graph_version_id: graph.versionId,
          snapFailure: {
            toleranceM: SNAP_TOLERANCE_M,
            samples: snapCoordinates.length,
            failures: snapFailures,
            failureRate: rate(snapFailures, snapCoordinates.length).rate,
            failurePercent: rate(snapFailures, snapCoordinates.length).percent,
            coordinateSource:
              "ST_LineInterpolatePoint(ped_edge.geom, fraction)",
          },
          aStarCoreLatency: {
            measurementScope:
              "aStar(graph, from, to, wheelchairProfile) only; current h=0 Dijkstra-equivalent search",
            retainedSamples: measuredRoutes.length,
            warmupSamplesDiscarded: WARMUP_COUNT,
            milliseconds: summarize(coreMilliseconds),
            expandedNodes: summarize(coreExpandedNodes),
            reopenedNodes: summarize(coreReopenedNodes),
            profile: "wheelchair",
            relaxationLevel: 0,
            odSelection:
              "fixed-seed physical-node pairs in the largest finite reciprocal component",
          },
          unreachableOdLatency: {
            profile: "wheelchair",
            relaxationLevel: 0,
            candidateCount: unreachable.candidateCount,
            unreachableCount: unreachable.unreachableCount,
            reachableCount: unreachable.reachableCount,
            milliseconds: summarize(unreachable.milliseconds),
            odSelection:
              "fixed-seed source in the largest finite reciprocal component and target outside it",
          },
        },
        "0-5": {
          silentHardConstraintViolationRateUsingRelaxationLevelDegradedProxy: {
            measurable: true,
            value: {
              ...silentRate,
              returnedRouteCount: decisions.routes.length,
              evaluationOdCount: decisionPairs.length,
              unrouteableCount: decisions.unrouteableCount,
              inspectedEdgeCount: decisions.inspectedEdgeCount,
            },
          },
          markedHardConstraintViolationRateUsingRelaxationLevelDegradedProxy: {
            measurable: true,
            value: {
              ...markedRate,
              returnedRouteCount: decisions.routes.length,
              evaluationOdCount: decisionPairs.length,
              unrouteableCount: decisions.unrouteableCount,
              strictViolationEdgeCount: decisions.strictViolationEdgeCount,
            },
          },
          wheelchairGroundDistanceDetourRatio: {
            measurable: true,
            value: {
              medianRatio: detourSummary.p50,
              distribution: detourSummary,
              comparableOdCount: decisions.detourRatios.length,
              returnedRouteCount: decisions.routes.length,
              excludedIndoorRouteCount: decisions.detourExcludedIndoorCount,
              excludedZeroDistanceCount:
                decisions.detourExcludedZeroDistanceCount,
            },
            numerator:
              "actualGroundDistanceM on first-feasible wheelchair route",
            denominator:
              "actualGroundDistanceM on pure-distance unrestricted shortest route",
          },
          aStarCoreLatency: {
            measurable: true,
            value: {
              p50Ms: summarize(coreMilliseconds).p50,
              p95Ms: summarize(coreMilliseconds).p95,
              retainedSampleCount: measuredRoutes.length,
            },
          },
        },
        "0-6": "see docs/reports/PED_ROUTER_DATA_SOURCES.md",
      },
      manualRoutes,
    };
    fs.mkdirSync(path.dirname(options.outputPath), { recursive: true });
    fs.writeFileSync(
      options.outputPath,
      `${JSON.stringify(output, null, 2)}\n`,
    );
    printSummary(output);
  } finally {
    await pool.end();
  }
}

void main().catch((error: unknown) => {
  console.error(
    `[ped-router-bench] ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exitCode = 1;
});
