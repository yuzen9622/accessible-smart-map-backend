import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./graph-runtime", () => ({
  getPedGraphRuntime: vi.fn(),
  getPedGraphClient: vi.fn(),
}));

import { planCsrWalkRoute, isTopologyReachable } from "./csr-walk-planner";
import type { PedGraphQueryable } from "./graph-loader";
import { getPedGraphClient, getPedGraphRuntime } from "./graph-runtime";
import {
  EDGE_FLAG,
  EDGE_TYPE,
  NODE_FLAG,
  SURFACE,
  type PedGraph,
} from "./graph.types";
import { buildEdgeIndex } from "./spatial-index";

interface EdgeDefinition {
  from: number;
  to: number;
  lengthM?: number;
  traversalTimeS?: number;
  edgeType?: number;
  flags?: number;
  slopeRatio?: number;
  widthM?: number;
  surface?: number;
}

interface GraphDefinition {
  nodeLon: number[];
  nodeLat: number[];
  edges: EdgeDefinition[];
  nodeFlags?: number[];
  nodeStationId?: number[];
  stationIds?: string[];
  stationRadiusM?: number[];
  versionId?: number;
}

/**
 * Build a CSR graph fixture with neutral attributes by default.
 *
 * Nodes default to `HAS_REAL_GEOM` so they are eligible for the spatial index,
 * which is what makes them snappable endpoints.
 *
 * @param input Dense node coordinates and directed edge definitions.
 * @returns A CSR pedestrian graph.
 */
function graphFromEdges(input: GraphDefinition): PedGraph {
  const nodeCount = input.nodeLon.length;
  const directedEdgeCount = input.edges.length;
  const adjOffset = new Int32Array(nodeCount + 1);
  const adjTarget = new Int32Array(directedEdgeCount);
  const adjAttr = new Int32Array(directedEdgeCount);
  const edgeLengthM = new Float32Array(directedEdgeCount);
  const edgeType = new Uint8Array(directedEdgeCount);
  const edgeSlope = new Float32Array(directedEdgeCount);
  const edgeWidthM = new Float32Array(directedEdgeCount);
  const edgeTraversalTimeS = new Float32Array(directedEdgeCount);
  const edgeFlags = new Uint8Array(directedEdgeCount);
  const edgeSurface = new Uint8Array(directedEdgeCount);
  const nodeStationId = new Int32Array(nodeCount);
  nodeStationId.fill(-1);
  edgeLengthM.fill(Number.NaN);
  edgeSlope.fill(Number.NaN);
  edgeWidthM.fill(Number.NaN);
  edgeTraversalTimeS.fill(Number.NaN);

  for (const edge of input.edges) {
    adjOffset[edge.from + 1] += 1;
  }
  for (let node = 1; node < adjOffset.length; node += 1) {
    adjOffset[node] += adjOffset[node - 1];
  }
  const writeOffset = new Int32Array(nodeCount);
  writeOffset.set(adjOffset.subarray(0, nodeCount));
  for (let attrIdx = 0; attrIdx < input.edges.length; attrIdx += 1) {
    const edge = input.edges[attrIdx];
    const adjacencyIndex = writeOffset[edge.from];
    adjTarget[adjacencyIndex] = edge.to;
    adjAttr[adjacencyIndex] = attrIdx;
    writeOffset[edge.from] += 1;
    edgeLengthM[attrIdx] = edge.lengthM ?? Number.NaN;
    edgeType[attrIdx] = edge.edgeType ?? EDGE_TYPE.SIDEWALK;
    edgeSlope[attrIdx] = edge.slopeRatio ?? Number.NaN;
    edgeWidthM[attrIdx] = edge.widthM ?? Number.NaN;
    edgeTraversalTimeS[attrIdx] = edge.traversalTimeS ?? Number.NaN;
    edgeFlags[attrIdx] = edge.flags ?? 0;
    edgeSurface[attrIdx] = edge.surface ?? SURFACE.UNKNOWN;
  }
  if (input.nodeStationId !== undefined) {
    nodeStationId.set(input.nodeStationId);
  }

  return {
    versionId: input.versionId ?? 7,
    nodeCount,
    directedEdgeCount,
    undirectedEdgeCount: directedEdgeCount,
    nodeLon: Float64Array.from(input.nodeLon),
    nodeLat: Float64Array.from(input.nodeLat),
    nodeFlags: Uint8Array.from(
      input.nodeFlags ?? new Array(nodeCount).fill(NODE_FLAG.HAS_REAL_GEOM),
    ),
    nodeStationId,
    stationIds: Object.freeze([...(input.stationIds ?? [])]),
    stationRadiusM: Float32Array.from(input.stationRadiusM ?? []),
    originalNodeId: BigInt64Array.from(
      Array.from({ length: nodeCount }, (_, node) => BigInt(node)),
    ),
    adjOffset,
    adjTarget,
    adjAttr,
    edgeOriginalId: BigInt64Array.from(
      Array.from({ length: directedEdgeCount }, (_, attrIdx) =>
        BigInt(1_000 + attrIdx),
      ),
    ),
    edgeLengthM,
    edgeType,
    edgeSlope,
    edgeSurface,
    edgeSmoothness: new Uint8Array(directedEdgeCount),
    edgeWidthM,
    edgeWheelchair: new Uint8Array(directedEdgeCount),
    edgeStairCount: new Uint16Array(directedEdgeCount),
    edgeTraversalTimeS,
    edgeFlags,
  };
}

