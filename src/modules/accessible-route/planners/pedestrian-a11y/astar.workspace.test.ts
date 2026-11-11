import { describe, expect, it, vi } from "vitest";
import { EDGE_TYPE, type PedGraph } from "./graph.types";
import type { CostProfile } from "./cost";

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
    edgeRampPoints: new Map(),
  };
}

const profiles: CostProfile[] = [
  "normal",
  "wheelchair",
  "elderly",
  "visual_impaired",
].map((name) => ({
  name: name as CostProfile["name"],
  walkSpeedMps: 1,
  relaxationLevel: 0,
}));
function graph(size = 7): PedGraph {
  return graphFromEdges({
    nodeLon: Array(size).fill(121),
    nodeLat: Array(size).fill(25),
    edges: [
      { from: 0, to: 1, lengthM: 10 },
      { from: 0, to: 2, lengthM: 1 },
      { from: 2, to: 1, lengthM: 1 },
      { from: 1, to: 3, lengthM: 1 },
      { from: 2, to: 3, lengthM: 2 },
      { from: 3, to: 4, lengthM: 1, edgeType: EDGE_TYPE.STEPS },
      { from: 3, to: 5, lengthM: 3 },
      { from: 5, to: 4, lengthM: 1 },
      { from: 4, to: 0, lengthM: 1 },
    ],
  });
}

async function freshSearch() {
  vi.resetModules();
  return (await import("./astar")).aStar;
}

describe("aStar workspace ownership", () => {
  it("matches fresh-module searches across profiles, exclusions, graph sizes and early returns", async () => {
    const cases = Array.from({ length: 32 }, (_, i) => ({
      graph: graph(i % 3 === 0 ? 9 : 7),
      from: (i % 8) - 1,
      to: (i * 3 + 4) % 7,
      profile: { ...profiles[i % 4], preferSidewalks: i % 2 === 0 },
      excluded: new Set(i % 3 === 0 ? [3, 5] : []),
    }));
    const expected = [];
    for (const c of cases)
      expected.push(
        (await freshSearch())(
          c.graph,
          c.from,
          c.to,
          c.profile,
          undefined,
          c.excluded,
        ),
      );
    const search = await freshSearch();
    const actual = cases.map((c) =>
      search(c.graph, c.from, c.to, c.profile, undefined, c.excluded),
    );
    expect(actual).toEqual(expected);
    expect(actual.some((result) => result === null)).toBe(true);
    expect(
      actual.some((result) => result !== null && result.nodePath.length > 1),
    ).toBe(true);
    expect(actual).toEqual(expected);
  });

  it("cleans up after a caller throws with discovered and closed nodes", async () => {
    const g = graph();
    const search = await freshSearch();
    const expected = search(g, 0, 4, profiles[0]);
    const failure = new Error("excluded edge callback failed");
    const excluded = new Set<number>();
    let calls = 0;
    excluded.has = () => {
      if (++calls === 4) throw failure;
      return false;
    };
    expect(() => search(g, 0, 4, profiles[0], undefined, excluded)).toThrow(
      failure,
    );
    expect(calls).toBe(4);
    expect(search(g, 0, 4, profiles[0])).toEqual(expected);
    expect(search(g, 6, 4, profiles[1])).toBeNull();
  });

  it("isolates nested searches, including a different-size graph and nested failure", async () => {
    const search = await freshSearch();
    const g = graph();
    const other = graph(10);
    const expected = search(g, 0, 4, profiles[0]);
    const nestedExpected = search(other, 2, 4, profiles[1]);
    const excluded = new Set<number>();
    let entered = false;
    excluded.has = () => {
      if (!entered) {
        entered = true;
        expect(search(other, 2, 4, profiles[1])).toEqual(nestedExpected);
        const failing = new Set<number>();
        failing.has = () => {
          throw new Error("nested failure");
        };
        expect(() => search(g, 1, 4, profiles[2], undefined, failing)).toThrow(
          "nested failure",
        );
      }
      return false;
    };
    expect(search(g, 0, 4, profiles[0], undefined, excluded)).toEqual(expected);
    expect(entered).toBe(true);
    expect(search(g, 0, 4, profiles[0])).toEqual(expected);
    expect(search(other, 2, 4, profiles[1])).toEqual(nestedExpected);
  });

  it("does not refill graph-sized scratch arrays after warmup", async () => {
    const g = graph(101);
    const search = await freshSearch();
    expect(search(g, 0, 4, profiles[0])).not.toBeNull();
    const floatFill = vi.spyOn(Float64Array.prototype, "fill");
    const intFill = vi.spyOn(Int32Array.prototype, "fill");
    try {
      search(g, 2, 4, profiles[1]);
      expect(
        floatFill.mock.contexts.filter(
          (array) =>
            array instanceof Float64Array && array.length === g.nodeCount,
        ),
      ).toHaveLength(0);
      expect(
        intFill.mock.contexts.filter(
          (array) =>
            array instanceof Int32Array && array.length === g.nodeCount,
        ),
      ).toHaveLength(0);
    } finally {
      floatFill.mockRestore();
      intFill.mockRestore();
    }
  });
});
