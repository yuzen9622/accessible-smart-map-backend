import { describe, expect, it } from "vitest";
import { BinaryMinHeap, aStar, heuristicCost } from "./astar";
import {
  WHEELCHAIR_MAX_RELAXATION_LEVEL,
  WHEELCHAIR_WALK_SPEED_MPS,
  type CostProfile,
} from "./cost";
import { dijkstra } from "./dijkstra";
import { EDGE_FLAG, EDGE_TYPE, NODE_FLAG, type PedGraph } from "./graph.types";

const METRES_PER_DEGREE_LATITUDE = 111_195;

interface EdgeDefinition {
  from: number;
  to: number;
  lengthM?: number;
  traversalTimeS?: number;
  edgeType?: number;
  flags?: number;
  slopeRatio?: number;
  widthM?: number;
}

interface GraphDefinition {
  nodeLon: number[];
  nodeLat: number[];
  edges: EdgeDefinition[];
  nodeFlags?: number[];
  nodeStationId?: number[];
  stationIds?: string[];
  stationRadiusM?: number[];
}

/**
 * @param input Dense node coordinates and directed edge definitions.
 * @returns A CSR pedestrian graph with neutral edge attributes by default.
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
  }
  if (input.nodeStationId !== undefined) {
    nodeStationId.set(input.nodeStationId);
  }

  return {
    versionId: 1,
    nodeCount,
    directedEdgeCount,
    undirectedEdgeCount: directedEdgeCount,
    nodeLon: Float64Array.from(input.nodeLon),
    nodeLat: Float64Array.from(input.nodeLat),
    nodeFlags: Uint8Array.from(input.nodeFlags ?? new Array(nodeCount).fill(0)),
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
    edgeSurface: new Uint8Array(directedEdgeCount),
    edgeSmoothness: new Uint8Array(directedEdgeCount),
    edgeWidthM,
    edgeWheelchair: new Uint8Array(directedEdgeCount),
    edgeStairCount: new Uint16Array(directedEdgeCount),
    edgeTraversalTimeS,
    edgeFlags,
    edgeSidewalkId: new Int32Array(directedEdgeCount).fill(-1),
    sidewalkIds: Object.freeze([]),
    edgeSidewalkRampCount: new Uint16Array(directedEdgeCount),
    edgeStreetName: new Int32Array(directedEdgeCount).fill(-1),
    streetNames: Object.freeze([]),
  };
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
 * @returns A graph whose retired proxy-coordinate heuristic required reopening an indoor node.
 */
function createReopenGraph(): PedGraph {
  const latitude = 25;
  const longitude = 121.5;
  return graphFromEdges({
    nodeLon: [longitude, longitude, longitude, longitude],
    nodeLat: [
      latitude + 19 / METRES_PER_DEGREE_LATITUDE,
      latitude + 10 / METRES_PER_DEGREE_LATITUDE,
      latitude,
      latitude,
    ],
    nodeFlags: [0, 0, NODE_FLAG.INDOOR, 0],
    nodeStationId: [-1, -1, 0, -1],
    stationRadiusM: [11],
    edges: [
      {
        from: 0,
        to: 2,
        traversalTimeS: 15,
        flags: EDGE_FLAG.INDOOR,
        edgeType: EDGE_TYPE.INDOOR_WALKWAY,
      },
      { from: 0, to: 1, lengthM: 9 },
      {
        from: 1,
        to: 2,
        traversalTimeS: 1.25,
        flags: EDGE_FLAG.INDOOR,
        edgeType: EDGE_TYPE.INDOOR_WALKWAY,
      },
      {
        from: 2,
        to: 3,
        traversalTimeS: 12.5,
        flags: EDGE_FLAG.INDOOR,
        edgeType: EDGE_TYPE.INDOOR_WALKWAY,
      },
    ],
  });
}

/**
 * @returns A connected mixed outdoor and proxy-coordinate indoor graph.
 */
function createSyntheticGraph(): PedGraph {
  const nodeLon: number[] = [];
  const nodeLat: number[] = [];
  const nodeFlags: number[] = [];
  const nodeStationId: number[] = [];
  const stationRadiusM = [25, 25, 25, 25];
  const edges: EdgeDefinition[] = [];
  const rows = 4;
  const columns = 6;

  for (let row = 0; row < rows; row += 1) {
    for (let column = 0; column < columns; column += 1) {
      nodeLon.push(121.5 + column * 0.00015);
      nodeLat.push(25.05 + row * 0.00015);
      nodeFlags.push(0);
      nodeStationId.push(-1);
    }
  }
  for (let row = 0; row < rows; row += 1) {
    for (let column = 0; column < columns; column += 1) {
      const from = row * columns + column;
      if (column + 1 < columns) {
        const to = from + 1;
        edges.push(
          { from, to, lengthM: 24 },
          { from: to, to: from, lengthM: 24 },
        );
      }
      if (row + 1 < rows) {
        const to = from + columns;
        edges.push(
          { from, to, lengthM: 24 },
          { from: to, to: from, lengthM: 24 },
        );
      }
    }
  }
  for (const [station, portal] of [0, 6, 17, 23].entries()) {
    for (let indoorCount = 0; indoorCount < 2; indoorCount += 1) {
      const indoorNode = nodeLon.length;
      nodeLon.push(nodeLon[portal]);
      nodeLat.push(nodeLat[portal]);
      nodeFlags.push(NODE_FLAG.INDOOR);
      nodeStationId.push(station);
      edges.push(
        {
          from: portal,
          to: indoorNode,
          traversalTimeS: 40,
          flags: EDGE_FLAG.INDOOR,
          edgeType: EDGE_TYPE.INDOOR_WALKWAY,
        },
        {
          from: indoorNode,
          to: portal,
          traversalTimeS: 40,
          flags: EDGE_FLAG.INDOOR,
          edgeType: EDGE_TYPE.INDOOR_WALKWAY,
        },
      );
    }
  }

  return graphFromEdges({
    nodeLon,
    nodeLat,
    nodeFlags,
    nodeStationId,
    stationRadiusM,
    edges,
  });
}

