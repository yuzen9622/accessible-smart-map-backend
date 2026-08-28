import { describe, expect, it } from "vitest";
import { haversineMeters } from "../../../../utils/geo";
import { NODE_FLAG, type PedGraph } from "./graph.types";
import { buildEdgeIndex, snapToGraph } from "./spatial-index";

function graphFromAdjacency(input: {
  nodeLon: number[];
  nodeLat: number[];
  nodeFlags: number[];
  adjOffset: number[];
  adjTarget: number[];
  adjAttr: number[];
}): PedGraph {
  const directedEdgeCount = input.adjTarget.length;
  return {
    versionId: 1,
    nodeCount: input.nodeLon.length,
    directedEdgeCount,
    undirectedEdgeCount: directedEdgeCount / 2,
    nodeLon: Float64Array.from(input.nodeLon),
    nodeLat: Float64Array.from(input.nodeLat),
    nodeFlags: Uint8Array.from(input.nodeFlags),
    nodeStationId: new Int32Array(input.nodeLon.length).fill(-1),
    stationIds: Object.freeze([]),
    stationRadiusM: new Float32Array(),
    originalNodeId: BigInt64Array.from(
      input.nodeLon.map((_, index) => BigInt(index)),
    ),
    adjOffset: Int32Array.from(input.adjOffset),
    adjTarget: Int32Array.from(input.adjTarget),
    adjAttr: Int32Array.from(input.adjAttr),
    edgeOriginalId: BigInt64Array.from(
      Array.from({ length: directedEdgeCount }, (_, attrIdx) =>
        BigInt(1_000 + attrIdx),
      ),
    ),
    edgeLengthM: new Float32Array(directedEdgeCount),
    edgeType: new Uint8Array(directedEdgeCount),
    edgeSlope: new Float32Array(directedEdgeCount),
    edgeSurface: new Uint8Array(directedEdgeCount),
    edgeSmoothness: new Uint8Array(directedEdgeCount),
    edgeWidthM: new Float32Array(directedEdgeCount),
    edgeWheelchair: new Uint8Array(directedEdgeCount),
    edgeStairCount: new Uint16Array(directedEdgeCount),
    edgeTraversalTimeS: new Float32Array(directedEdgeCount),
    edgeFlags: new Uint8Array(directedEdgeCount),
    edgeSidewalkId: new Int32Array(directedEdgeCount).fill(-1),
    sidewalkIds: Object.freeze([]),
    edgeSidewalkRampCount: new Uint16Array(directedEdgeCount),
    edgeStreetName: new Int32Array(directedEdgeCount).fill(-1),
    streetNames: Object.freeze([]),
  };
}

describe("buildEdgeIndex", () => {
  it("indexes only one real-geometry direction for each physical edge", () => {
    const graph = graphFromAdjacency({
      nodeLon: [121, 121.001, 121.002, 121.003],
      nodeLat: [25, 25, 25, 25],
      nodeFlags: [
        NODE_FLAG.HAS_REAL_GEOM,
        NODE_FLAG.HAS_REAL_GEOM,
        NODE_FLAG.HAS_REAL_GEOM,
        0,
      ],
      adjOffset: [0, 1, 2, 3, 4],
      adjTarget: [1, 0, 3, 2],
      adjAttr: [10, 11, 12, 13],
    });

    const index = buildEdgeIndex(graph);

    expect(index.indexedEdgeCount).toBe(1);
    expect(Array.from(index.edgeFromNode)).toEqual([0]);
    expect(Array.from(index.edgeToNode)).toEqual([1]);
    expect(Array.from(index.edgeAttrIdx)).toEqual([10]);
  });

  it("returns no result for an empty outdoor graph", () => {
    const index = buildEdgeIndex(
      graphFromAdjacency({
        nodeLon: [],
        nodeLat: [],
        nodeFlags: [],
        adjOffset: [0],
        adjTarget: [],
        adjAttr: [],
      }),
    );

    expect(index.indexedEdgeCount).toBe(0);
    expect(snapToGraph(index, 25, 121, 50)).toBeNull();
  });
});

