import { describe, expect, it } from "vitest";
import { sumSidewalkRampCount } from "./sidewalk-ramp-count";
import type { PedGraph } from "./graph.types";

/**
 * @param sidewalkId Interned sidewalk id per dense edge attribute index.
 * @param rampCount Ramp count per dense edge attribute index.
 * @returns A minimal CSR graph exposing only the edge attribute arrays that
 * `sumSidewalkRampCount` reads.
 */
function createGraph(
  sidewalkId: readonly number[],
  rampCount: readonly number[],
): PedGraph {
  const count = sidewalkId.length;
  return {
    versionId: 1,
    nodeCount: 0,
    directedEdgeCount: count,
    undirectedEdgeCount: count,
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
      Array.from({ length: count }, (_, index) => BigInt(index)),
    ),
    edgeLengthM: new Float32Array(count),
    edgeType: new Uint8Array(count),
    edgeSlope: new Float32Array(count),
    edgeSurface: new Uint8Array(count),
    edgeSmoothness: new Uint8Array(count),
    edgeWidthM: new Float32Array(count),
    edgeWheelchair: new Uint8Array(count),
    edgeStairCount: new Uint16Array(count),
    edgeTraversalTimeS: new Float32Array(count),
    edgeFlags: new Uint8Array(count),
    edgeSidewalkId: Int32Array.from(sidewalkId),
    sidewalkIds: Object.freeze(
      Array.from(new Set(sidewalkId.filter((id) => id !== -1))).map(
        (id) => `sidewalk:${id}`,
      ),
    ),
    edgeSidewalkRampCount: Uint16Array.from(rampCount),
    edgeStreetName: new Int32Array(count).fill(-1),
    streetNames: Object.freeze([]),
    edgeRampPoints: new Map(),
  };
}

describe("sumSidewalkRampCount", () => {
  it("counts a sidewalk id spanning three traversed edges exactly once", () => {
    const graph = createGraph([0, 0, 0], [6, 6, 6]);

    const total = sumSidewalkRampCount(graph, Int32Array.from([0, 1, 2]));

    expect(total).toBe(6);
  });

  it("sums two distinct sidewalk ids", () => {
    const graph = createGraph([0, 1], [6, 3]);

    const total = sumSidewalkRampCount(graph, Int32Array.from([0, 1]));

    expect(total).toBe(9);
  });

  it("skips edges with no matched sidewalk", () => {
    const graph = createGraph([0, -1, -1], [6, 0, 0]);

    const total = sumSidewalkRampCount(graph, Int32Array.from([0, 1, 2]));

    expect(total).toBe(6);
  });

  it("returns 0 for an empty path", () => {
    const graph = createGraph([], []);

    const total = sumSidewalkRampCount(graph, Int32Array.from([]));

    expect(total).toBe(0);
  });

  it("counts an interleaved sidewalk id once even when revisited", () => {
    const graph = createGraph([0, 1, 0], [6, 3, 6]);

    const total = sumSidewalkRampCount(graph, Int32Array.from([0, 1, 2]));

    expect(total).toBe(9);
  });
});
