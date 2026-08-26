import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { aStar } from "./astar";
import { WHEELCHAIR_WALK_SPEED_MPS, type CostProfile } from "./cost";
import { dijkstra } from "./dijkstra";
import { loadPedGraph } from "./graph-loader";

const databaseUrl = process.env.PED_GRAPH_DATABASE_URL;

/**
 * @param seed Fixed unsigned seed.
 * @returns A deterministic pseudo-random number generator.
 */
function seededRandom(seed: number): () => number {
  let state = seed;
  return () => {
    state += 0x6d2b79f5;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
}

/**
 * @param actual Observed route cost.
 * @param expected Reference route cost.
 * @returns Relative floating-point error using one as the minimum scale.
 */
function relativeError(actual: number, expected: number): number {
  return Math.abs(actual - expected) / Math.max(1, Math.abs(expected));
}

/**
 * @param values Measured counts for all compared OD pairs.
 * @param percentile Percentile in the inclusive zero-to-one range.
 * @returns The nearest-rank percentile value.
 */
function percentile(values: number[], percentileValue: number): number {
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(
    sorted.length - 1,
    Math.floor((sorted.length - 1) * percentileValue),
  );
  return sorted[index];
}

/**
 * @param values Measured counts for all compared OD pairs.
 * @returns A compact minimum, median, p95, and maximum summary.
 */
function distribution(values: number[]): string {
  return `min=${Math.min(...values)} p50=${percentile(values, 0.5)} p95=${percentile(values, 0.95)} max=${Math.max(...values)}`;
}

/**
 * @returns The wheelchair profile used for all integration OD pairs.
 */
function wheelchairProfile(): CostProfile {
  return {
    name: "wheelchair",
    walkSpeedMps: WHEELCHAIR_WALK_SPEED_MPS,
    relaxationLevel: 0,
  };
}

describe.skipIf(!databaseUrl)("PostGIS A* optimality", () => {
  let pool: Pool;

  beforeAll(() => {
    pool = new Pool({ connectionString: databaseUrl ?? "" });
  });

  afterAll(async () => {
    await pool.end();
  });

  it("matches Dijkstra for 50 fixed-seed reachable OD pairs and reports search distributions", async () => {
    const graph = await loadPedGraph(pool, 1);
    const versionResult = await pool.query<{
      notes: string;
    }>("SELECT notes FROM ped_graph_version WHERE id = $1", [1]);
    const version = versionResult.rows[0];
    if (version === undefined) {
      throw new Error("version 1 disappeared during integration test");
    }
    const notes = JSON.parse(version.notes) as Record<string, number>;
    expect(graph.nodeCount).toBe(165_432);
    expect(graph.directedEdgeCount).toBe(453_144);
    expect(notes.outdoor_node_count).toBe(161_368);
    expect(notes.indoor_node_count).toBe(3_689);
    expect(notes.connector_node_count).toBe(375);
    expect(notes.outdoor_directed_edge_count).toBe(441_456);
    expect(notes.indoor_directed_edge_count).toBe(9_438);
    expect(notes.connector_edge_count).toBe(2_250);
    const random = seededRandom(20_260_824);
    const expandedNodes: number[] = [];
    const reopenedNodes: number[] = [];
    let comparedPairs = 0;
    let attempts = 0;

    while (comparedPairs < 50 && attempts < 500) {
      attempts += 1;
      const from = Math.floor(random() * graph.nodeCount);
      const sampledTo = Math.floor(random() * graph.nodeCount);
      const to =
        sampledTo === from ? (sampledTo + 1) % graph.nodeCount : sampledTo;
      const result = aStar(graph, from, to, wheelchairProfile());
      const reference = dijkstra(graph, from, to, wheelchairProfile());

      expect(result === null).toBe(reference === null);
      if (result === null || reference === null) {
        continue;
      }
      expect(
        relativeError(result.totalCost, reference.totalCost),
      ).toBeLessThanOrEqual(1e-9);
      expandedNodes.push(result.expandedNodes);
      reopenedNodes.push(result.reopenedNodes);
      comparedPairs += 1;
    }

    expect(comparedPairs).toBe(50);
    console.info(
      `[pedestrian-a11y] compared_od_pairs=${comparedPairs} attempts=${attempts} expanded_nodes=${distribution(expandedNodes)} reopened_nodes=${distribution(reopenedNodes)}`,
    );
  }, 1_200_000);
});
