import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { buildEdgeIndex, snapToGraph } from "./spatial-index";
import { loadPedGraph } from "./graph-loader";

const databaseUrl = process.env.PED_GRAPH_DATABASE_URL;

describe.skipIf(!databaseUrl)("PostGIS pedestrian graph loader", () => {
  let pool: Pool;

  beforeAll(() => {
    pool = new Pool({ connectionString: databaseUrl ?? "" });
  });

  afterAll(async () => {
    await pool.end();
  });

  it("loads version 1 with its recorded counts, heap delta, and sampled snapping", async () => {
    const collect = (global as { gc?: () => void }).gc;
    collect?.();
    const beforeHeap = process.memoryUsage().heapUsed;
    const graph = await loadPedGraph(pool, 1);
    collect?.();
    const afterHeap = process.memoryUsage().heapUsed;
    const versionResult = await pool.query<{
      node_count: number;
      directed_edge_count: number;
      notes: string;
    }>(
      "SELECT node_count, directed_edge_count, notes FROM ped_graph_version WHERE id = $1",
      [1],
    );
    const version = versionResult.rows[0];
    if (version === undefined) {
      throw new Error("version 1 disappeared during integration test");
    }
    const sampleResult = await pool.query<{
      from_node: string;
      to_node: string;
      lon: number;
      lat: number;
    }>(
      `
        SELECT
          from_node::text AS from_node,
          to_node::text AS to_node,
          ST_X(ST_StartPoint(geom)) AS lon,
          ST_Y(ST_StartPoint(geom)) AS lat
        FROM ped_edge
        WHERE version_id = $1
          AND geom IS NOT NULL
          AND from_node < to_node
        ORDER BY edge_id
        LIMIT 100
      `,
      [1],
    );
    const index = buildEdgeIndex(graph);
    const failures = sampleResult.rows.filter(
      (sample) => snapToGraph(index, sample.lat, sample.lon, 50) === null,
    ).length;
    const firstSample = sampleResult.rows[0];
    if (firstSample === undefined) {
      throw new Error("version 1 has no outdoor edge sample");
    }
    const firstSnap = snapToGraph(index, firstSample.lat, firstSample.lon, 50);
    if (firstSnap === null) {
      throw new Error(
        "first sampled outdoor edge did not snap within 50 metres",
      );
    }
    const arrayBytes = Object.values(graph)
      .filter(
        (field): field is ArrayBufferView =>
          typeof field === "object" && field !== null && "byteLength" in field,
      )
      .reduce((total, field) => total + field.byteLength, 0);
    const arrayMb = arrayBytes / (1024 * 1024);
    const heapDeltaMb = (afterHeap - beforeHeap) / (1024 * 1024);
    const residentMb = Math.max(arrayMb, heapDeltaMb);
    const sixCitySteadyMb = residentMb * 4.1;
    const sixCityPeakMb = sixCitySteadyMb * 2;

    console.info(
      `[pedestrian-a11y] nodes=${graph.nodeCount} directed=${graph.directedEdgeCount} undirected=${graph.undirectedEdgeCount} typed_array_mb=${arrayMb.toFixed(2)} heap_delta_mb=${heapDeltaMb.toFixed(2)} bytes_per_directed_edge=${(arrayBytes / graph.directedEdgeCount).toFixed(1)} six_city_steady_mb=${sixCitySteadyMb.toFixed(2)} six_city_peak_mb=${sixCityPeakMb.toFixed(2)} snap_failures_50m=${failures}/${sampleResult.rows.length}`,
    );
    expect(graph.nodeCount).toBe(version.node_count);
    expect(graph.directedEdgeCount).toBe(version.directed_edge_count);
    const notes = JSON.parse(version.notes) as Record<string, number>;
    expect(graph.nodeCount).toBe(165_432);
    expect(graph.directedEdgeCount).toBe(453_144);
    expect(graph.undirectedEdgeCount).toBe(226_842);
    expect(notes.outdoor_node_count).toBe(161_368);
    expect(notes.indoor_node_count).toBe(3_689);
    expect(notes.connector_node_count).toBe(375);
    expect(notes.outdoor_directed_edge_count).toBe(441_456);
    expect(notes.indoor_directed_edge_count).toBe(9_438);
    expect(notes.connector_edge_count).toBe(2_250);
    expect([
      graph.originalNodeId.indexOf(BigInt(firstSample.from_node)),
      graph.originalNodeId.indexOf(BigInt(firstSample.to_node)),
    ]).toContain(firstSnap.nodeId);
  }, 600_000);
});