describe("snapToGraph", () => {
  it("still snaps a one-way edge whose target sorts below its source", () => {
    const graph = graphFromAdjacency({
      nodeLon: [121, 121.002],
      nodeLat: [25, 25],
      nodeFlags: [NODE_FLAG.HAS_REAL_GEOM, NODE_FLAG.HAS_REAL_GEOM],
      adjOffset: [0, 0, 1],
      adjTarget: [0],
      adjAttr: [9],
    });
    const index = buildEdgeIndex(graph);

    expect(index.indexedEdgeCount).toBe(1);
    expect(snapToGraph(index, 25, 121.0001, 50)).toMatchObject({
      edgeAttrIdx: 9,
      nodeId: 0,
    });
  });

  it("selects the nearest routable endpoint when overlapping edge boxes match", () => {
    const graph = graphFromAdjacency({
      nodeLon: [121, 121.001, 121, 121.001],
      nodeLat: [25, 25.001, 25.0009, 25.0009],
      nodeFlags: [
        NODE_FLAG.HAS_REAL_GEOM,
        NODE_FLAG.HAS_REAL_GEOM,
        NODE_FLAG.HAS_REAL_GEOM,
        NODE_FLAG.HAS_REAL_GEOM,
      ],
      adjOffset: [0, 1, 2, 3, 4],
      adjTarget: [1, 0, 3, 2],
      adjAttr: [10, 11, 20, 21],
    });

    const result = snapToGraph(buildEdgeIndex(graph), 25.0009, 121.0001, 100);
    if (result === null) {
      throw new Error("expected the horizontal edge to snap");
    }

    const endpointDistance = haversineMeters(25.0009, 121.0001, 25.0009, 121);
    expect(result).toMatchObject({ nodeId: 2, edgeAttrIdx: 20 });
    expect(result.distanceM).toBeCloseTo(endpointDistance, 0);
  });

  it("returns a metre-scale accurate distance and enforces tolerance", () => {
    const graph = graphFromAdjacency({
      nodeLon: [121, 121.002],
      nodeLat: [25, 25],
      nodeFlags: [NODE_FLAG.HAS_REAL_GEOM, NODE_FLAG.HAS_REAL_GEOM],
      adjOffset: [0, 1, 2],
      adjTarget: [1, 0],
      adjAttr: [4, 5],
    });
    const index = buildEdgeIndex(graph);
    const lat = 25 + 100 / 111_195;
    const expectedDistance = haversineMeters(lat, 121, 25, 121);

    const result = snapToGraph(index, lat, 121, 110);
    if (result === null) {
      throw new Error("expected the nearby edge to snap");
    }

    expect(result).toMatchObject({ edgeAttrIdx: 4, nodeId: 0 });
    expect(result.distanceM).toBeCloseTo(expectedDistance, 0);
    expect(snapToGraph(index, lat, 121, 50)).toBeNull();
    expect(snapToGraph(index, lat, 121, -1)).toBeNull();
  });

  it("rejects a close mid-edge projection when both routable endpoints are too far", () => {
    const graph = graphFromAdjacency({
      nodeLon: [121, 121.004],
      nodeLat: [25, 25],
      nodeFlags: [NODE_FLAG.HAS_REAL_GEOM, NODE_FLAG.HAS_REAL_GEOM],
      adjOffset: [0, 1, 2],
      adjTarget: [1, 0],
      adjAttr: [4, 5],
    });
    const index = buildEdgeIndex(graph);

    // The request lies exactly on the edge's geometric midpoint, but each
    // endpoint is over 200 m away. Routing from either endpoint would teleport.
    expect(snapToGraph(index, 25, 121.002, 50)).toBeNull();
  });
});