/**
 * @returns A graph with a target behind each wheelchair relaxation rung.
 */
function createRelaxationGraph(): PedGraph {
  return graphFromEdges({
    nodeLon: [121.5, 121.5001, 121.5002, 121.5003, 121.5004],
    nodeLat: [25.05, 25.05, 25.05, 25.05, 25.05],
    edges: [
      { from: 0, to: 1, lengthM: 10, widthM: 0.8 },
      { from: 0, to: 2, lengthM: 10, slopeRatio: 0.13 },
      { from: 0, to: 3, lengthM: 10, edgeType: EDGE_TYPE.STEPS },
      { from: 0, to: 4, lengthM: 10 },
    ],
  });
}

describe("BinaryMinHeap", () => {
  it("orders tied keys by node and doubles typed-array storage", () => {
    const heap = new BinaryMinHeap(1);
    heap.push(4, 3);
    heap.push(3, 2);
    heap.push(2, 2);
    heap.push(1, 1);

    expect(heap.size).toBe(4);
    expect(heap.pop()).toBe(1);
    expect(heap.lastKey).toBe(1);
    expect(heap.pop()).toBe(2);
    expect(heap.pop()).toBe(3);
    expect(heap.pop()).toBe(4);
    expect(heap.pop()).toBe(-1);
    expect(Number.isNaN(heap.lastKey)).toBe(true);
    expect(() => heap.push(0, Number.POSITIVE_INFINITY)).toThrow(/finite/);
  });
});

