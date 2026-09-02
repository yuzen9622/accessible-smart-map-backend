import { describe, expect, it } from "vitest";
import {
  EDGE_TYPE,
  type PedGraph,
} from "../modules/accessible-route/planners/pedestrian-a11y/graph.types";
import { resolvePlannedPathSteps } from "./ped-router-planned-path";

/** @returns Parallel same-station fare-gate and sidewalk adjacencies. */
function parallelEdgeGraph(): PedGraph {
  return {
    versionId: 1,
    nodeCount: 2,
    directedEdgeCount: 3,
    undirectedEdgeCount: 3,
    nodeLon: Float64Array.of(121.5, 121.5001),
    nodeLat: Float64Array.of(25.05, 25.05),
    nodeFlags: new Uint8Array(2),
    nodeStationId: Int32Array.of(0, 0),
    stationIds: Object.freeze(["station-a"]),
    stationRadiusM: new Float32Array(2),
    originalNodeId: BigInt64Array.from([0n, 1n]),
    adjOffset: Int32Array.of(0, 3, 3),
    adjTarget: Int32Array.of(1, 1, 1),
    // The permitted equal-cost sidewalk edge 2 comes first among permitted edges.
    adjAttr: Int32Array.of(0, 2, 1),
    edgeOriginalId: BigInt64Array.of(1_000n, 1_001n, 1_002n),
    edgeLengthM: Float32Array.of(1, 2, 2),
    edgeType: Uint8Array.of(
      EDGE_TYPE.INDOOR_FARE_GATE,
      EDGE_TYPE.SIDEWALK,
      EDGE_TYPE.SIDEWALK,
    ),
    edgeSlope: Float32Array.of(Number.NaN, Number.NaN, Number.NaN),
    edgeSurface: new Uint8Array(3),
    edgeSmoothness: new Uint8Array(3),
    edgeWidthM: Float32Array.of(Number.NaN, Number.NaN, Number.NaN),
    edgeWheelchair: new Uint8Array(3),
    edgeStairCount: new Uint16Array(3),
    edgeTraversalTimeS: Float32Array.of(Number.NaN, Number.NaN, Number.NaN),
    edgeFlags: new Uint8Array(3),
    edgeSidewalkId: new Int32Array(3).fill(-1),
    sidewalkIds: Object.freeze([]),
    edgeSidewalkRampCount: new Uint16Array(3),
    edgeStreetName: new Int32Array(3).fill(-1),
    streetNames: Object.freeze([]),
    edgeRampPoints: new Map(),
  };
}

describe("resolvePlannedPathSteps", () => {
  it("skips a cheaper forbidden gate and deterministically keeps the first allowed tie", () => {
    const steps = resolvePlannedPathSteps(
      parallelEdgeGraph(),
      Int32Array.of(0, 1),
      (attrIdx) => (attrIdx === 0 ? 1 : 2),
    );

    expect(steps).toEqual([{ from: 0, to: 1, attrIdx: 2, value: 2 }]);
  });
});
