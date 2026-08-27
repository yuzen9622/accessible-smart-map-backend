/**
 * Paired comparison bench: pedestrian a11y engine vs the production OTP walk planner.
 *
 * Implements docs/specs/IMPL_PED_ROUTER_OTP_COMPARISON.md v1.0.0, which was frozen
 * before this script produced any result. Both engines receive identical OD
 * coordinates and both routes are judged by ONE cost model (this engine's), because
 * letting each engine self-assess produces incomparable numbers.
 *
 * OTP returns geometry, not edge IDs, so its route is mapped back onto this graph by
 * snapping polyline sub-segment midpoints. That mapping is the main threat to validity
 * and is therefore quality-gated and reported, never silently trusted.
 */

import fs from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { decode } from "@googlemaps/polyline-codec";
import { Pool } from "pg";
import {
  BinaryMinHeap,
  aStar,
} from "../modules/accessible-route/planners/pedestrian-a11y/astar";
import {
  WHEELCHAIR_MAX_RELAXATION_LEVEL,
  WHEELCHAIR_WALK_SPEED_MPS,
  edgeCost,
  type CostProfile,
} from "../modules/accessible-route/planners/pedestrian-a11y/cost";
import { loadPedGraph } from "../modules/accessible-route/planners/pedestrian-a11y/graph-loader";
import {
  readReplayPairsFile,
  resolveReplayPairs,
} from "./ped-router-otp-comparison-replay";
import { resolvePlannedPathSteps } from "./ped-router-planned-path";
import {
  EDGE_FLAG,
  NODE_FLAG,
  type PedGraph,
} from "../modules/accessible-route/planners/pedestrian-a11y/graph.types";
import {
  buildEdgeIndex,
  snapToGraph,
  type EdgeIndex,
} from "../modules/accessible-route/planners/pedestrian-a11y/spatial-index";
import { haversineMeters } from "../utils/geo";

const SPEC_VERSION = "IMPL_PED_ROUTER_OTP_COMPARISON.md v1.1.0";
const DEFAULT_OUTPUT_PATH = "/tmp/ped-otp-comparison.json";

/** Pre-registered sampling parameters (spec §3). */
const DEFAULT_SEED = 20_260_826;
const DEFAULT_SAMPLE_COUNT = 200;
const MIN_OD_DISTANCE_M = 300;
const MAX_OD_DISTANCE_M = 3_000;
const MAX_PAIR_ATTEMPTS = 4_096;

/** Pre-registered OTP query parameters (spec §4). */
const OTP_DATE = "2026-08-26";
const OTP_TIME = "10:00:00";
const OTP_TIMEOUT_MS = 30_000;

/** Pre-registered mapping quality gate (spec §5.2). */
const SNAP_TOLERANCE_M = 20;
const MAX_UNMAPPED_SUBSEGMENT_RATIO = 0.1;

const OTP_WALK_QUERY = `
query Walk(
  $fromLat: Float!, $fromLon: Float!,
  $toLat: Float!, $toLon: Float!,
  $date: String!, $time: String!,
  $wheelchair: Boolean!, $walkSpeed: Float
) {
  plan(
    from: { lat: $fromLat, lon: $fromLon }
    to: { lat: $toLat, lon: $toLon }
    date: $date
    time: $time
    wheelchair: $wheelchair
    walkSpeed: $walkSpeed
    numItineraries: 1
    transportModes: [{ mode: WALK }]
  ) {
    itineraries {
      duration
      walkDistance
      legs { mode distance legGeometry { points } }
    }
  }
}`;

interface NodePair {
  from: number;
  to: number;
}

interface PathStep {
  attrIdx: number;
}

interface NumberSummary {
  count: number;
  min: number | null;
  p50: number | null;
  p95: number | null;
  p99: number | null;
  max: number | null;
}

/**
 * Which hard constraint blocked an edge, named by the relaxation level that unblocks
 * it. Derived by re-running the real cost function at successive relaxation levels
 * rather than re-deriving thresholds, so this can never drift from cost.ts.
 */
type ViolationCause =
  "extreme_slope" | "narrow_width" | "unramped_steps" | "other_hard_constraint";

interface RouteJudgement {
  edgeCount: number;
  violatingEdgeCount: number;
  hasViolation: boolean;
  causeCounts: Record<ViolationCause, number>;
  groundDistanceM: number;
  hasIndoorEdge: boolean;
}

