import { describe, expect, it } from "vitest";
import { EDGE_FLAG, EDGE_TYPE, NODE_FLAG, type PedGraph } from "./graph.types";
import {
  canTraverseFareGate,
  createTransitAuthorizedFareAccess,
} from "./fare-access";
import { loadPedGraph, type PedGraphQueryable } from "./graph-loader";

type FakeRow = Record<string, unknown>;

interface GraphFixture {
  versions: FakeRow[];
  nodes: FakeRow[];
  edges: FakeRow[];
}

interface QueryCall {
  sql: string;
  params: unknown[] | undefined;
}

function sortableBigint(row: FakeRow, field: string): bigint {
  return BigInt(String(row[field]));
}

function keysetPage(
  rows: FakeRow[],
  cursor: unknown,
  limit: unknown,
  field: string,
): FakeRow[] {
  const after = BigInt(String(cursor));
  const pageSize = Number(limit);
  return [...rows]
    .sort((left, right) => {
      const leftId = sortableBigint(left, field);
      const rightId = sortableBigint(right, field);
      return leftId < rightId ? -1 : leftId > rightId ? 1 : 0;
    })
    .filter((row) => sortableBigint(row, field) > after)
    .slice(0, pageSize);
}

function createQueryable(fixture: GraphFixture): {
  client: PedGraphQueryable;
  calls: QueryCall[];
} {
  const calls: QueryCall[] = [];
  const client: PedGraphQueryable = {
    async query<R>(sql: string, params?: unknown[]): Promise<{ rows: R[] }> {
      calls.push({ sql, params });
      if (sql.includes("FROM ped_graph_version")) {
        if (sql.includes("WHERE lifecycle_status = 'ACTIVE'")) {
          return {
            rows: fixture.versions.filter(
              (row) => row.lifecycle_status === "ACTIVE",
            ) as R[],
          };
        }
        return {
          rows: fixture.versions.filter((row) => row.id === params?.[0]) as R[],
        };
      }
      if (sql.includes("FROM ped_node")) {
        return {
          rows: keysetPage(
            fixture.nodes,
            params?.[1],
            params?.[2],
            "node_id",
          ) as R[],
        };
      }
      if (sql.includes("FROM ped_edge")) {
        return {
          rows: keysetPage(
            fixture.edges,
            params?.[1],
            params?.[2],
            "edge_id",
          ) as R[],
        };
      }
      throw new Error("unexpected query");
    },
  };
  return { client, calls };
}

function coreFixture(): GraphFixture {
  return {
    versions: [
      {
        id: 7,
        lifecycle_status: "ACTIVE",
        node_count: 4,
        directed_edge_count: 3,
      },
    ],
    nodes: [
      {
        node_id: "1003992167379",
        lon: 121.5,
        lat: 25.05,
        station_id: null,
        station_radius_m: null,
        node_type: 1,
        has_real_geom: true,
      },
      {
        node_id: "1003992167380",
        lon: 121.501,
        lat: 25.05,
        station_id: null,
        station_radius_m: null,
        node_type: 4,
        has_real_geom: true,
      },
      {
        node_id: "1003992167381",
        lon: 121.502,
        lat: 25.05,
        station_id: "station-a",
        station_radius_m: 30,
        node_type: 7,
        has_real_geom: false,
      },
      {
        node_id: "1003992167382",
        lon: 121.502,
        lat: 25.05,
        station_id: "station-a",
        station_radius_m: 50,
        node_type: 11,
        has_real_geom: false,
      },
    ],
    edges: [
      {
        edge_id: "2000000000001",
        from_node: "1003992167379",
        to_node: "1003992167380",
        is_bidirectional: true,
        length_m: 10,
        edge_type: 1,
        slope_longitudinal: null,
        surface: null,
        smoothness: null,
        width_m: null,
        wheelchair: null,
        stair_count: null,
        traversal_time_s: null,
        has_ramp: false,
        is_indoor: false,
        source_ref: "osm:way/outdoor-forward",
      },
      {
        edge_id: "2000000000002",
        from_node: "1003992167380",
        to_node: "1003992167379",
        is_bidirectional: true,
        length_m: 12,
        edge_type: 1,
        slope_longitudinal: 0,
        surface: 2,
        smoothness: 1,
        width_m: 0,
        wheelchair: 1,
        stair_count: 0,
        traversal_time_s: null,
        has_ramp: true,
        is_indoor: false,
        source_ref: "osm:way/outdoor-reverse",
      },
      {
        edge_id: "2000000000003",
        from_node: "1003992167381",
        to_node: "1003992167382",
        is_bidirectional: false,
        length_m: null,
        edge_type: 20,
        slope_longitudinal: null,
        surface: null,
        smoothness: null,
        width_m: null,
        wheelchair: null,
        stair_count: 8,
        traversal_time_s: 30,
        has_ramp: false,
        is_indoor: true,
        source_ref: "gtfs_pathways:pathway:station-a:forward",
      },
    ],
  };
}

