import { describe, expect, it } from "vitest";
import { collectRampPoints } from "./ramp-points";
import type { PedGraph } from "./graph.types";

/**
 * @param edgeRampPoints Ramp point coordinates keyed by dense edge attribute index.
 * @param edgeCount Number of directed edges in the fixture graph.
 * @returns A minimal CSR graph exposing only the field `collectRampPoints` reads.
 */
function createGraph(
  edgeRampPoints: ReadonlyMap<number, readonly [number, number][]>,
  edgeCount: number,
): PedGraph {
  return {
    versionId: 1,
    nodeCount: 0,
    directedEdgeCount: edgeCount,
    undirectedEdgeCount: edgeCount,
    nodeLon: new Float64Array(),
    nodeLat: new Float64Array(),
    nodeFlags: new Uint8Array(),
    nodeStationId: new Int32Array(),
    stationIds: Object.freeze([]),
    stationRadiusM: new Float32Array(),
    originalNodeId: new BigInt64Array(),
    adjOffset: new Int32Array(),
    adjTarget: new Int32Array(),
    adjAttr: new Int32Array(),
    edgeOriginalId: BigInt64Array.from(
      Array.from({ length: edgeCount }, (_, index) => BigInt(index)),
    ),
    edgeLengthM: new Float32Array(edgeCount),
    edgeType: new Uint8Array(edgeCount),
    edgeSlope: new Float32Array(edgeCount),
    edgeSurface: new Uint8Array(edgeCount),
    edgeSmoothness: new Uint8Array(edgeCount),
    edgeWidthM: new Float32Array(edgeCount),
    edgeWheelchair: new Uint8Array(edgeCount),
    edgeStairCount: new Uint16Array(edgeCount),
    edgeTraversalTimeS: new Float32Array(edgeCount),
    edgeFlags: new Uint8Array(edgeCount),
    edgeSidewalkId: new Int32Array(edgeCount).fill(-1),
    sidewalkIds: Object.freeze([]),
    edgeSidewalkRampCount: new Uint16Array(edgeCount),
    edgeStreetName: new Int32Array(edgeCount).fill(-1),
    streetNames: Object.freeze([]),
    edgeRampPoints,
  };
}

describe("collectRampPoints", () => {
  it("returns the ramp point recorded on a traversed edge", () => {
    const graph = createGraph(new Map([[0, [[121.5, 25.05]]]]), 1);

    const points = collectRampPoints(graph, Int32Array.from([0]));

    expect(points).toEqual([{ type: "curb_ramp", location: [121.5, 25.05] }]);
  });

  it("skips edges with no recorded ramp point", () => {
    const graph = createGraph(new Map(), 2);

    const points = collectRampPoints(graph, Int32Array.from([0, 1]));

    expect(points).toEqual([]);
  });

  it("de-duplicates the same coordinate seen on both directed edges of one corridor", () => {
    const graph = createGraph(
      new Map([
        [0, [[121.5, 25.05]]],
        [1, [[121.5, 25.05]]],
      ]),
      2,
    );

    const points = collectRampPoints(graph, Int32Array.from([0, 1]));

    expect(points).toEqual([{ type: "curb_ramp", location: [121.5, 25.05] }]);
  });

  it("preserves path order across multiple distinct ramp points", () => {
    const graph = createGraph(
      new Map([
        [0, [[121.51, 25.06]]],
        [1, [[121.5, 25.05]]],
      ]),
      2,
    );

    const points = collectRampPoints(graph, Int32Array.from([0, 1]));

    expect(points).toEqual([
      { type: "curb_ramp", location: [121.51, 25.06] },
      { type: "curb_ramp", location: [121.5, 25.05] },
    ]);
  });

  it("returns empty for an empty path", () => {
    const graph = createGraph(new Map(), 0);

    const points = collectRampPoints(graph, Int32Array.from([]));

    expect(points).toEqual([]);
  });
});