interface OtpRoute {
  coordinates: [number, number][];
  reportedWalkDistanceM: number;
  latencyMs: number;
}

type OtpOutcome =
  | { status: "ok"; route: OtpRoute }
  | { status: "no_route"; latencyMs: number }
  | { status: "error"; latencyMs: number; message: string };

interface MappedOtpRoute {
  steps: PathStep[];
  geometricDistanceM: number;
  subSegmentCount: number;
  unmappedSubSegmentCount: number;
  unmappedRatio: number;
  snapDistancesM: number[];
}

interface PairOutcome {
  index: number;
  /** Only set in replay mode: the case id in the file being replayed. */
  sourceIndex?: number;
  from: { node: number; lat: number; lon: number };
  to: { node: number; lat: number; lon: number };
  straightLineDistanceM: number;
  ours:
    | {
        status: "ok";
        relaxationLevel: number;
        latencyMs: number;
        judgement: RouteJudgement;
        detourRatio: number | null;
      }
    | { status: "no_route"; latencyMs: number };
  otp:
    | {
        status: "ok";
        latencyMs: number;
        reportedWalkDistanceM: number;
        geometricDistanceM: number;
        mapping: {
          subSegmentCount: number;
          unmappedSubSegmentCount: number;
          unmappedRatio: number;
          excluded: boolean;
          snapDistanceP95M: number | null;
        };
        judgement: RouteJudgement | null;
        detourRatio: number | null;
      }
    | { status: "no_route"; latencyMs: number }
    | { status: "error"; latencyMs: number; message: string };
  unconstrainedDistanceM: number | null;
}

/**
 * @param seed Base seed.
 * @returns A deterministic uniform generator.
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
 * @param values Numeric observations.
 * @param proportion Zero-to-one percentile proportion.
 * @returns The floor-index percentile, matching the Phase 0 bench convention.
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
 * @returns Fraction and percentage, or nulls when nothing was eligible.
 */
function rate(
  numerator: number,
  denominator: number,
): { numerator: number; denominator: number; percent: number | null } {
  return {
    numerator,
    denominator,
    percent: denominator === 0 ? null : (numerator / denominator) * 100,
  };
}

/**
 * @param relaxationLevel Hard-constraint relaxation level.
 * @returns The wheelchair cost profile at that level.
 */
function wheelchairProfile(relaxationLevel: number): CostProfile {
  return {
    name: "wheelchair",
    walkSpeedMps: WHEELCHAIR_WALK_SPEED_MPS,
    relaxationLevel,
  };
}

/**
 * @param graph CSR pedestrian graph.
 * @returns Dense indices of outdoor nodes carrying real geometry.
 */
function outdoorNodes(graph: PedGraph): number[] {
  const nodes: number[] = [];
  for (let node = 0; node < graph.nodeCount; node += 1) {
    const flags = graph.nodeFlags[node];
    if ((flags & NODE_FLAG.INDOOR) !== 0) continue;
    if ((flags & NODE_FLAG.HAS_REAL_GEOM) === 0) continue;
    nodes.push(node);
  }
  return nodes;
}

/**
 * @param graph CSR pedestrian graph.
 * @param pair Origin and destination nodes.
 * @returns Great-circle distance between the pair's coordinates.
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
 * Samples OD pairs from the whole outdoor node set — deliberately NOT from this
 * engine's reachable component, which would hide its own routing failures.
 *
 * @param graph CSR pedestrian graph.
 * @param nodes Candidate outdoor nodes.
 * @param random Seeded generator.
 * @param count Requested pair count.
 * @returns Distinct OD pairs inside the pre-registered distance band.
 */
function samplePairs(
  graph: PedGraph,
  nodes: number[],
  random: () => number,
  count: number,
): NodePair[] {
  const pairs: NodePair[] = [];
  const seen = new Set<string>();
  while (pairs.length < count) {
    let selected: NodePair | undefined;
    for (let attempt = 0; attempt < MAX_PAIR_ATTEMPTS; attempt += 1) {
      const from = nodes[Math.floor(random() * nodes.length)];
      const to = nodes[Math.floor(random() * nodes.length)];
      if (from === to) continue;
      const key = `${from}:${to}`;
      if (seen.has(key)) continue;
      const distanceM = pairDistanceM(graph, { from, to });
      if (distanceM < MIN_OD_DISTANCE_M || distanceM > MAX_OD_DISTANCE_M) {
        continue;
      }
      selected = { from, to };
      seen.add(key);
      break;
    }
    if (selected === undefined) {
      throw new Error("unable to sample an OD pair in the configured range");
    }
    pairs.push(selected);
  }
  return pairs;
}