/**
 * @param graph Graph to serve as the ready ACTIVE snapshot.
 * @returns Nothing.
 */
function serveGraph(graph: PedGraph): void {
  vi.mocked(getPedGraphRuntime).mockResolvedValue({
    status: "ready",
    snapshot: { graph, index: buildEdgeIndex(graph), loadedAtMs: 0 },
  });
}

/**
 * Fake PostGIS client returning stored geometry per `ped_edge.edge_id`.
 *
 * Rows are returned in an intentionally shuffled order so the positional
 * alignment in the geometry repository is genuinely exercised rather than
 * accidentally satisfied by input ordering.
 *
 * @param geojsonByEdgeId Stored `ST_AsGeoJSON` text per edge id, or null.
 * @param missingEdgeIds Requested edge ids whose rows should be absent.
 * @returns A queryable client.
 */
function geometryClient(
  geojsonByEdgeId: Record<string, string | null>,
  missingEdgeIds: readonly string[] = [],
): PedGraphQueryable {
  return {
    query: <R>(_sql: string, params?: unknown[]) => {
      const requestedIds = (params?.[1] ?? []) as string[];
      const rows = [...requestedIds]
        .reverse()
        .filter((edgeId) => !missingEdgeIds.includes(edgeId))
        .map((edgeId) => ({
          edge_id: edgeId,
          geojson: geojsonByEdgeId[edgeId] ?? null,
        }));
      return Promise.resolve({ rows: rows as R[] });
    },
  };
}

/**
 * @param coordinates Ordered longitude/latitude pairs.
 * @returns A `ST_AsGeoJSON` LineString payload.
 */
function lineString(coordinates: [number, number][]): string {
  return JSON.stringify({ type: "LineString", coordinates });
}

const TAIPEI_LNG = 121.55;

/** Three collinear nodes about 55 m apart, all inside the Taipei bbox. */
const A_LAT = 25.04;
const B_LAT = 25.0405;
const C_LAT = 25.041;

const originPoint = { lat: A_LAT, lng: TAIPEI_LNG };
const middlePoint = { lat: B_LAT, lng: TAIPEI_LNG };
const destinationPoint = { lat: C_LAT, lng: TAIPEI_LNG };

/**
 * @returns A simple bidirectional 0-1-2 corridor graph.
 */
function corridorGraph(): PedGraph {
  return graphFromEdges({
    nodeLon: [TAIPEI_LNG, TAIPEI_LNG, TAIPEI_LNG],
    nodeLat: [A_LAT, B_LAT, C_LAT],
    edges: [
      { from: 0, to: 1, lengthM: 55, surface: SURFACE.ASPHALT },
      { from: 1, to: 0, lengthM: 55, surface: SURFACE.ASPHALT },
      { from: 1, to: 2, lengthM: 55, surface: SURFACE.ASPHALT },
      { from: 2, to: 1, lengthM: 55, surface: SURFACE.ASPHALT },
    ],
  });
}

