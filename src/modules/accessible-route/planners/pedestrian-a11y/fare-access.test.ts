import { describe, expect, it } from "vitest";
import { aStar } from "./astar";
import { WHEELCHAIR_WALK_SPEED_MPS, type CostProfile } from "./cost";
import { dijkstra } from "./dijkstra";
import {
  FORBID_FARE_ACCESS,
  canTraverseFareGate,
  createTransitAuthorizedFareAccess,
  fareAccessPolicyKey,
  type FareAccessPolicy,
  normalizeFareAccessPolicy,
} from "./fare-access";
import { EDGE_TYPE, type PedGraph } from "./graph.types";

interface EdgeDefinition {
  from: number;
  to: number;
  edgeType: number;
  lengthM?: number;
}

interface GateGraphInput {
  nodeStationId: number[];
  stationIds: string[];
  edges: EdgeDefinition[];
}

/**
 * @param input Dense station assignments and directed edges.
 * @returns A neutral CSR graph with deterministic station reverse lookup.
 */
function graphFromEdges(input: GateGraphInput): PedGraph {
  const nodeCount = input.nodeStationId.length;
  const directedEdgeCount = input.edges.length;
  const adjOffset = new Int32Array(nodeCount + 1);
  const adjTarget = new Int32Array(directedEdgeCount);
  const adjAttr = new Int32Array(directedEdgeCount);

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
  }

  return {
    versionId: 1,
    nodeCount,
    directedEdgeCount,
    undirectedEdgeCount: directedEdgeCount,
    nodeLon: Float64Array.from(
      Array.from({ length: nodeCount }, (_, node) => 121.5 + node * 0.0001),
    ),
    nodeLat: Float64Array.from(new Array(nodeCount).fill(25.05)),
    nodeFlags: new Uint8Array(nodeCount),
    nodeStationId: Int32Array.from(input.nodeStationId),
    stationIds: Object.freeze([...input.stationIds]),
    stationRadiusM: new Float32Array(),
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
    edgeLengthM: Float32Array.from(
      input.edges.map((edge) => edge.lengthM ?? 10),
    ),
    edgeType: Uint8Array.from(input.edges.map((edge) => edge.edgeType)),
    edgeSlope: Float32Array.from(new Array(directedEdgeCount).fill(Number.NaN)),
    edgeSurface: new Uint8Array(directedEdgeCount),
    edgeSmoothness: new Uint8Array(directedEdgeCount),
    edgeWidthM: Float32Array.from(
      new Array(directedEdgeCount).fill(Number.NaN),
    ),
    edgeWheelchair: new Uint8Array(directedEdgeCount),
    edgeStairCount: new Uint16Array(directedEdgeCount),
    edgeTraversalTimeS: Float32Array.from(
      new Array(directedEdgeCount).fill(Number.NaN),
    ),
    edgeFlags: new Uint8Array(directedEdgeCount),
  };
}

/**
 * @returns A graph with station-A gates, a station-B gate, and malformed gates.
 */
function createGateGraph(): PedGraph {
  return graphFromEdges({
    nodeStationId: [0, 0, 0, 1, 1, -1, 0, 1, 2],
    stationIds: ["station-a", "station-b"],
    edges: [
      { from: 0, to: 1, edgeType: EDGE_TYPE.INDOOR_FARE_GATE },
      { from: 1, to: 2, edgeType: EDGE_TYPE.INDOOR_EXIT_GATE },
      { from: 2, to: 3, edgeType: EDGE_TYPE.SIDEWALK, lengthM: 1 },
      { from: 3, to: 4, edgeType: EDGE_TYPE.INDOOR_FARE_GATE },
      { from: 5, to: 0, edgeType: EDGE_TYPE.INDOOR_FARE_GATE },
      { from: 6, to: 7, edgeType: EDGE_TYPE.INDOOR_EXIT_GATE },
      { from: 8, to: 8, edgeType: EDGE_TYPE.INDOOR_FARE_GATE },
    ],
  });
}

/**
 * @param relaxationLevel Cumulative wheelchair relaxation level.
 * @returns A wheelchair cost profile.
 */
function wheelchairProfile(relaxationLevel = 0): CostProfile {
  return {
    name: "wheelchair",
    walkSpeedMps: WHEELCHAIR_WALK_SPEED_MPS,
    relaxationLevel,
  };
}

describe("fare access policy", () => {
  it("normalizes immutable station IDs and keeps deterministic keys stable after Set mutation", () => {
    const source = new Set([" station-b ", "station-a", "station-b"]);
    const policy = createTransitAuthorizedFareAccess(source);
    const key = fareAccessPolicyKey(policy);

    source.add("station-c");

    expect(policy).toEqual({
      mode: "transit_authorized",
      authorizedStationIds: ["station-a", "station-b"],
    });
    expect(Object.isFrozen(policy)).toBe(true);
    expect(Object.isFrozen(policy.authorizedStationIds)).toBe(true);
    expect(fareAccessPolicyKey(policy)).toBe(key);
    expect(
      fareAccessPolicyKey(
        normalizeFareAccessPolicy({
          mode: "transit_authorized",
          authorizedStationIds: ["station-b", " station-a "],
        }),
      ),
    ).toBe(key);
    expect(() =>
      createTransitAuthorizedFareAccess(["station-a", "   "]),
    ).toThrow(/empty/i);
  });
});