describe("aStar", () => {
  it("returns null for invalid or unreachable endpoints", () => {
    const graph = graphFromEdges({
      nodeLon: [121.5, 121.501],
      nodeLat: [25.05, 25.05],
      edges: [],
    });

    expect(aStar(graph, -1, 1, wheelchairProfile())).toBeNull();
    expect(aStar(graph, 0, 2, wheelchairProfile())).toBeNull();
    expect(aStar(graph, 0, 1, wheelchairProfile())).toBeNull();
    expect(aStar(graph, 1, 1, wheelchairProfile())).toEqual({
      nodePath: Int32Array.of(1),
      edgeAttrPath: new Int32Array(0),
      totalCost: 0,
      expandedNodes: 0,
      reopenedNodes: 0,
    });
  });

  it("plans all four accessibility modes without throwing", () => {
    const graph = graphFromEdges({
      nodeLon: [121.5, 121.501, 121.502],
      nodeLat: [25.05, 25.05, 25.05],
      edges: [
        { from: 0, to: 1, lengthM: 100 },
        { from: 1, to: 2, lengthM: 100 },
      ],
    });

    for (const name of [
      "wheelchair",
      "normal",
      "elderly",
      "visual_impaired",
    ] as const) {
      const result = aStar(graph, 0, 2, {
        name,
        walkSpeedMps: WHEELCHAIR_WALK_SPEED_MPS,
        relaxationLevel: 0,
      });
      expect(Array.from(result?.nodePath ?? [])).toEqual([0, 1, 2]);
    }
  });

  it("reports the exact selected directed edge among parallel edges", () => {
    // Three parallel 0 -> 1 edges: the node pair alone is ambiguous, so only
    // edgeAttrPath can identify which geometry and attributes were chosen.
    const graph = graphFromEdges({
      nodeLon: [121.5, 121.501],
      nodeLat: [25.05, 25.05],
      edges: [
        { from: 0, to: 1, lengthM: 400 },
        { from: 0, to: 1, lengthM: 120 },
        { from: 0, to: 1, lengthM: 900 },
      ],
    });

    const result = aStar(graph, 0, 1, wheelchairProfile());

    expect(Array.from(result?.nodePath ?? [])).toEqual([0, 1]);
    expect(Array.from(result?.edgeAttrPath ?? [])).toEqual([1]);
    expect(graph.edgeLengthM[result?.edgeAttrPath[0] ?? -1]).toBe(120);
    expect(graph.edgeOriginalId[result?.edgeAttrPath[0] ?? -1]).toBe(1_001n);
  });

  it("picks the lowest adjacency slot deterministically for tied parallel edges", () => {
    const graph = graphFromEdges({
      nodeLon: [121.5, 121.501],
      nodeLat: [25.05, 25.05],
      edges: [
        { from: 0, to: 1, lengthM: 250 },
        { from: 0, to: 1, lengthM: 250 },
      ],
    });

    for (let attempt = 0; attempt < 5; attempt += 1) {
      expect(
        Array.from(aStar(graph, 0, 1, wheelchairProfile())?.edgeAttrPath ?? []),
      ).toEqual([0]);
    }
  });

  it("finds the lower-cost route when a direct edge has a slope penalty", () => {
    const graph = graphFromEdges({
      nodeLon: [121.5, 121.5001, 121.5002],
      nodeLat: [25.05, 25.05, 25.05],
      edges: [
        { from: 0, to: 2, lengthM: 100, slopeRatio: 0.08 },
        { from: 0, to: 1, lengthM: 75 },
        { from: 1, to: 2, lengthM: 75 },
      ],
    });
    const result = aStar(graph, 0, 2, wheelchairProfile());

    expect(result).not.toBeNull();
    expect(result?.totalCost).toBe(150);
    expect(Array.from(result?.nodePath ?? [])).toEqual([0, 1, 2]);
    expect(result?.expandedNodes).toBeGreaterThan(0);
  });

  it("uses the zero heuristic and preserves optimality on a retired-reopen graph", () => {
    const graph = createReopenGraph();
    const result = aStar(graph, 0, 3, wheelchairProfile());
    const reference = dijkstra(graph, 0, 3, wheelchairProfile());

    expect(result).not.toBeNull();
    expect(reference).not.toBeNull();
    expect(result?.totalCost).toBe(20);
    expect(
      relativeError(
        result?.totalCost ?? Number.NaN,
        reference?.totalCost ?? Number.NaN,
      ),
    ).toBeLessThanOrEqual(1e-9);
    expect(Array.from(result?.nodePath ?? [])).toEqual([0, 1, 2, 3]);
    expect(result?.reopenedNodes).toBe(0);
  });

  it("uses zero as the admissible lower bound for every proxy-coordinate node", () => {
    const graph = createReopenGraph();

    for (let node = 0; node < graph.nodeCount; node += 1) {
      const result = dijkstra(graph, node, 3, wheelchairProfile());
      if (result === null) {
        throw new Error("reopen graph unexpectedly lost a path to its goal");
      }
      expect(heuristicCost(graph, node, 3)).toBe(0);
      expect(heuristicCost(graph, node, 3)).toBeLessThanOrEqual(
        result.totalCost,
      );
    }
  });

  it("matches Dijkstra exactly for 50 fixed-seed mixed indoor and outdoor OD pairs", () => {
    const graph = createSyntheticGraph();
    const random = seededRandom(20_260_824);
    let comparedPairs = 0;

    while (comparedPairs < 50) {
      const from = Math.floor(random() * graph.nodeCount);
      const sampledTo = Math.floor(random() * graph.nodeCount);
      const to =
        sampledTo === from ? (sampledTo + 1) % graph.nodeCount : sampledTo;
      const result = aStar(graph, from, to, wheelchairProfile());
      const reference = dijkstra(graph, from, to, wheelchairProfile());
      if (result === null || reference === null) {
        throw new Error(
          "synthetic graph unexpectedly produced an unreachable OD",
        );
      }
      expect(
        relativeError(result.totalCost, reference.totalCost),
      ).toBeLessThanOrEqual(1e-9);
      comparedPairs += 1;
    }

    for (let indoorNode = 24; indoorNode < graph.nodeCount; indoorNode += 1) {
      const reference = dijkstra(graph, indoorNode, 23, wheelchairProfile());
      if (reference === null) {
        throw new Error(
          "synthetic indoor node unexpectedly lost a path to its goal",
        );
      }
      expect(heuristicCost(graph, indoorNode, 23)).toBe(0);
      expect(heuristicCost(graph, indoorNode, 23)).toBeLessThanOrEqual(
        reference.totalCost,
      );
    }
    expect(comparedPairs).toBe(50);
  });

  it("grows the feasible target set strictly at every relaxation level", () => {
    const graph = createRelaxationGraph();
    const feasibleByLevel = Array.from(
      { length: WHEELCHAIR_MAX_RELAXATION_LEVEL + 1 },
      (_, relaxationLevel) =>
        [1, 2, 3, 4].filter(
          (target) =>
            aStar(graph, 0, target, wheelchairProfile(relaxationLevel)) !==
            null,
        ),
    );

    expect(feasibleByLevel).toEqual([[4], [2, 4], [1, 2, 4], [1, 2, 3, 4]]);
    for (
      let relaxationLevel = 1;
      relaxationLevel < feasibleByLevel.length;
      relaxationLevel += 1
    ) {
      for (const target of feasibleByLevel[relaxationLevel - 1]) {
        expect(feasibleByLevel[relaxationLevel]).toContain(target);
      }
      expect(feasibleByLevel[relaxationLevel].length).toBeGreaterThan(
        feasibleByLevel[relaxationLevel - 1].length,
      );
    }
  });
});