/**
 * @param graph CSR pedestrian graph.
 * @param attrIdx Edge attribute index.
 * @returns Physical length, using the traversal-time equivalent for indoor edges.
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
 * @param graph CSR pedestrian graph.
 * @param pair Origin and destination nodes.
 * @returns Shortest pure-distance path length, or null when disconnected.
 */
function unconstrainedShortestDistanceM(
  graph: PedGraph,
  pair: NodePair,
): number | null {
  if (pair.from === pair.to) return 0;
  const distance = new Float64Array(graph.nodeCount);
  distance.fill(Number.POSITIVE_INFINITY);
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
    if (node === pair.to) return distance[node];
    for (
      let adjacencyIndex = graph.adjOffset[node];
      adjacencyIndex < graph.adjOffset[node + 1];
      adjacencyIndex += 1
    ) {
      const attrIdx = graph.adjAttr[adjacencyIndex];
      const edgeDistanceM = unconstrainedEdgeDistanceM(graph, attrIdx);
      if (!Number.isFinite(edgeDistanceM)) continue;
      const target = graph.adjTarget[adjacencyIndex];
      const tentative = distance[node] + edgeDistanceM;
      if (tentative >= distance[target]) continue;
      distance[target] = tentative;
      open.push(target, tentative);
    }
  }
  return null;
}

/**
 * Attributes a strict-infeasible edge to the first ladder level that unblocks it.
 *
 * @param graph CSR pedestrian graph.
 * @param attrIdx Edge attribute index known to be infeasible at level 0.
 * @returns The blocking hard constraint.
 */
function violationCause(graph: PedGraph, attrIdx: number): ViolationCause {
  const causeByLevel: ViolationCause[] = [
    "extreme_slope",
    "narrow_width",
    "unramped_steps",
  ];
  for (let level = 1; level <= WHEELCHAIR_MAX_RELAXATION_LEVEL; level += 1) {
    if (Number.isFinite(edgeCost(graph, attrIdx, wheelchairProfile(level)))) {
      return causeByLevel[level - 1];
    }
  }
  return "other_hard_constraint";
}

/**
 * Judges any route — ours or OTP's — by the one shared cost model (spec §2).
 *
 * @param graph CSR pedestrian graph.
 * @param steps Traversed edges.
 * @returns Violation counts, causes, and ground distance.
 */
function judgeRoute(graph: PedGraph, steps: PathStep[]): RouteJudgement {
  const strictProfile = wheelchairProfile(0);
  const causeCounts: Record<ViolationCause, number> = {
    extreme_slope: 0,
    narrow_width: 0,
    unramped_steps: 0,
    other_hard_constraint: 0,
  };
  let violatingEdgeCount = 0;
  let groundDistanceM = 0;
  let hasIndoorEdge = false;
  for (const step of steps) {
    if (!Number.isFinite(edgeCost(graph, step.attrIdx, strictProfile))) {
      violatingEdgeCount += 1;
      causeCounts[violationCause(graph, step.attrIdx)] += 1;
    }
    if ((graph.edgeFlags[step.attrIdx] & EDGE_FLAG.INDOOR) !== 0) {
      hasIndoorEdge = true;
      continue;
    }
    const lengthM = graph.edgeLengthM[step.attrIdx];
    if (Number.isFinite(lengthM)) groundDistanceM += lengthM;
  }
  return {
    edgeCount: steps.length,
    violatingEdgeCount,
    hasViolation: violatingEdgeCount > 0,
    causeCounts,
    groundDistanceM,
    hasIndoorEdge,
  };
}

/**
 * @param graph CSR pedestrian graph.
 * @param pair Origin and destination nodes.
 * @returns The first route the relaxation ladder produces, with its level.
 */
function planWithLadder(
  graph: PedGraph,
  pair: NodePair,
): { steps: PathStep[]; relaxationLevel: number; latencyMs: number } | null {
  let latencyMs = 0;
  for (
    let relaxationLevel = 0;
    relaxationLevel <= WHEELCHAIR_MAX_RELAXATION_LEVEL;
    relaxationLevel += 1
  ) {
    const profile = wheelchairProfile(relaxationLevel);
    const startedAt = performance.now();
    const result = aStar(graph, pair.from, pair.to, profile);
    latencyMs += performance.now() - startedAt;
    if (result === null) continue;
    return {
      steps: resolvePlannedPathSteps(graph, result.nodePath, (attrIdx) =>
        edgeCost(graph, attrIdx, profile),
      ),
      relaxationLevel,
      latencyMs,
    };
  }
  return null;
}