describe("canTraverseFareGate", () => {
  it("fails closed for both gate types in forbid mode", () => {
    const graph = createGateGraph();

    expect(canTraverseFareGate(graph, 0, 1, 0, FORBID_FARE_ACCESS)).toBe(false);
    expect(canTraverseFareGate(graph, 1, 2, 1, FORBID_FARE_ACCESS)).toBe(false);
  });

  it("allows only an authorized same-station gate and leaves non-gates traversable", () => {
    const graph = createGateGraph();
    const stationA = createTransitAuthorizedFareAccess(["station-a"]);

    expect(canTraverseFareGate(graph, 0, 1, 0, stationA)).toBe(true);
    expect(canTraverseFareGate(graph, 1, 2, 1, stationA)).toBe(true);
    expect(canTraverseFareGate(graph, 3, 4, 3, stationA)).toBe(false);
    expect(canTraverseFareGate(graph, 2, 3, 2, FORBID_FARE_ACCESS)).toBe(true);
  });

  it("fails closed for an invalid runtime-cast mode with matching station authorization", () => {
    const graph = createGateGraph();
    const uncheckedPolicy = {
      mode: "unchecked",
      authorizedStationIds: ["station-a"],
    } as unknown as FareAccessPolicy;

    expect(normalizeFareAccessPolicy(uncheckedPolicy)).toBe(FORBID_FARE_ACCESS);
    expect(canTraverseFareGate(graph, 0, 1, 0, uncheckedPolicy)).toBe(false);
    expect(aStar(graph, 0, 2, wheelchairProfile(), uncheckedPolicy)).toBeNull();
    expect(
      dijkstra(graph, 0, 2, wheelchairProfile(), uncheckedPolicy),
    ).toBeNull();
  });

  it("fails closed for unknown, mismatched, or missing reverse station IDs", () => {
    const graph = createGateGraph();
    const stationA = createTransitAuthorizedFareAccess(["station-a"]);

    expect(canTraverseFareGate(graph, 5, 0, 4, stationA)).toBe(false);
    expect(canTraverseFareGate(graph, 6, 7, 5, stationA)).toBe(false);
    expect(canTraverseFareGate(graph, 8, 8, 6, stationA)).toBe(false);
  });
});

describe("fare access in A* and Dijkstra", () => {
  it("keeps both searches in agreement for forbid, authorized, and unrelated contexts", () => {
    const graph = createGateGraph();
    const contexts = [
      { name: "forbid", policy: FORBID_FARE_ACCESS, expectedCost: null },
      {
        name: "station-a",
        policy: createTransitAuthorizedFareAccess(["station-a"]),
        expectedCost: 20,
      },
      {
        name: "unrelated",
        policy: createTransitAuthorizedFareAccess(["station-b"]),
        expectedCost: null,
      },
    ] as const;

    for (const context of contexts) {
      const astarResult = aStar(
        graph,
        0,
        2,
        wheelchairProfile(),
        context.policy,
      );
      const dijkstraResult = dijkstra(
        graph,
        0,
        2,
        wheelchairProfile(),
        context.policy,
      );

      if (context.expectedCost === null) {
        expect(astarResult, context.name).toBeNull();
        expect(dijkstraResult, context.name).toBeNull();
      } else {
        expect(astarResult?.totalCost, context.name).toBe(context.expectedCost);
        expect(dijkstraResult?.totalCost, context.name).toBe(
          context.expectedCost,
        );
        expect(Array.from(astarResult?.nodePath ?? [])).toEqual([0, 1, 2]);
        expect(Array.from(dijkstraResult?.nodePath ?? [])).toEqual([0, 1, 2]);
      }
    }
  });

  it("does not let wheelchair relaxation unlock either gate type", () => {
    const graph = createGateGraph();

    for (const relaxationLevel of [0, 3]) {
      expect(aStar(graph, 0, 2, wheelchairProfile(relaxationLevel))).toBeNull();
      expect(
        dijkstra(graph, 0, 2, wheelchairProfile(relaxationLevel)),
      ).toBeNull();
    }
  });

  it("authorizes station A gates but still cannot cross the station B gate", () => {
    const graph = createGateGraph();
    const stationA = createTransitAuthorizedFareAccess(["station-a"]);

    expect(aStar(graph, 0, 2, wheelchairProfile(), stationA)?.totalCost).toBe(
      20,
    );
    expect(dijkstra(graph, 0, 4, wheelchairProfile(), stationA)).toBeNull();
  });
});