/**
 * @param flags Edge flags for both directions.
 * @returns A one-edge graph used to isolate selected-edge geometry handling.
 */
function oneEdgeGraph(flags = 0, indoorTraversalTimeS = 80): PedGraph {
  const isIndoor = (flags & EDGE_FLAG.INDOOR) !== 0;
  return graphFromEdges({
    nodeLon: [TAIPEI_LNG, TAIPEI_LNG],
    nodeLat: [A_LAT, C_LAT],
    edges: isIndoor
      ? [
          {
            from: 0,
            to: 1,
            traversalTimeS: indoorTraversalTimeS,
            edgeType: EDGE_TYPE.INDOOR_WALKWAY,
            flags,
          },
          {
            from: 1,
            to: 0,
            traversalTimeS: indoorTraversalTimeS,
            edgeType: EDGE_TYPE.INDOOR_WALKWAY,
            flags,
          },
        ]
      : [
          { from: 0, to: 1, lengthM: 110, flags },
          { from: 1, to: 0, lengthM: 110, flags },
        ],
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.PED_GRAPH_CSR_WALK_ENABLED = "true";
  vi.mocked(getPedGraphClient).mockResolvedValue(geometryClient({}));
});

afterEach(() => {
  delete process.env.PED_GRAPH_CSR_WALK_ENABLED;
  delete process.env.PED_GRAPH_DATABASE_URL;
});

describe("planCsrWalkRoute coverage and enablement", () => {
  it("skips CSR as outside coverage when a point is outside the Taipei bbox", async () => {
    serveGraph(corridorGraph());

    const result = await planCsrWalkRoute(
      [originPoint, { lat: 24.15, lng: 120.68 }],
      { mode: "normal", avoidStairs: true },
    );

    expect(result).toEqual({ status: "outside_coverage" });
    expect(getPedGraphRuntime).not.toHaveBeenCalled();
  });

  it("skips CSR as outside coverage when the feature flag is disabled", async () => {
    process.env.PED_GRAPH_CSR_WALK_ENABLED = "false";
    serveGraph(corridorGraph());

    const result = await planCsrWalkRoute([originPoint, destinationPoint], {
      mode: "normal",
      avoidStairs: true,
    });

    expect(result).toEqual({ status: "outside_coverage" });
    expect(getPedGraphRuntime).not.toHaveBeenCalled();
  });

  it("keeps OTP primary when a graph database is configured but the flag is absent", async () => {
    delete process.env.PED_GRAPH_CSR_WALK_ENABLED;
    process.env.PED_GRAPH_DATABASE_URL = "postgresql://example.test/ped_graph";
    serveGraph(corridorGraph());

    const result = await planCsrWalkRoute([originPoint, destinationPoint], {
      mode: "normal",
      avoidStairs: true,
    });

    expect(result).toEqual({ status: "outside_coverage" });
    expect(getPedGraphRuntime).not.toHaveBeenCalled();
  });

  it("reports unsupported constraints only after enabled Taipei coverage passes", async () => {
    serveGraph(corridorGraph());

    const result = await planCsrWalkRoute([originPoint, destinationPoint], {
      mode: "normal",
      avoidStairs: true,
    });

    expect(result).toEqual({ status: "unsupported_constraints" });
    expect(getPedGraphRuntime).not.toHaveBeenCalled();
  });

  it("reports unavailable when the runtime graph is not ready", async () => {
    vi.mocked(getPedGraphRuntime).mockResolvedValue({
      status: "unavailable",
      reason: "PED_GRAPH_DATABASE_URL is not configured",
    });

    const result = await planCsrWalkRoute([originPoint, destinationPoint], {
      mode: "wheelchair",
    });

    expect(result).toEqual({
      status: "unavailable",
      reason: "PED_GRAPH_DATABASE_URL is not configured",
    });
  });

  it("reports unavailable when an endpoint does not snap within tolerance", async () => {
    serveGraph(corridorGraph());

    const result = await planCsrWalkRoute(
      [originPoint, { lat: 25.2, lng: 121.67 }],
      { mode: "wheelchair" },
    );

    expect(result.status).toBe("unavailable");
    expect(result).toMatchObject({
      reason: expect.stringContaining("destination"),
    });
  });
});

describe("planCsrWalkRoute geometry assembly", () => {
  it("stitches stored geometry in traversal order and dedupes the shared join", async () => {
    serveGraph(corridorGraph());
    vi.mocked(getPedGraphClient).mockResolvedValue(
      geometryClient({
        "1000": lineString([
          [TAIPEI_LNG, A_LAT],
          [TAIPEI_LNG + 0.0001, 25.0402],
          [TAIPEI_LNG, B_LAT],
        ]),
        "1002": lineString([
          [TAIPEI_LNG, B_LAT],
          [TAIPEI_LNG + 0.0002, 25.0408],
          [TAIPEI_LNG, C_LAT],
        ]),
      }),
    );

    const result = await planCsrWalkRoute([originPoint, destinationPoint], {
      mode: "normal",
    });

    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.plans).toHaveLength(1);
    expect(result.plans[0].polyline).toEqual([
      [TAIPEI_LNG, A_LAT],
      [TAIPEI_LNG + 0.0001, 25.0402],
      [TAIPEI_LNG, B_LAT],
      [TAIPEI_LNG + 0.0002, 25.0408],
      [TAIPEI_LNG, C_LAT],
    ]);
    expect(result.plans[0].approximateIndoorSegmentCount).toBe(0);
    expect(result.plans[0].graphVersionId).toBe(7);
  });

  it("counts accepted endpoint connectors and includes their true coordinates", async () => {
    serveGraph(corridorGraph());
    const connectorOrigin = { lat: A_LAT - 5 / 111_195, lng: TAIPEI_LNG };
    const connectorDestination = {
      lat: C_LAT + 7 / 111_195,
      lng: TAIPEI_LNG,
    };
    vi.mocked(getPedGraphClient).mockResolvedValue(
      geometryClient({
        "1000": lineString([
          [TAIPEI_LNG, A_LAT],
          [TAIPEI_LNG, B_LAT],
        ]),
        "1002": lineString([
          [TAIPEI_LNG, B_LAT],
          [TAIPEI_LNG, C_LAT],
        ]),
      }),
    );

    const result = await planCsrWalkRoute(
      [connectorOrigin, connectorDestination],
      { mode: "normal" },
    );

    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    const plan = result.plans[0];
    expect(plan.polyline[0]).toEqual([
      connectorOrigin.lng,
      connectorOrigin.lat,
    ]);
    expect(plan.polyline.at(-1)).toEqual([
      connectorDestination.lng,
      connectorDestination.lat,
    ]);
    expect(plan.distanceM).toBeGreaterThan(110);
    expect(plan.durationS).toBeGreaterThan(110 / 1.3);
    expect(plan.diagnostics.originSnapDistanceM).toBeGreaterThan(4);
    expect(plan.diagnostics.destinationSnapDistanceM).toBeGreaterThan(6);
  });

  it("estimates a same-centroid indoor proxy from traversal time and counts it", async () => {
    const graph = graphFromEdges({
      nodeLon: [TAIPEI_LNG, TAIPEI_LNG, TAIPEI_LNG, TAIPEI_LNG],
      // Nodes 1 and 2 deliberately share one station-centroid proxy. Their
      // endpoint distance is zero, but the selected GTFS pathway takes 40 s.
      nodeLat: [A_LAT, B_LAT, B_LAT, C_LAT],
      edges: [
        { from: 0, to: 1, lengthM: 55 },
        { from: 1, to: 0, lengthM: 55 },
        {
          from: 1,
          to: 2,
          traversalTimeS: 40,
          edgeType: EDGE_TYPE.INDOOR_WALKWAY,
          flags: EDGE_FLAG.INDOOR,
        },
        {
          from: 2,
          to: 1,
          traversalTimeS: 40,
          edgeType: EDGE_TYPE.INDOOR_WALKWAY,
          flags: EDGE_FLAG.INDOOR,
        },
        { from: 2, to: 3, lengthM: 55 },
        { from: 3, to: 2, lengthM: 55 },
      ],
    });
    serveGraph(graph);
    vi.mocked(getPedGraphClient).mockResolvedValue(
      geometryClient({
        "1000": lineString([
          [TAIPEI_LNG, A_LAT],
          [TAIPEI_LNG, B_LAT],
        ]),
        "1002": null,
        "1004": lineString([
          [TAIPEI_LNG, B_LAT],
          [TAIPEI_LNG, C_LAT],
        ]),
      }),
    );

    const result = await planCsrWalkRoute([originPoint, destinationPoint], {
      mode: "normal",
    });

    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    const plan = result.plans[0];
    expect(plan.approximateIndoorSegmentCount).toBe(1);
    expect(plan.distanceM).toBeCloseTo(162, 5);
    expect(plan.durationS).toBeCloseTo(40 + 110 / 1.3, 5);
    expect(plan.polyline).toEqual([
      [TAIPEI_LNG, A_LAT],
      [TAIPEI_LNG, B_LAT],
      [TAIPEI_LNG, C_LAT],
    ]);
  });

  it.each([
    ["NULL", null],
    ["malformed", "{not json"],
  ])(
    "returns unavailable when a selected outdoor edge has %s geometry",
    async (_label, geojson) => {
      serveGraph(oneEdgeGraph());
      vi.mocked(getPedGraphClient).mockResolvedValue(
        geometryClient({ "1000": geojson }),
      );

      await expect(
        planCsrWalkRoute([originPoint, destinationPoint], { mode: "normal" }),
      ).resolves.toMatchObject({
        status: "unavailable",
        reason: expect.stringContaining("selected outdoor edge"),
      });
    },
  );

  it("returns unavailable when a selected outdoor edge geometry row is missing", async () => {
    serveGraph(oneEdgeGraph());
    vi.mocked(getPedGraphClient).mockResolvedValue(
      geometryClient({}, ["1000"]),
    );

    await expect(
      planCsrWalkRoute([originPoint, destinationPoint], { mode: "normal" }),
    ).resolves.toMatchObject({
      status: "unavailable",
      reason: expect.stringContaining("missing geometry"),
    });
  });

  it.each([
    ["NULL", null],
    ["malformed", "{not json"],
  ])(
    "permits %s geometry only on a selected indoor edge",
    async (_label, geojson) => {
      serveGraph(oneEdgeGraph(EDGE_FLAG.INDOOR));
      vi.mocked(getPedGraphClient).mockResolvedValue(
        geometryClient({ "1000": geojson }),
      );

      const result = await planCsrWalkRoute([originPoint, destinationPoint], {
        mode: "normal",
      });

      expect(result.status).toBe("ok");
      if (result.status !== "ok") return;
      expect(result.plans[0].approximateIndoorSegmentCount).toBe(1);
    },
  );

  it("permits missing geometry only on a selected indoor edge", async () => {
    serveGraph(oneEdgeGraph(EDGE_FLAG.INDOOR));
    vi.mocked(getPedGraphClient).mockResolvedValue(
      geometryClient({}, ["1000"]),
    );

    const result = await planCsrWalkRoute([originPoint, destinationPoint], {
      mode: "normal",
    });

    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.plans[0].approximateIndoorSegmentCount).toBe(1);
  });

  it.each([
    ["zero", 0],
    ["missing", Number.NaN],
  ])(
    "returns unavailable rather than emitting a zero-distance indoor proxy with %s traversal time",
    async (_label, traversalTimeS) => {
      serveGraph(oneEdgeGraph(EDGE_FLAG.INDOOR, traversalTimeS));
      vi.mocked(getPedGraphClient).mockResolvedValue(
        geometryClient({ "1000": null }),
      );

      await expect(
        planCsrWalkRoute([originPoint, destinationPoint], { mode: "normal" }),
      ).resolves.toMatchObject({
        status: "unavailable",
        reason: expect.stringContaining("traversal_time_s"),
      });
    },
  );

  it("reads geometry for the specific parallel edge the search selected", async () => {
    const graph = graphFromEdges({
      nodeLon: [TAIPEI_LNG, TAIPEI_LNG],
      nodeLat: [A_LAT, C_LAT],
      edges: [
        { from: 0, to: 1, lengthM: 900 },
        { from: 0, to: 1, lengthM: 110 },
        { from: 1, to: 0, lengthM: 110 },
      ],
    });
    serveGraph(graph);
    const detour: [number, number][] = [
      [TAIPEI_LNG, A_LAT],
      [TAIPEI_LNG + 0.01, B_LAT],
      [TAIPEI_LNG, C_LAT],
    ];
    const direct: [number, number][] = [
      [TAIPEI_LNG, A_LAT],
      [TAIPEI_LNG, C_LAT],
    ];
    vi.mocked(getPedGraphClient).mockResolvedValue(
      geometryClient({
        "1000": lineString(detour),
        "1001": lineString(direct),
      }),
    );

    const result = await planCsrWalkRoute([originPoint, destinationPoint], {
      mode: "normal",
    });

    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.plans[0].diagnostics.edgeCount).toBe(1);
    expect(result.plans[0].polyline).toEqual(direct);
  });

  it("returns one plan per requested segment in request order", async () => {
    serveGraph(corridorGraph());
    vi.mocked(getPedGraphClient).mockResolvedValue(
      geometryClient({
        "1000": lineString([
          [TAIPEI_LNG, A_LAT],
          [TAIPEI_LNG, B_LAT],
        ]),
        "1002": lineString([
          [TAIPEI_LNG, B_LAT],
          [TAIPEI_LNG, C_LAT],
        ]),
      }),
    );

    const result = await planCsrWalkRoute(
      [originPoint, middlePoint, destinationPoint],
      { mode: "normal" },
    );

    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.plans).toHaveLength(2);
    expect(result.plans[0].polyline[0]).toEqual([TAIPEI_LNG, A_LAT]);
    expect(result.plans[0].polyline.at(-1)).toEqual([TAIPEI_LNG, B_LAT]);
    expect(result.plans[1].polyline[0]).toEqual([TAIPEI_LNG, B_LAT]);
    expect(result.plans[1].polyline.at(-1)).toEqual([TAIPEI_LNG, C_LAT]);
  });
});