/**
 * @param baseUrl OTP server origin.
 * @param graph CSR pedestrian graph.
 * @param pair Origin and destination nodes.
 * @returns The OTP walk itinerary geometry, or why there was none.
 */
async function queryOtpWalk(
  baseUrl: string,
  graph: PedGraph,
  pair: NodePair,
): Promise<OtpOutcome> {
  const body = JSON.stringify({
    query: OTP_WALK_QUERY,
    variables: {
      fromLat: graph.nodeLat[pair.from],
      fromLon: graph.nodeLon[pair.from],
      toLat: graph.nodeLat[pair.to],
      toLon: graph.nodeLon[pair.to],
      date: OTP_DATE,
      time: OTP_TIME,
      wheelchair: true,
      walkSpeed: WHEELCHAIR_WALK_SPEED_MPS,
    },
  });
  const startedAt = performance.now();
  try {
    const response = await fetch(`${baseUrl}/otp/gtfs/v1`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
      signal: AbortSignal.timeout(OTP_TIMEOUT_MS),
    });
    const latencyMs = performance.now() - startedAt;
    if (!response.ok) {
      return {
        status: "error",
        latencyMs,
        message: `HTTP ${response.status}`,
      };
    }
    const payload = (await response.json()) as {
      data?: {
        plan?: {
          itineraries?: {
            walkDistance?: number;
            legs?: { mode: string; legGeometry?: { points?: string } }[];
          }[];
        };
      };
      errors?: { message: string }[];
    };
    if (payload.errors?.length) {
      return { status: "error", latencyMs, message: payload.errors[0].message };
    }
    const itinerary = payload.data?.plan?.itineraries?.[0];
    if (itinerary === undefined) return { status: "no_route", latencyMs };
    const coordinates: [number, number][] = [];
    for (const leg of itinerary.legs ?? []) {
      if (leg.mode !== "WALK") continue;
      const decoded = decode(leg.legGeometry?.points ?? "", 5) as [
        number,
        number,
      ][];
      for (const [lat, lon] of decoded) {
        const last = coordinates[coordinates.length - 1];
        if (last !== undefined && last[0] === lat && last[1] === lon) continue;
        coordinates.push([lat, lon]);
      }
    }
    if (coordinates.length < 2) return { status: "no_route", latencyMs };
    return {
      status: "ok",
      route: {
        coordinates,
        reportedWalkDistanceM: itinerary.walkDistance ?? 0,
        latencyMs,
      },
    };
  } catch (error) {
    return {
      status: "error",
      latencyMs: performance.now() - startedAt,
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Maps an OTP polyline onto this graph's edges by snapping sub-segment midpoints.
 *
 * Sub-segments that snap beyond tolerance are counted, never dropped silently — a
 * failed mapping would otherwise read as "OTP had no violation" (spec §5.2).
 *
 * Two deliberate separations keep this honest (spec §5.2a):
 * - Distance comes from the polyline's own geometry, never from summing whole graph
 *   edge lengths. A polyline sub-segment is usually a fraction of an edge, so summing
 *   edge lengths inflates OTP's distance and therefore its detour ratio.
 * - The judged edge set is globally deduplicated, so an out-and-back that revisits one
 *   edge cannot count that edge's violation twice.
 *
 * @param index Flatbush edge index.
 * @param coordinates Decoded OTP geometry.
 * @returns Mapped edges plus the mapping quality evidence.
 */
function mapPolylineToEdges(
  index: EdgeIndex,
  coordinates: [number, number][],
): MappedOtpRoute {
  const uniqueAttrIdx = new Set<number>();
  const snapDistancesM: number[] = [];
  let unmappedSubSegmentCount = 0;
  let geometricDistanceM = 0;
  for (let position = 0; position < coordinates.length - 1; position += 1) {
    const [fromLat, fromLon] = coordinates[position];
    const [toLat, toLon] = coordinates[position + 1];
    geometricDistanceM += haversineMeters(fromLat, fromLon, toLat, toLon);
    const snapped = snapToGraph(
      index,
      (fromLat + toLat) / 2,
      (fromLon + toLon) / 2,
      SNAP_TOLERANCE_M,
    );
    if (snapped === null) {
      unmappedSubSegmentCount += 1;
      continue;
    }
    snapDistancesM.push(snapped.distanceM);
    uniqueAttrIdx.add(snapped.edgeAttrIdx);
  }
  const subSegmentCount = Math.max(0, coordinates.length - 1);
  return {
    steps: [...uniqueAttrIdx].map((attrIdx) => ({ attrIdx })),
    geometricDistanceM,
    subSegmentCount,
    unmappedSubSegmentCount,
    unmappedRatio:
      subSegmentCount === 0 ? 1 : unmappedSubSegmentCount / subSegmentCount,
    snapDistancesM,
  };
}

export interface ComparisonOptions {
  dbUrl: string;
  otpUrl: string;
  seed: number;
  samples: number;
  versionId: number | undefined;
  output: string;
  pairsInput: string | undefined;
}

/** Flags that consume a value, either as `--flag value` or `--flag=value`. */
const VALUE_FLAGS = new Set([
  "--db-url",
  "--otp-url",
  "--seed",
  "--samples",
  "--version-id",
  "--output",
  "--pairs-input",
]);

/**
 * @param argv Raw process arguments.
 * @returns Parsed run options.
 */
export function parseArgs(argv: string[]): ComparisonOptions {
  let dbUrl = process.env.PED_GRAPH_DATABASE_URL ?? "";
  let otpUrl = process.env.OTP_BASE_URL ?? "http://localhost:8080";
  let seed = DEFAULT_SEED;
  let samples = DEFAULT_SAMPLE_COUNT;
  let versionId: number | undefined;
  let output = DEFAULT_OUTPUT_PATH;
  let pairsInput: string | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const separator = argument.indexOf("=");
    const flag = separator === -1 ? argument : argument.slice(0, separator);
    if (!VALUE_FLAGS.has(flag)) {
      throw new Error(`unknown argument ${argument}`);
    }
    // A missing value must never fall through as undefined: silently keeping the
    // default would turn `--pairs-input` with a lost value into a fresh seeded
    // sample, i.e. a different experiment reported under the replay's name. A
    // following flag is a lost value too, not a value that happens to start with
    // a dash.
    const value =
      separator === -1 ? argv[++index] : argument.slice(separator + 1);
    if (value === undefined || value === "" || value.startsWith("--")) {
      throw new Error(`${flag} requires a value`);
    }
    if (flag === "--db-url") dbUrl = value;
    else if (flag === "--otp-url") otpUrl = value;
    else if (flag === "--seed") seed = Number(value);
    else if (flag === "--samples") samples = Number(value);
    else if (flag === "--version-id") versionId = Number(value);
    else if (flag === "--output") output = value;
    else pairsInput = value;
  }
  if (!dbUrl) {
    throw new Error("PED_GRAPH_DATABASE_URL or --db-url is required");
  }
  if (!Number.isInteger(samples) || samples <= 0) {
    throw new Error("--samples must be a positive integer");
  }
  if (!Number.isFinite(seed)) {
    throw new Error("--seed must be a finite number");
  }
  if (versionId !== undefined && !Number.isInteger(versionId)) {
    throw new Error("--version-id must be an integer");
  }
  return { dbUrl, otpUrl, seed, samples, versionId, output, pairsInput };
}

/**
 * Runs the paired comparison and writes its evidence file.
 *
 * @returns Nothing.
 */
async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const pool = new Pool({ connectionString: options.dbUrl });
  let graph: PedGraph;
  try {
    graph = await loadPedGraph(pool, options.versionId);
  } finally {
    await pool.end();
  }
  const index = buildEdgeIndex(graph);
  const candidates = outdoorNodes(graph);
  let pairs: NodePair[];
  let sourceIndexes: number[] | null = null;
  if (options.pairsInput === undefined) {
    pairs = samplePairs(
      graph,
      candidates,
      seededRandom(options.seed),
      options.samples,
    );
  } else {
    const replayed = resolveReplayPairs(
      graph,
      readReplayPairsFile(options.pairsInput),
    );
    pairs = replayed.map((pair) => ({ from: pair.from, to: pair.to }));
    sourceIndexes = replayed.map((pair) => pair.sourceIndex);
  }
  console.log(
    `[otp-comparison] graph version=${graph.versionId} nodes=${graph.nodeCount} ` +
      `edges=${graph.directedEdgeCount} outdoor_nodes=${candidates.length}`,
  );
  console.log(
    sourceIndexes === null
      ? `[otp-comparison] sampling seed=${options.seed} pairs=${pairs.length} otp=${options.otpUrl}`
      : `[otp-comparison] replaying ${pairs.length} pair(s) from ${options.pairsInput} otp=${options.otpUrl}`,
  );

  const outcomes: PairOutcome[] = [];
  for (const [position, pair] of pairs.entries()) {
    const ours = planWithLadder(graph, pair);
    const otpOutcome = await queryOtpWalk(options.otpUrl, graph, pair);
    const unconstrainedDistanceM = unconstrainedShortestDistanceM(graph, pair);

    let oursOut: PairOutcome["ours"];
    if (ours === null) {
      oursOut = { status: "no_route", latencyMs: 0 };
    } else {
      const judgement = judgeRoute(graph, ours.steps);
      oursOut = {
        status: "ok",
        relaxationLevel: ours.relaxationLevel,
        latencyMs: ours.latencyMs,
        judgement,
        detourRatio:
          unconstrainedDistanceM !== null &&
          unconstrainedDistanceM > 0 &&
          !judgement.hasIndoorEdge
            ? judgement.groundDistanceM / unconstrainedDistanceM
            : null,
      };
    }

    let otpOut: PairOutcome["otp"];
    if (otpOutcome.status === "ok") {
      const mapped = mapPolylineToEdges(index, otpOutcome.route.coordinates);
      const excluded = mapped.unmappedRatio > MAX_UNMAPPED_SUBSEGMENT_RATIO;
      const judgement = excluded ? null : judgeRoute(graph, mapped.steps);
      otpOut = {
        status: "ok",
        latencyMs: otpOutcome.route.latencyMs,
        reportedWalkDistanceM: otpOutcome.route.reportedWalkDistanceM,
        geometricDistanceM: mapped.geometricDistanceM,
        mapping: {
          subSegmentCount: mapped.subSegmentCount,
          unmappedSubSegmentCount: mapped.unmappedSubSegmentCount,
          unmappedRatio: mapped.unmappedRatio,
          excluded,
          snapDistanceP95M: percentile(mapped.snapDistancesM, 0.95),
        },
        judgement,
        detourRatio:
          judgement !== null &&
          unconstrainedDistanceM !== null &&
          unconstrainedDistanceM > 0 &&
          !judgement.hasIndoorEdge
            ? mapped.geometricDistanceM / unconstrainedDistanceM
            : null,
      };
    } else if (otpOutcome.status === "no_route") {
      otpOut = { status: "no_route", latencyMs: otpOutcome.latencyMs };
    } else {
      otpOut = {
        status: "error",
        latencyMs: otpOutcome.latencyMs,
        message: otpOutcome.message,
      };
    }

    outcomes.push({
      index: position,
      ...(sourceIndexes === null
        ? {}
        : { sourceIndex: sourceIndexes[position] }),
      from: {
        node: pair.from,
        lat: graph.nodeLat[pair.from],
        lon: graph.nodeLon[pair.from],
      },
      to: {
        node: pair.to,
        lat: graph.nodeLat[pair.to],
        lon: graph.nodeLon[pair.to],
      },
      straightLineDistanceM: pairDistanceM(graph, pair),
      ours: oursOut,
      otp: otpOut,
      unconstrainedDistanceM,
    });
    if ((position + 1) % 25 === 0) {
      console.log(`[otp-comparison] progress ${position + 1}/${pairs.length}`);
    }
  }

  const report = buildReport(options, graph, outcomes, sourceIndexes !== null);
  fs.mkdirSync(path.dirname(options.output), { recursive: true });
  fs.writeFileSync(options.output, JSON.stringify(report, null, 2));
  printSummary(report);
  console.log(`[otp-comparison] wrote ${options.output}`);
}

