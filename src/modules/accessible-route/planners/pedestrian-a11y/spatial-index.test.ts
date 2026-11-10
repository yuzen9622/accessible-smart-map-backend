import { describe, expect, it } from "vitest";
import { haversineMeters } from "../../../../utils/geo";
import { EDGE_TYPE, NODE_FLAG, type PedGraph } from "./graph.types";
import {
  buildEdgeIndex,
  nearestOutdoorPoint,
  snapToGraph,
} from "./spatial-index";

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
    edgeRampPoints: new Map(),
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

describe("nearestOutdoorPoint", () => {
  const corridorAboveStreet = () => {
    const graph = graphFromAdjacency({
      nodeLon: [121, 121.001, 121, 121.001],
      nodeLat: [25, 25, 25.000135, 25.000135],
      nodeFlags: Array(4).fill(NODE_FLAG.HAS_REAL_GEOM),
      adjOffset: [0, 1, 2, 3, 4],
      adjTarget: [1, 0, 3, 2],
      adjAttr: [0, 1, 2, 3],
    });
    graph.edgeType.set([
      EDGE_TYPE.INDOOR_WALKWAY,
      EDGE_TYPE.INDOOR_WALKWAY,
      EDGE_TYPE.SIDEWALK,
      EDGE_TYPE.SIDEWALK,
    ]);
    return buildEdgeIndex(graph);
  };

  it("skips a closer indoor corridor and projects onto the street-level walkway", () => {
    const point = nearestOutdoorPoint(
      corridorAboveStreet(),
      25.00001,
      121.0005,
      30,
    );

    expect(point).not.toBeNull();
    expect(point!.lat).toBeCloseTo(25.000135, 6);
    expect(point!.lng).toBeCloseTo(121.0005, 6);
    expect(point!.distanceM).toBeGreaterThan(13);
    expect(point!.distanceM).toBeLessThan(15);
  });

  it("returns null when no outdoor walkway is within tolerance", () => {
    expect(
      nearestOutdoorPoint(corridorAboveStreet(), 25.00001, 121.0005, 10),
    ).toBeNull();
  });
});

/**
 * A straight west-to-east chain of two-way edges about one metre apart, plus
 * extra two-way edges between any listed node pairs.
 */
function chainGraph(
  chainLength: number,
  extraNodes: { lon: number; lat: number }[],
  extraEdges: { from: number; to: number; type?: number }[],
): PedGraph {
  const nodeLon = Array.from({ length: chainLength }, (_, i) => 121 + i * 1e-5);
  const nodeLat = Array.from({ length: chainLength }, () => 25);
  for (const node of extraNodes) {
    nodeLon.push(node.lon);
    nodeLat.push(node.lat);
  }
  const pairs: { from: number; to: number; type: number }[] = [];
  for (let i = 0; i + 1 < chainLength; i += 1) {
    pairs.push({ from: i, to: i + 1, type: EDGE_TYPE.FOOTWAY });
  }
  for (const edge of extraEdges) {
    pairs.push({ ...edge, type: edge.type ?? EDGE_TYPE.FOOTWAY });
  }
  const neighbours: { to: number; type: number }[][] = nodeLon.map(() => []);
  for (const { from, to, type } of pairs) {
    neighbours[from].push({ to, type });
    neighbours[to].push({ to: from, type });
  }
  const adjOffset = [0];
  const adjTarget: number[] = [];
  const types: number[] = [];
  for (const list of neighbours) {
    for (const { to, type } of list) {
      adjTarget.push(to);
      types.push(type);
    }
    adjOffset.push(adjTarget.length);
  }
  const graph = graphFromAdjacency({
    nodeLon,
    nodeLat,
    nodeFlags: nodeLon.map(() => NODE_FLAG.HAS_REAL_GEOM),
    adjOffset,
    adjTarget,
    adjAttr: adjTarget.map((_, i) => i),
  });
  graph.edgeType.set(types);
  return graph;
}

describe("snapToGraph endpoint preference", () => {
  it("prefers a farther endpoint on the main network over a nearer isolated fragment", () => {
    const graph = chainGraph(
      60,
      [
        { lon: 121.0003, lat: 25.00005 },
        { lon: 121.00031, lat: 25.00005 },
      ],
      [{ from: 60, to: 61 }],
    );
    const index = buildEdgeIndex(graph);

    expect(index.nodeComponentSize[30]).toBe(60);
    expect(index.nodeComponentSize[60]).toBe(2);
    expect(snapToGraph(index, 25.00004, 121.0003, 50)?.nodeId).toBe(30);
  });

  it("still snaps to a fragment when nothing larger is within tolerance", () => {
    const graph = chainGraph(
      60,
      [
        { lon: 121.0003, lat: 25.00005 },
        { lon: 121.00031, lat: 25.00005 },
      ],
      [{ from: 60, to: 61 }],
    );

    expect(
      snapToGraph(buildEdgeIndex(graph), 25.00004, 121.0003, 3)?.nodeId,
    ).toBe(60);
  });

  it("keeps a stairs-only endpoint as a last resort when stairs are barred", () => {
    const graph = chainGraph(
      60,
      [{ lon: 121 + 62 * 1e-5, lat: 25 }],
      [{ from: 59, to: 60, type: EDGE_TYPE.STEPS }],
    );
    const index = buildEdgeIndex(graph);
    const lon = 121 + 62 * 1e-5;

    expect(snapToGraph(index, 25, lon, 50)?.nodeId).toBe(60);
    expect(snapToGraph(index, 25, lon, 50, { avoidStairs: true })?.nodeId).toBe(
      59,
    );
    expect(snapToGraph(index, 25, lon, 1, { avoidStairs: true })?.nodeId).toBe(
      60,
    );
  });
});