describe("planCsrWalkRoute mode profiles", () => {
  /**
   * @returns A corridor whose only path is a ramp-less flight of steps.
   */
  function stepsCorridor(): PedGraph {
    return graphFromEdges({
      nodeLon: [TAIPEI_LNG, TAIPEI_LNG],
      nodeLat: [A_LAT, C_LAT],
      edges: [
        { from: 0, to: 1, lengthM: 110, edgeType: EDGE_TYPE.STEPS },
        { from: 1, to: 0, lengthM: 110, edgeType: EDGE_TYPE.STEPS },
      ],
    });
  }

  it("blocks wheelchair routing on ramp-less steps", async () => {
    serveGraph(stepsCorridor());

    const result = await planCsrWalkRoute([originPoint, destinationPoint], {
      mode: "wheelchair",
    });

    expect(result).toEqual({ status: "accessibility_blocked" });
  });

  it.each(["normal", "elderly", "visual_impaired"] as const)(
    "routes %s neutrally over the same ramp-less steps",
    async (mode) => {
      serveGraph(stepsCorridor());
      vi.mocked(getPedGraphClient).mockResolvedValue(
        geometryClient({
          "1000": lineString([
            [TAIPEI_LNG, A_LAT],
            [TAIPEI_LNG, C_LAT],
          ]),
        }),
      );

      const result = await planCsrWalkRoute([originPoint, destinationPoint], {
        mode,
      });

      expect(result.status).toBe("ok");
      if (result.status !== "ok") return;
      expect(result.plans[0].diagnostics.relaxationLevel).toBe(0);
    },
  );

  it("blocks wheelchair routing on an extreme slope but serves normal mode", async () => {
    /**
     * @returns A corridor whose only path exceeds the wheelchair slope limit.
     */
    const steepCorridor = () =>
      graphFromEdges({
        nodeLon: [TAIPEI_LNG, TAIPEI_LNG],
        nodeLat: [A_LAT, C_LAT],
        edges: [
          { from: 0, to: 1, lengthM: 110, slopeRatio: 0.2 },
          { from: 1, to: 0, lengthM: 110, slopeRatio: 0.2 },
        ],
      });

    serveGraph(steepCorridor());
    const blocked = await planCsrWalkRoute([originPoint, destinationPoint], {
      mode: "wheelchair",
    });
    expect(blocked).toEqual({ status: "accessibility_blocked" });

    serveGraph(steepCorridor());
    vi.mocked(getPedGraphClient).mockResolvedValue(
      geometryClient({
        "1000": lineString([
          [TAIPEI_LNG, A_LAT],
          [TAIPEI_LNG, C_LAT],
        ]),
      }),
    );
    const served = await planCsrWalkRoute([originPoint, destinationPoint], {
      mode: "normal",
    });
    expect(served.status).toBe("ok");
    if (served.status !== "ok") return;
    expect(served.plans[0].accessibility.maxSlopePercent).toBe(20);
  });
});