/**
 * @param options Run options.
 * @param graph CSR pedestrian graph.
 * @param outcomes Per-OD results.
 * @returns The complete evidence document.
 */
function buildReport(
  options: ReturnType<typeof parseArgs>,
  graph: PedGraph,
  outcomes: PairOutcome[],
  replayed: boolean,
): Record<string, unknown> {
  const oursRouted = outcomes.filter((item) => item.ours.status === "ok");
  const otpRouted = outcomes.filter((item) => item.otp.status === "ok");
  const otpErrors = outcomes.filter((item) => item.otp.status === "error");

  /** Violation rates are computed only on the paired intersection (spec §5.1). */
  const paired = outcomes.filter(
    (item) =>
      item.ours.status === "ok" &&
      item.otp.status === "ok" &&
      item.otp.judgement !== null,
  );
  const mappingExcluded = outcomes.filter(
    (item) => item.otp.status === "ok" && item.otp.mapping.excluded,
  );

  let silentViolations = 0;
  let markedViolations = 0;
  let otpViolations = 0;
  const oursCauses: Record<string, number> = {};
  const otpCauses: Record<string, number> = {};
  for (const item of paired) {
    if (item.ours.status !== "ok" || item.otp.status !== "ok") continue;
    const oursJudgement = item.ours.judgement;
    const otpJudgement = item.otp.judgement;
    if (otpJudgement === null) continue;
    if (oursJudgement.hasViolation) {
      if (item.ours.relaxationLevel === 0) silentViolations += 1;
      else markedViolations += 1;
      for (const [cause, count] of Object.entries(oursJudgement.causeCounts)) {
        oursCauses[cause] = (oursCauses[cause] ?? 0) + count;
      }
    }
    if (otpJudgement.hasViolation) {
      otpViolations += 1;
      for (const [cause, count] of Object.entries(otpJudgement.causeCounts)) {
        otpCauses[cause] = (otpCauses[cause] ?? 0) + count;
      }
    }
  }

  const oursDetours = collectDetours(outcomes, "ours");
  const otpDetours = collectDetours(outcomes, "otp");
  const oursLatency = oursRouted.map((item) =>
    item.ours.status === "ok" ? item.ours.latencyMs : 0,
  );
  const otpLatency = otpRouted.map((item) =>
    item.otp.status === "ok" ? item.otp.latencyMs : 0,
  );
  const snapP95 = otpRouted
    .map((item) =>
      item.otp.status === "ok" ? item.otp.mapping.snapDistanceP95M : null,
    )
    .filter((value): value is number => value !== null);

  /** Cross-checks mapping fidelity: mapped ground distance vs OTP's own number. */
  const distanceAgreement = paired
    .map((item) => {
      if (item.otp.status !== "ok" || item.otp.judgement === null) return null;
      const reported = item.otp.reportedWalkDistanceM;
      if (reported <= 0) return null;
      return item.otp.geometricDistanceM / reported;
    })
    .filter((value): value is number => value !== null);

  return {
    specVersion: SPEC_VERSION,
    generatedAt: new Date().toISOString(),
    graph: {
      versionId: graph.versionId,
      nodeCount: graph.nodeCount,
      directedEdgeCount: graph.directedEdgeCount,
    },
    configuration: {
      seed: options.seed,
      requestedSamples: options.samples,
      ...(replayed
        ? {
            replay: {
              pairsInput: options.pairsInput,
              pairCount: outcomes.length,
              note: "OD coordinates replayed from a prior run; seed sampling unused",
            },
          }
        : {}),
      otpBaseUrl: options.otpUrl,
      otpQuery: {
        wheelchair: true,
        walkSpeedMps: WHEELCHAIR_WALK_SPEED_MPS,
        date: OTP_DATE,
        time: OTP_TIME,
        numItineraries: 1,
      },
      odDistanceBandM: [MIN_OD_DISTANCE_M, MAX_OD_DISTANCE_M],
      snapToleranceM: SNAP_TOLERANCE_M,
      maxUnmappedSubSegmentRatio: MAX_UNMAPPED_SUBSEGMENT_RATIO,
    },
    coverage: {
      sampled: outcomes.length,
      oursRouted: oursRouted.length,
      otpRouted: otpRouted.length,
      otpErrors: otpErrors.length,
      bothRouted: outcomes.filter(
        (item) => item.ours.status === "ok" && item.otp.status === "ok",
      ).length,
      neitherRouted: outcomes.filter(
        (item) => item.ours.status !== "ok" && item.otp.status !== "ok",
      ).length,
      onlyOurs: outcomes.filter(
        (item) => item.ours.status === "ok" && item.otp.status !== "ok",
      ).length,
      onlyOtp: outcomes.filter(
        (item) => item.ours.status !== "ok" && item.otp.status === "ok",
      ).length,
    },
    mappingQuality: {
      excludedRoutes: mappingExcluded.length,
      snapDistanceP95M: summarize(snapP95),
      mappedVsReportedDistanceRatio: summarize(distanceAgreement),
    },
    condition1SilentViolationRate: {
      decidable: true,
      proxy: "relaxationLevel === 0 stands in for the absent API degraded flag",
      value: rate(silentViolations, paired.length),
    },
    condition2ViolationRate: {
      decidable: paired.length > 0,
      ours: rate(markedViolations + silentViolations, paired.length),
      otp: rate(otpViolations, paired.length),
      oursViolationCauseEdgeCounts: oursCauses,
      otpViolationCauseEdgeCounts: otpCauses,
    },
    condition3DetourRatio: {
      ours: summarize(oursDetours),
      otp: summarize(otpDetours),
    },
    condition4Latency: {
      decidable: false,
      reason:
        "different measurement planes: ours is an in-process CSR search core call (currently h=0 Dijkstra-equivalent), OTP is end-to-end HTTP + GraphQL. Spec §6 forbids deciding condition 4 on these numbers; pre-h=0 proxy-A* latency is historical only.",
      oursCoreMs: summarize(oursLatency),
      otpEndToEndMs: summarize(otpLatency),
    },
    outcomes,
  };
}