function expectCoreGraph(graph: PedGraph): void {
  expect(graph.versionId).toBe(7);
  expect(graph.nodeCount).toBe(4);
  expect(graph.directedEdgeCount).toBe(3);
  expect(graph.undirectedEdgeCount).toBe(2);
  expect(Array.from(graph.originalNodeId)).toEqual([
    1003992167379n,
    1003992167380n,
    1003992167381n,
    1003992167382n,
  ]);
  expect(Array.from(graph.nodeStationId)).toEqual([-1, -1, 0, 0]);
  expect(graph.stationIds).toEqual(["station-a"]);
  expect(Object.isFrozen(graph.stationIds)).toBe(true);
  expect(Array.from(graph.stationRadiusM)).toEqual([50]);
  expect(Array.from(graph.nodeFlags)).toEqual([
    NODE_FLAG.HAS_REAL_GEOM,
    NODE_FLAG.HAS_REAL_GEOM | NODE_FLAG.ENTRANCE,
    NODE_FLAG.INDOOR,
    NODE_FLAG.INDOOR | NODE_FLAG.ENTRANCE,
  ]);
  expect(Array.from(graph.adjOffset)).toEqual([0, 1, 2, 3, 3]);
  expect(Array.from(graph.adjTarget)).toEqual([1, 0, 3]);
  expect(Array.from(graph.adjAttr)).toEqual([0, 1, 2]);
  expect(Array.from(graph.edgeOriginalId)).toEqual([
    2000000000001n,
    2000000000002n,
    2000000000003n,
  ]);
  expect(graph.edgeLengthM[0]).toBe(10);
  expect(Number.isNaN(graph.edgeLengthM[2])).toBe(true);
  expect(Number.isNaN(graph.edgeSlope[0])).toBe(true);
  expect(graph.edgeSlope[1]).toBe(0);
  expect(Number.isNaN(graph.edgeWidthM[0])).toBe(true);
  expect(graph.edgeWidthM[1]).toBe(0);
  expect(Number.isNaN(graph.edgeTraversalTimeS[0])).toBe(true);
  expect(graph.edgeTraversalTimeS[2]).toBe(30);
  expect(Array.from(graph.edgeSurface)).toEqual([0, 2, 0]);
  expect(Array.from(graph.edgeWheelchair)).toEqual([0, 1, 0]);
  expect(Array.from(graph.edgeStairCount)).toEqual([0, 0, 8]);
  expect(Array.from(graph.edgeFlags)).toEqual([
    0,
    EDGE_FLAG.HAS_RAMP,
    EDGE_FLAG.INDOOR,
  ]);
}