describe("planCsrWalkRoute blocking classification", () => {
  /**
   * Corridor whose only 0 -> 4 path crosses a station fare gate, with outdoor
   * stubs at each end so both endpoints remain snappable.
   *
   * @param stationIds Station dictionary for the graph.
   * @returns The fixture graph.
   */
  function fareGateGraph(stationIds: string[]): PedGraph {
    return graphFromEdges({
      nodeLon: [
        TAIPEI_LNG,
        TAIPEI_LNG,
        TAIPEI_LNG,
        TAIPEI_LNG,
        TAIPEI_LNG,
        TAIPEI_LNG,
      ],
      nodeLat: [A_LAT, 25.0402, 25.0404, 25.0406, C_LAT, 25.0412],
      nodeFlags: [
        NODE_FLAG.HAS_REAL_GEOM,
        NODE_FLAG.HAS_REAL_GEOM,
        NODE_FLAG.INDOOR,
        NODE_FLAG.INDOOR,
        NODE_FLAG.HAS_REAL_GEOM,
        NODE_FLAG.HAS_REAL_GEOM,
      ],
      // The gate always sits on the last (valid) station slot, so blank slots
      // exercise the authorization filter instead of making the gate
      // unauthorizable by any policy.
      nodeStationId: [
        -1,
        -1,
        stationIds.length - 1,
        stationIds.length - 1,
        -1,
        -1,
      ],
      stationIds,
      stationRadiusM: stationIds.map(() => 0),
      edges: [
        { from: 0, to: 1, lengthM: 22 },
        { from: 1, to: 0, lengthM: 22 },
        {
          from: 1,
          to: 2,
          traversalTimeS: 20,
          edgeType: EDGE_TYPE.INDOOR_WALKWAY,
          flags: EDGE_FLAG.INDOOR,
        },
        {
          from: 2,
          to: 3,
          traversalTimeS: 10,
          edgeType: EDGE_TYPE.INDOOR_FARE_GATE,
          flags: EDGE_FLAG.INDOOR,
        },
        {
          from: 3,
          to: 4,
          traversalTimeS: 20,
          edgeType: EDGE_TYPE.INDOOR_WALKWAY,
          flags: EDGE_FLAG.INDOOR,
        },
        { from: 4, to: 5, lengthM: 22 },
        { from: 5, to: 4, lengthM: 22 },
      ],
    });
  }

  it("classifies a gate-only obstruction as fare_policy_blocked", async () => {
    serveGraph(fareGateGraph(["R01"]));

    const result = await planCsrWalkRoute([originPoint, destinationPoint], {
      mode: "normal",
    });

    expect(result).toEqual({ status: "fare_policy_blocked" });
  });

  it("diagnostically opens a valid gate despite unrelated blank station entries", async () => {
    serveGraph(fareGateGraph(["", "   ", "R01"]));

    const result = await planCsrWalkRoute([originPoint, destinationPoint], {
      mode: "normal",
    });

    expect(result).toEqual({ status: "fare_policy_blocked" });
  });

  it("classifies missing or mismatched gate station identities as fare_policy_blocked", async () => {
    const missingIdentity = fareGateGraph(["R01"]);
    missingIdentity.nodeStationId[2] = -1;
    missingIdentity.nodeStationId[3] = -1;
    serveGraph(missingIdentity);

    await expect(
      planCsrWalkRoute([originPoint, destinationPoint], { mode: "normal" }),
    ).resolves.toEqual({ status: "fare_policy_blocked" });

    const mismatchedIdentity = fareGateGraph(["R01", "B02"]);
    mismatchedIdentity.nodeStationId[2] = 0;
    mismatchedIdentity.nodeStationId[3] = 1;
    serveGraph(mismatchedIdentity);

    await expect(
      planCsrWalkRoute([originPoint, destinationPoint], { mode: "normal" }),
    ).resolves.toEqual({ status: "fare_policy_blocked" });
  });

  it("still reports fare_policy_blocked for a wheelchair request", async () => {
    serveGraph(fareGateGraph(["R01"]));

    const result = await planCsrWalkRoute([originPoint, destinationPoint], {
      mode: "wheelchair",
    });

    expect(result).toEqual({ status: "fare_policy_blocked" });
  });

  it("classifies two disconnected components as topology_disconnected", async () => {
    serveGraph(
      graphFromEdges({
        nodeLon: [TAIPEI_LNG, TAIPEI_LNG, TAIPEI_LNG, TAIPEI_LNG],
        nodeLat: [A_LAT, 25.0401, C_LAT, 25.0411],
        edges: [
          { from: 0, to: 1, lengthM: 11 },
          { from: 1, to: 0, lengthM: 11 },
          { from: 2, to: 3, lengthM: 11 },
          { from: 3, to: 2, lengthM: 11 },
        ],
      }),
    );

    const result = await planCsrWalkRoute([originPoint, destinationPoint], {
      mode: "normal",
    });

    expect(result).toEqual({ status: "topology_disconnected" });
  });

  it("prefers a policy block over a can't-answer block across segments", async () => {
    // Segment 1 is fare-blocked; segment 2 cannot snap its destination. The
    // policy decision must win so the service can apply the stricter fallback
    // boundary instead of treating the whole request as a generic graph gap.
    serveGraph(fareGateGraph(["R01"]));

    const result = await planCsrWalkRoute(
      [originPoint, destinationPoint, { lat: 25.2, lng: 121.67 }],
      { mode: "normal" },
    );

    expect(result).toEqual({ status: "fare_policy_blocked" });
  });

  it("reports unavailable when the selected edge geometry read fails", async () => {
    serveGraph(corridorGraph());
    vi.mocked(getPedGraphClient).mockResolvedValue({
      query: () => Promise.reject(new Error("connection terminated")),
    });

    const result = await planCsrWalkRoute([originPoint, destinationPoint], {
      mode: "normal",
    });

    expect(result).toEqual({
      status: "unavailable",
      reason: "connection terminated",
    });
  });
});

describe("isTopologyReachable", () => {
  it("ignores edge cost and fare policy entirely", async () => {
    // Every edge is infeasible for a wheelchair and crosses a fare gate, yet
    // the nodes are still topologically connected — the oracle must say so, or
    // an accessibility refusal would be misreported as a graph defect.
    const graph = graphFromEdges({
      nodeLon: [TAIPEI_LNG, TAIPEI_LNG],
      nodeLat: [A_LAT, C_LAT],
      edges: [
        {
          from: 0,
          to: 1,
          lengthM: Number.NaN,
          edgeType: EDGE_TYPE.INDOOR_FARE_GATE,
        },
      ],
    });

    expect(isTopologyReachable(graph, 0, 1)).toBe(true);
    expect(isTopologyReachable(graph, 1, 0)).toBe(false);
  });

  it("treats an identical origin and destination as reachable", () => {
    expect(isTopologyReachable(corridorGraph(), 1, 1)).toBe(true);
  });
});
