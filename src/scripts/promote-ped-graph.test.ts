import { describe, expect, it } from "vitest";
import {
  parsePromotionArgs,
  promotePedGraph,
  type PedGraphPromotionClient,
} from "./promote-ped-graph";

type Row = Record<string, unknown>;

const VALID_SOURCE_HASH = "a".repeat(64);

interface QueryCall {
  params: unknown[] | undefined;
  sql: string;
}

function notes(): string {
  return JSON.stringify({
    outdoor_node_count: 2,
    indoor_node_count: 1,
    connector_node_count: 1,
    node_count: 4,
    outdoor_directed_edge_count: 1,
    indoor_directed_edge_count: 1,
    connector_edge_count: 1,
    directed_edge_count: 3,
  });
}

function targetRow(overrides: Row = {}): Row {
  return {
    id: 2,
    lifecycle_status: "CANDIDATE",
    node_count: 4,
    directed_edge_count: 3,
    indoor_injection_complete: true,
    source_hash: VALID_SOURCE_HASH,
    notes: notes(),
    ...overrides,
  };
}

function integrityRow(overrides: Row = {}): Row {
  return {
    actual_node_count: 4,
    actual_directed_edge_count: 3,
    invalid_node_coordinate_count: 0,
    invalid_station_radius_count: 0,
    invalid_node_type_count: 0,
    invalid_edge_length_count: 0,
    invalid_edge_slope_count: 0,
    invalid_edge_width_count: 0,
    invalid_edge_traversal_time_count: 0,
    invalid_edge_stair_count: 0,
    invalid_edge_type_count: 0,
    invalid_edge_surface_count: 0,
    invalid_edge_smoothness_count: 0,
    invalid_edge_wheelchair_count: 0,
    invalid_edge_boolean_count: 0,
    unpaired_bidirectional_self_loop_count: 0,
    outdoor_node_count: 2,
    indoor_node_count: 1,
    connector_node_count: 1,
    generated_node_count: 2,
    outdoor_edge_count: 1,
    indoor_edge_count: 1,
    connector_edge_count: 1,
    generated_edge_count: 2,
    loader_indoor_edge_count: 2,
    generated_stop_node_loader_mismatch_count: 0,
    generated_connector_node_loader_mismatch_count: 0,
    generated_pathway_edge_loader_mismatch_count: 0,
    generated_connector_edge_loader_mismatch_count: 0,
    generated_pathway_endpoint_mismatch_count: 0,
    generated_connector_endpoint_mismatch_count: 0,
    outdoor_node_loader_mismatch_count: 0,
    outdoor_edge_loader_mismatch_count: 0,
    missing_node_source_ref_count: 0,
    missing_edge_source_ref_count: 0,
    missing_from_node_count: 0,
    missing_to_node_count: 0,
    cross_version_from_node_count: 0,
    cross_version_to_node_count: 0,
    invalid_generated_node_metadata_count: 0,
    invalid_generated_edge_metadata_count: 0,
    unknown_generated_node_source_count: 0,
    unknown_generated_edge_source_count: 0,
    routable_outdoor_real_geometry_node_count: 2,
    routable_outdoor_real_geometry_edge_count: 1,
    ...overrides,
  };
}

class FakePromotionClient implements PedGraphPromotionClient {
  readonly calls: QueryCall[] = [];

  constructor(
    private readonly target: Row = targetRow(),
    private readonly integrity: Row = integrityRow(),
  ) {}

  async query(
    sql: string,
    params?: unknown[],
  ): Promise<{ rowCount: number | null; rows: Row[] }> {
    this.calls.push({ sql, params });
    if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK") {
      return { rows: [], rowCount: null };
    }
    if (sql.includes("pg_advisory_xact_lock")) {
      return { rows: [], rowCount: 1 };
    }
    if (sql.includes("LOCK TABLE ped_node, ped_edge IN SHARE MODE")) {
      return { rows: [], rowCount: null };
    }
    if (
      sql.includes("WHERE id = $1 OR lifecycle_status = 'ACTIVE'") &&
      sql.includes("ORDER BY id ASC") &&
      sql.includes("FOR UPDATE")
    ) {
      const rows = [
        ...(this.target.lifecycle_status === "ACTIVE"
          ? []
          : [{ id: 1, lifecycle_status: "ACTIVE" }]),
        this.target,
      ].sort((left, right) => Number(left.id) - Number(right.id));
      return { rows, rowCount: rows.length };
    }
    if (sql.includes("target_version AS")) {
      return { rows: [this.integrity], rowCount: 1 };
    }
    if (sql.includes("SET lifecycle_status = 'RETIRED'")) {
      return { rows: [], rowCount: 1 };
    }
    if (sql.includes("SET lifecycle_status = 'ACTIVE'")) {
      return { rows: [], rowCount: 1 };
    }
    if (sql.includes("active_count")) {
      return { rows: [{ active_count: 1 }], rowCount: 1 };
    }
    throw new Error(`unexpected query: ${sql}`);
  }
}

function callIndex(calls: QueryCall[], fragment: string): number {
  return calls.findIndex((call) => call.sql.includes(fragment));
}