/**
 * @param outcomes Per-OD results.
 * @param engine Which engine's detour ratios to collect.
 * @returns Finite detour ratios.
 */
function collectDetours(
  outcomes: PairOutcome[],
  engine: "ours" | "otp",
): number[] {
  const ratios: number[] = [];
  for (const item of outcomes) {
    const side = engine === "ours" ? item.ours : item.otp;
    if (side.status !== "ok") continue;
    const ratio = side.detourRatio;
    if (ratio !== null && Number.isFinite(ratio)) ratios.push(ratio);
  }
  return ratios;
}

/**
 * @param report Built evidence document.
 * @returns Nothing.
 */
function printSummary(report: Record<string, unknown>): void {
  const coverage = report.coverage as Record<string, number>;
  const condition1 = report.condition1SilentViolationRate as {
    value: { numerator: number; denominator: number; percent: number | null };
  };
  const condition2 = report.condition2ViolationRate as {
    ours: { numerator: number; denominator: number; percent: number | null };
    otp: { numerator: number; denominator: number; percent: number | null };
  };
  const condition3 = report.condition3DetourRatio as {
    ours: NumberSummary;
    otp: NumberSummary;
  };
  const condition4 = report.condition4Latency as {
    oursCoreMs: NumberSummary;
    otpEndToEndMs: NumberSummary;
  };
  const mapping = report.mappingQuality as {
    excludedRoutes: number;
    mappedVsReportedDistanceRatio: NumberSummary;
  };
  console.log(
    `[otp-comparison] coverage sampled=${coverage.sampled} both=${coverage.bothRouted} ` +
      `only_ours=${coverage.onlyOurs} only_otp=${coverage.onlyOtp} neither=${coverage.neitherRouted} ` +
      `otp_errors=${coverage.otpErrors}`,
  );
  console.log(
    `[otp-comparison] mapping excluded=${mapping.excludedRoutes} ` +
      `mapped_vs_reported_p50=${mapping.mappedVsReportedDistanceRatio.p50?.toFixed(4) ?? "n/a"}`,
  );
  console.log(
    `[otp-comparison] condition1 silent=${condition1.value.numerator}/${condition1.value.denominator} ` +
      `(${condition1.value.percent?.toFixed(3) ?? "n/a"}%)`,
  );
  console.log(
    `[otp-comparison] condition2 ours=${condition2.ours.numerator}/${condition2.ours.denominator} ` +
      `(${condition2.ours.percent?.toFixed(3) ?? "n/a"}%) ` +
      `otp=${condition2.otp.numerator}/${condition2.otp.denominator} ` +
      `(${condition2.otp.percent?.toFixed(3) ?? "n/a"}%)`,
  );
  console.log(
    `[otp-comparison] condition3 detour_p50 ours=${condition3.ours.p50?.toFixed(5) ?? "n/a"} ` +
      `otp=${condition3.otp.p50?.toFixed(5) ?? "n/a"}`,
  );
  console.log(
    `[otp-comparison] condition4 NOT DECIDABLE ours_core_p95=${condition4.oursCoreMs.p95?.toFixed(3) ?? "n/a"}ms ` +
      `otp_e2e_p95=${condition4.otpEndToEndMs.p95?.toFixed(3) ?? "n/a"}ms`,
  );
}

// Guarded so the pure argument parser can be imported by its test without the
// bench connecting to PostGIS and OTP on import.
if (typeof require !== "undefined" && require.main === module) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