describe("loadPedGraph", () => {
  it("loads only the active version into dense CSR storage when omitted", async () => {
    const fixture = coreFixture();
    fixture.versions.unshift({
      id: 8,
      lifecycle_status: "CANDIDATE",
      node_count: 4,
      directed_edge_count: 3,
    });
    const { client, calls } = createQueryable(fixture);

    const graph = await loadPedGraph(client);

    expectCoreGraph(graph);
    expect(calls[0].sql).toContain("WHERE lifecycle_status = 'ACTIVE'");
    expect(calls[0].params).toBeUndefined();
  });

  it("classifies indoor proxy eligibility from generated GTFS provenance, not null geometry", async () => {
    const fixture = coreFixture();
    // This value simulates the old `geom IS NULL AS is_indoor` query result.
    // The OSM edge must still stay outdoor even when a stored geometry is absent.
    fixture.edges[0].is_indoor = true;
    fixture.edges[0].source_ref = "osm:way/geometry-absent";
    // Connector edges are normally real LineStrings, but their actual injector
    // provenance remains proxy-eligible if one legitimately lacks geometry.
    fixture.edges[2].is_indoor = false;
    fixture.edges[2].edge_type = EDGE_TYPE.FOOTWAY;
    fixture.edges[2].source_ref =
      "gtfs_pathways:connector-edge:entrance-a:entrance-forward";
    const { client, calls } = createQueryable(fixture);

    const graph = await loadPedGraph(client);

    expect(Array.from(graph.edgeFlags)).toEqual([
      0,
      EDGE_FLAG.HAS_RAMP,
      EDGE_FLAG.INDOOR,
    ]);
    const attributeQuery = calls.find(
      (call) =>
        call.sql.includes("FROM ped_edge") && call.sql.includes("surface"),
    );
    expect(attributeQuery?.sql).toContain("source_ref");
    expect(attributeQuery?.sql).not.toContain("geom IS NULL AS is_indoor");
  });

  it("loads an explicitly requested candidate version for diagnosis", async () => {
    const fixture = coreFixture();
    fixture.versions.unshift({
      id: 8,
      lifecycle_status: "CANDIDATE",
      node_count: 4,
      directed_edge_count: 3,
    });
    const { client, calls } = createQueryable(fixture);

    const graph = await loadPedGraph(client, 8);

    expect(graph.versionId).toBe(8);
    expect(calls[0].sql).toContain("WHERE id = $1");
    expect(calls[0].params).toEqual([8]);
  });

  it("fails closed when no active version exists", async () => {
    const fixture = coreFixture();
    fixture.versions[0].lifecycle_status = "CANDIDATE";

    await expect(loadPedGraph(createQueryable(fixture).client)).rejects.toThrow(
      "pedestrian graph version was not found",
    );
  });

  it("round-trips stable station IDs in dense-index order deterministically", async () => {
    const nodes = [
      {
        node_id: "30",
        lon: 121.003,
        lat: 25,
        station_id: "station-b",
        station_radius_m: 10,
        node_type: 8,
        has_real_geom: false,
      },
      {
        node_id: "10",
        lon: 121.001,
        lat: 25,
        station_id: "station-a",
        station_radius_m: 20,
        node_type: 8,
        has_real_geom: false,
      },
      {
        node_id: "20",
        lon: 121.002,
        lat: 25,
        station_id: "station-a",
        station_radius_m: 25,
        node_type: 9,
        has_real_geom: false,
      },
    ];
    const createFixture = (fixtureNodes: FakeRow[]): GraphFixture => ({
      versions: [
        {
          id: 12,
          lifecycle_status: "ACTIVE",
          node_count: fixtureNodes.length,
          directed_edge_count: 0,
        },
      ],
      nodes: fixtureNodes,
      edges: [],
    });

    const first = await loadPedGraph(
      createQueryable(createFixture(nodes)).client,
    );
    const second = await loadPedGraph(
      createQueryable(createFixture([...nodes].reverse())).client,
    );

    for (const graph of [first, second]) {
      expect(Array.from(graph.nodeStationId)).toEqual([0, 0, 1]);
      expect(graph.stationIds).toEqual(["station-a", "station-b"]);
      expect(Object.isFrozen(graph.stationIds)).toBe(true);
      expect(Array.from(graph.stationRadiusM)).toEqual([25, 10]);
    }
  });

  it("keeps malformed gate station identity fail-closed after CSR loading", async () => {
    const malformedFixtures: readonly {
      name: string;
      configure: (fixture: GraphFixture) => void;
    }[] = [
      {
        name: "missing station identity",
        configure: (fixture) => {
          fixture.nodes[2].station_id = null;
        },
      },
      {
        name: "mismatched station identity",
        configure: (fixture) => {
          fixture.nodes[3].station_id = "station-b";
        },
      },
    ];

    for (const malformed of malformedFixtures) {
      const fixture = coreFixture();
      fixture.edges[2].edge_type = EDGE_TYPE.INDOOR_FARE_GATE;
      malformed.configure(fixture);

      const graph = await loadPedGraph(createQueryable(fixture).client);
      const allowKnownStations = createTransitAuthorizedFareAccess([
        "station-a",
        "station-b",
      ]);

      expect(
        canTraverseFareGate(graph, 2, 3, 2, allowKnownStations),
        malformed.name,
      ).toBe(false);
    }
  });

  it("keeps distinct original edge IDs for parallel edges sharing endpoints", async () => {
    const fixture = coreFixture();
    fixture.versions[0].directed_edge_count = 4;
    fixture.edges.push({
      ...fixture.edges[0],
      edge_id: "2000000000004",
      length_m: 41,
    });
    const { client } = createQueryable(fixture);

    const graph = await loadPedGraph(client);

    // Both 0 -> 1 edges live in node 0's adjacency range and must stay
    // separately addressable back to their own ped_edge rows.
    const slots = Array.from(
      { length: graph.adjOffset[1] - graph.adjOffset[0] },
      (_, offset) => graph.adjAttr[graph.adjOffset[0] + offset],
    );
    expect(slots).toHaveLength(2);
    expect(slots.map((attrIdx) => graph.adjTarget[attrIdx])).toBeDefined();
    expect(slots.map((attrIdx) => graph.edgeOriginalId[attrIdx])).toEqual([
      2000000000001n,
      2000000000004n,
    ]);
    expect(slots.map((attrIdx) => graph.edgeLengthM[attrIdx])).toEqual([
      10, 41,
    ]);
    expect(new Set(Array.from(graph.edgeOriginalId)).size).toBe(4);
  });

  it("counts a bidirectional self-loop as one physical edge", async () => {
    const selfLoop = (edgeId: string) => ({
      edge_id: edgeId,
      from_node: "1",
      to_node: "1",
      is_bidirectional: true,
      length_m: 12,
      edge_type: 2,
      slope_longitudinal: null,
      surface: null,
      smoothness: null,
      width_m: null,
      wheelchair: null,
      stair_count: null,
      traversal_time_s: null,
      has_ramp: false,
      is_indoor: false,
    });
    const { client } = createQueryable({
      versions: [
        {
          id: 11,
          lifecycle_status: "ACTIVE",
          node_count: 1,
          directed_edge_count: 2,
        },
      ],
      nodes: [
        {
          node_id: "1",
          lon: 121,
          lat: 25,
          station_id: null,
          station_radius_m: null,
          node_type: 1,
          has_real_geom: true,
        },
      ],
      edges: [selfLoop("1"), selfLoop("2")],
    });

    const graph = await loadPedGraph(client);

    expect(graph.directedEdgeCount).toBe(2);
    expect(graph.undirectedEdgeCount).toBe(1);
  });

  it("continues keyset node pages without materializing a node table", async () => {
    const nodes = Array.from({ length: 10_001 }, (_, index) => ({
      node_id: String(index + 1),
      lon: 121 + index / 1_000_000,
      lat: 25,
      station_id: null,
      station_radius_m: null,
      node_type: 1,
      has_real_geom: true,
    }));
    const { client, calls } = createQueryable({
      versions: [
        {
          id: 9,
          lifecycle_status: "ACTIVE",
          node_count: nodes.length,
          directed_edge_count: 0,
        },
      ],
      nodes,
      edges: [],
    });

    const graph = await loadPedGraph(client);

    expect(graph.nodeCount).toBe(10_001);
    expect(graph.originalNodeId[10_000]).toBe(10001n);
    expect(
      calls.filter((call) => call.sql.includes("FROM ped_node")),
    ).toHaveLength(2);
  });

  it("continues both edge passes with stable CSR counts", async () => {
    const edges = Array.from({ length: 10_001 }, (_, index) => ({
      edge_id: String(index + 1),
      from_node: "1",
      to_node: "2",
      is_bidirectional: false,
      length_m: 1,
      edge_type: 1,
      slope_longitudinal: 0,
      surface: 1,
      smoothness: 1,
      width_m: 1,
      wheelchair: 1,
      stair_count: 0,
      traversal_time_s: null,
      has_ramp: false,
      is_indoor: false,
    }));
    const { client, calls } = createQueryable({
      versions: [
        {
          id: 10,
          lifecycle_status: "ACTIVE",
          node_count: 2,
          directed_edge_count: edges.length,
        },
      ],
      nodes: [
        {
          node_id: "1",
          lon: 121,
          lat: 25,
          station_id: null,
          station_radius_m: null,
          node_type: 1,
          has_real_geom: true,
        },
        {
          node_id: "2",
          lon: 121.001,
          lat: 25,
          station_id: null,
          station_radius_m: null,
          node_type: 1,
          has_real_geom: true,
        },
      ],
      edges,
    });

    const graph = await loadPedGraph(client);

    expect(graph.undirectedEdgeCount).toBe(10_001);
    expect(Array.from(graph.adjOffset)).toEqual([0, 10_001, 10_001]);
    expect(
      calls.filter((call) => call.sql.includes("FROM ped_edge")),
    ).toHaveLength(4);
  });

  it("reads width from the net usable column without falling back to gross width", async () => {
    const { client, calls } = createQueryable(coreFixture());

    await loadPedGraph(client);

    const attributeQuery = calls.find(
      (call) =>
        call.sql.includes("FROM ped_edge") && call.sql.includes("surface"),
    );
    expect(attributeQuery?.sql).toContain("effective_width_m AS width_m");
    expect(attributeQuery?.sql).not.toContain("COALESCE");
  });

  it("fails when the version record and node stream disagree", async () => {
    const fixture = coreFixture();
    fixture.versions = [
      {
        id: 7,
        lifecycle_status: "ACTIVE",
        node_count: 5,
        directed_edge_count: 3,
      },
    ];

    await expect(loadPedGraph(createQueryable(fixture).client)).rejects.toThrow(
      "fewer nodes",
    );
  });
});