describe("promotePedGraph", () => {
  it("requires an explicit version and rollback opt-in at the CLI boundary", () => {
    expect(
      parsePromotionArgs([
        "--version-id",
        "2",
        "--db-url",
        "postgresql://example.test/ped_graph",
        "--allow-retired",
      ]),
    ).toEqual({
      versionId: 2,
      dbUrl: "postgresql://example.test/ped_graph",
      allowRetired: true,
    });
    expect(() =>
      parsePromotionArgs(["--db-url", "postgresql://example.test/ped_graph"]),
    ).toThrow("--version-id is required");
  });

  it("locks lifecycle rows before child tables, then validates integrity before retiring the old active version", async () => {
    const client = new FakePromotionClient();

    await expect(
      promotePedGraph(client, { versionId: 2, allowRetired: false }),
    ).resolves.toEqual({
      activeVersionId: 2,
      outcome: "activated",
      previousActiveVersionId: 1,
    });

    const begin = callIndex(client.calls, "BEGIN");
    const lock = callIndex(client.calls, "pg_advisory_xact_lock");
    const childTableLock = callIndex(
      client.calls,
      "LOCK TABLE ped_node, ped_edge IN SHARE MODE",
    );
    const target = callIndex(client.calls, "source_hash");
    const integrity = callIndex(client.calls, "target_version AS");
    const retire = callIndex(client.calls, "SET lifecycle_status = 'RETIRED'");
    const activate = callIndex(client.calls, "SET lifecycle_status = 'ACTIVE'");
    const verify = callIndex(client.calls, "active_count");
    const commit = callIndex(client.calls, "COMMIT");
    expect(begin).toBeGreaterThanOrEqual(0);
    expect(lock).toBeGreaterThan(begin);
    expect(target).toBeGreaterThan(lock);
    expect(childTableLock).toBeGreaterThan(target);
    expect(integrity).toBeGreaterThan(childTableLock);
    expect(client.calls[integrity]?.params).toEqual([2]);
    expect(client.calls[integrity]?.sql).toContain("loader_indoor_edge_count");
    expect(client.calls[integrity]?.sql).toContain(
      "starts_with(edge.source_ref, 'gtfs_pathways:connector-edge:')",
    );
    expect(client.calls[integrity]?.sql).not.toContain(
      "edge.geom IS NULL\n            OR edge.edge_type IS DISTINCT FROM 2",
    );
    expect(retire).toBeGreaterThan(integrity);
    expect(activate).toBeGreaterThan(retire);
    expect(verify).toBeGreaterThan(activate);
    expect(commit).toBeGreaterThan(verify);
  });

  it("rolls back a matching-count corrupt candidate before lifecycle status writes", async () => {
    const client = new FakePromotionClient(
      targetRow(),
      integrityRow({ cross_version_to_node_count: 1 }),
    );

    await expect(
      promotePedGraph(client, { versionId: 2, allowRetired: false }),
    ).rejects.toThrow("cross-version to_node");

    expect(callIndex(client.calls, "ROLLBACK")).toBeGreaterThanOrEqual(0);
    expect(callIndex(client.calls, "SET lifecycle_status")).toBe(-1);
    expect(callIndex(client.calls, "COMMIT")).toBe(-1);
  });

  it("rolls back a candidate with a malformed fare-gate pathway endpoint before status writes", async () => {
    // The promotion SQL counts missing/blank/mismatched station identity on
    // every GTFS pathway endpoint, which includes fare and exit gate edges.
    const client = new FakePromotionClient(
      targetRow(),
      integrityRow({ generated_pathway_endpoint_mismatch_count: 1 }),
    );

    await expect(
      promotePedGraph(client, { versionId: 2, allowRetired: false }),
    ).rejects.toThrow("generated pathway edges with incompatible endpoints");

    expect(callIndex(client.calls, "ROLLBACK")).toBeGreaterThanOrEqual(0);
    expect(callIndex(client.calls, "SET lifecycle_status")).toBe(-1);
    expect(callIndex(client.calls, "COMMIT")).toBe(-1);
  });

  it("rolls back matching-count candidates with loader-invalid numeric aggregates", async () => {
    for (const [integrity, expectedError] of [
      [{ invalid_edge_stair_count: 1 }, "edges with invalid stair_count"],
      [
        { invalid_station_radius_count: 1 },
        "nodes with invalid station_radius_m",
      ],
    ] as const) {
      const client = new FakePromotionClient(
        targetRow(),
        integrityRow(integrity),
      );

      await expect(
        promotePedGraph(client, { versionId: 2, allowRetired: false }),
      ).rejects.toThrow(expectedError);

      expect(callIndex(client.calls, "ROLLBACK")).toBeGreaterThanOrEqual(0);
      expect(callIndex(client.calls, "SET lifecycle_status")).toBe(-1);
      expect(callIndex(client.calls, "COMMIT")).toBe(-1);
    }
  });

  it("rolls back without status writes when target readiness validation fails", async () => {
    const client = new FakePromotionClient(
      targetRow({ indoor_injection_complete: false }),
    );

    await expect(
      promotePedGraph(client, { versionId: 2, allowRetired: false }),
    ).rejects.toThrow("indoor injection is not complete");

    expect(callIndex(client.calls, "ROLLBACK")).toBeGreaterThanOrEqual(0);
    expect(callIndex(client.calls, "SET lifecycle_status")).toBe(-1);
    expect(callIndex(client.calls, "COMMIT")).toBe(-1);
  });

  it("commits an already-active target without rewriting lifecycle statuses", async () => {
    const client = new FakePromotionClient(
      targetRow({ id: 1, lifecycle_status: "ACTIVE" }),
    );

    await expect(
      promotePedGraph(client, { versionId: 1, allowRetired: false }),
    ).resolves.toEqual({
      activeVersionId: 1,
      outcome: "already-active",
      previousActiveVersionId: 1,
    });

    expect(callIndex(client.calls, "SET lifecycle_status")).toBe(-1);
    expect(callIndex(client.calls, "COMMIT")).toBeGreaterThanOrEqual(0);
  });
});
