import { describe, expect, it } from "vitest";
import {
  WHEELCHAIR_RELAX_STEPS_LEVEL,
  WHEELCHAIR_WALK_SPEED_MPS,
  edgeCost,
  type CostProfile,
} from "./cost";
import { dijkstra } from "./dijkstra";
import { EDGE_TYPE, type PedGraph } from "./graph.types";

interface EdgeDefinition {
  from: number;
  to: number;
  lengthM: number;
  slopeRatio?: number;
  edgeType?: number;
}

/**
 * @param nodeCount Number of dense graph nodes.
 * @param edges Directed edge definitions.
 * @returns A neutral CSR graph containing the supplied edge attributes.
 */
function graphFromEdges(nodeCount: number, edges: EdgeDefinition[]): PedGraph {
  const adjOffset = new Int32Array(nodeCount + 1);
  const adjTarget = new Int32Array(edges.length);
  const adjAttr = new Int32Array(edges.length);
  const edgeSlope = new Float32Array(edges.length);
  edgeSlope.fill(Number.NaN);
  for (const edge of edges) {
    adjOffset[edge.from + 1] += 1;
  }
  for (let node = 1; node < adjOffset.length; node += 1) {
    adjOffset[node] += adjOffset[node - 1];
  }
  const writeOffset = new Int32Array(nodeCount);
  writeOffset.set(adjOffset.subarray(0, nodeCount));
  for (let attrIdx = 0; attrIdx < edges.length; attrIdx += 1) {
    const edge = edges[attrIdx];
    const adjacencyIndex = writeOffset[edge.from];
    adjTarget[adjacencyIndex] = edge.to;
    adjAttr[adjacencyIndex] = attrIdx;
    writeOffset[edge.from] += 1;
    edgeSlope[attrIdx] = edge.slopeRatio ?? Number.NaN;
  }
  const nodeLon = Float64Array.from(
    Array.from({ length: nodeCount }, (_, node) => 121.5 + node * 0.0001),
  );

  return {
    versionId: 1,
    nodeCount,
    directedEdgeCount: edges.length,
    undirectedEdgeCount: edges.length,
    nodeLon,
    nodeLat: Float64Array.from(new Array(nodeCount).fill(25.05)),
    nodeFlags: new Uint8Array(nodeCount),
    nodeStationId: new Int32Array(nodeCount).fill(-1),
    stationIds: Object.freeze([]),
    stationRadiusM: new Float32Array(),
    originalNodeId: BigInt64Array.from(
      Array.from({ length: nodeCount }, (_, node) => BigInt(node)),
    ),
    adjOffset,
    adjTarget,
    adjAttr,
    edgeOriginalId: BigInt64Array.from(
      edges.map((_edge, attrIdx) => BigInt(1_000 + attrIdx)),
    ),
    edgeLengthM: Float32Array.from(edges.map((edge) => edge.lengthM)),
    edgeType: Uint8Array.from(
      edges.map((edge) => edge.edgeType ?? EDGE_TYPE.SIDEWALK),
    ),
    edgeSlope,
    edgeSurface: new Uint8Array(edges.length),
    edgeSmoothness: new Uint8Array(edges.length),
    edgeWidthM: Float32Array.from(new Array(edges.length).fill(Number.NaN)),
    edgeWheelchair: new Uint8Array(edges.length),
    edgeStairCount: new Uint16Array(edges.length),
    edgeTraversalTimeS: Float32Array.from(
      new Array(edges.length).fill(Number.NaN),
    ),
    edgeFlags: new Uint8Array(edges.length),
    edgeSidewalkId: new Int32Array(edges.length).fill(-1),
    sidewalkIds: Object.freeze([]),
    edgeSidewalkRampCount: new Uint16Array(edges.length),
    edgeStreetName: new Int32Array(edges.length).fill(-1),
    streetNames: Object.freeze([]),
    edgeRampPoints: new Map(),
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

describe("dijkstra", () => {
  it("uses edgeCost to choose the least-cost route", () => {
    const graph = graphFromEdges(3, [
      { from: 0, to: 2, lengthM: 100, slopeRatio: 0.08 },
      { from: 0, to: 1, lengthM: 75 },
      { from: 1, to: 2, lengthM: 75 },
    ]);
    const result = dijkstra(graph, 0, 2, wheelchairProfile());

    expect(result).not.toBeNull();
    expect(Array.from(result?.nodePath ?? [])).toEqual([0, 1, 2]);
    expect(result?.totalCost).toBe(
      edgeCost(graph, 1, wheelchairProfile()) +
        edgeCost(graph, 2, wheelchairProfile()),
    );
    expect(result?.reopenedNodes).toBe(0);
  });

  it("skips infeasible edges and adopts them only after the matching relaxation", () => {
    const graph = graphFromEdges(3, [
      { from: 0, to: 2, lengthM: 10, edgeType: EDGE_TYPE.STEPS },
      { from: 0, to: 1, lengthM: 100 },
      { from: 1, to: 2, lengthM: 100 },
    ]);
    const strict = dijkstra(graph, 0, 2, wheelchairProfile());
    const relaxed = dijkstra(
      graph,
      0,
      2,
      wheelchairProfile(WHEELCHAIR_RELAX_STEPS_LEVEL),
    );

    expect(strict).not.toBeNull();
    expect(Array.from(strict?.nodePath ?? [])).toEqual([0, 1, 2]);
    expect(strict?.totalCost).toBe(200);
    expect(relaxed).not.toBeNull();
    expect(Array.from(relaxed?.nodePath ?? [])).toEqual([0, 2]);
    expect(relaxed?.totalCost).toBe(
      edgeCost(graph, 0, wheelchairProfile(WHEELCHAIR_RELAX_STEPS_LEVEL)),
    );
  });

  it("returns null for invalid or unreachable endpoints", () => {
    const graph = graphFromEdges(2, []);

    expect(dijkstra(graph, -1, 1, wheelchairProfile())).toBeNull();
    expect(dijkstra(graph, 0, 2, wheelchairProfile())).toBeNull();
    expect(dijkstra(graph, 0, 1, wheelchairProfile())).toBeNull();
    expect(dijkstra(graph, 1, 1, wheelchairProfile())).toEqual({
      nodePath: Int32Array.of(1),
      edgeAttrPath: new Int32Array(0),
      totalCost: 0,
      expandedNodes: 0,
      reopenedNodes: 0,
    });
  });

  it("plans every accessibility mode without throwing and stays neutral outside wheelchair", () => {
    // The direct 0 -> 2 edge is steeper than the wheelchair hard slope limit,
    // so wheelchair must detour while a neutral profile takes the short edge.
    const graph = graphFromEdges(3, [
      { from: 0, to: 1, lengthM: 100 },
      { from: 1, to: 2, lengthM: 100 },
      { from: 0, to: 2, lengthM: 150, slopeRatio: 0.2 },
    ]);

    const wheelchair = dijkstra(graph, 0, 2, wheelchairProfile());
    expect(Array.from(wheelchair?.nodePath ?? [])).toEqual([0, 1, 2]);

    for (const name of ["normal", "elderly", "visual_impaired"] as const) {
      const result = dijkstra(graph, 0, 2, {
        name,
        walkSpeedMps: 1.3,
        relaxationLevel: 0,
      });
      expect(Array.from(result?.nodePath ?? [])).toEqual([0, 2]);
      expect(result?.totalCost).toBeCloseTo(150, 4);
    }
  });

  it("reports the exact selected directed edge for each traversal", () => {
    const graph = graphFromEdges(3, [
      { from: 0, to: 1, lengthM: 100 },
      { from: 1, to: 2, lengthM: 100 },
    ]);

    const result = dijkstra(graph, 0, 2, wheelchairProfile());

    expect(Array.from(result?.edgeAttrPath ?? [])).toEqual([0, 1]);
    expect(result?.edgeAttrPath).toHaveLength(
      (result?.nodePath.length ?? 0) - 1,
    );
  });
});
