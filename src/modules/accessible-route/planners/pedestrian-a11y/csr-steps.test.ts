import { describe, expect, it } from "vitest";
import { NAV_MSG } from "../../../../constants/messages";
import type { EdgeGeometrySpan } from "./a11y-segments";
import {
  STANDARD_STEEP_SLOPE_THRESHOLD_PERCENT,
  WHEELCHAIR_STEEP_SLOPE_THRESHOLD_PERCENT,
  buildCsrWalkSteps,
  turnDirection,
} from "./csr-steps";
import { EDGE_TYPE, NODE_FLAG, type PedGraph } from "./graph.types";
import type { LngLat } from "./ped-graph-geometry.repository";

interface EdgeFixture {
  edgeType: number;
  lengthM: number;
  slopeRatio: number;
}

interface NodeFixture {
  indoor: boolean;
}

/**
 * @param edges Edge attribute values, one per dense attribute index.
 * @param nodes Node attribute values, one per dense node index.
 * @returns A minimal CSR graph exposing only the fields `buildCsrWalkSteps` reads.
 */
function createGraph(
  edges: readonly Partial<EdgeFixture>[],
  nodes: readonly Partial<NodeFixture>[],
): PedGraph {
  const edgeCount = edges.length;
  const nodeCount = nodes.length;
  const edgeType = new Uint8Array(edgeCount);
  const edgeLengthM = new Float32Array(edgeCount);
  const edgeSlope = new Float32Array(edgeCount);
  edges.forEach((edge, index) => {
    edgeType[index] = edge.edgeType ?? EDGE_TYPE.SIDEWALK;
    edgeLengthM[index] = edge.lengthM ?? Number.NaN;
    edgeSlope[index] = edge.slopeRatio ?? Number.NaN;
  });

  const nodeFlags = new Uint8Array(nodeCount);
  nodes.forEach((node, index) => {
    nodeFlags[index] = node.indoor ? NODE_FLAG.INDOOR : 0;
  });

  return {
    versionId: 1,
    nodeCount,
    directedEdgeCount: edgeCount,
    undirectedEdgeCount: edgeCount,
    nodeLon: new Float64Array(nodeCount),
    nodeLat: new Float64Array(nodeCount),
    nodeFlags,
    nodeStationId: new Int32Array(nodeCount),
    stationIds: Object.freeze([]),
    stationRadiusM: new Float32Array(nodeCount),
    originalNodeId: new BigInt64Array(nodeCount),
    adjOffset: new Int32Array(),
    adjTarget: new Int32Array(),
    adjAttr: new Int32Array(),
    edgeOriginalId: BigInt64Array.from(
      Array.from({ length: edgeCount }, (_, index) => BigInt(index)),
    ),
    edgeLengthM,
    edgeType,
    edgeSlope,
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
  };
}

/**
 * @param count Number of adjacent single-step spans to generate.
 * @returns One two-point span per step, each contiguous with the previous.
 */
function contiguousSpans(count: number): EdgeGeometrySpan[] {
  return Array.from({ length: count }, (_, step) => ({
    startIndex: step,
    endIndex: step + 1,
  }));
}

/**
 * @param count Number of nodes to generate, all outdoor unless overridden.
 * @param overrides Sparse indoor overrides keyed by node index.
 * @returns One node fixture per index.
 */
function nodes(
  count: number,
  overrides: Record<number, boolean> = {},
): Partial<NodeFixture>[] {
  return Array.from({ length: count }, (_, index) => ({
    indoor: overrides[index] ?? false,
  }));
}

const BASE: LngLat = [121, 25];
const NORTH: LngLat = [121, 25.001];
const EAST: LngLat = [121.001, 25.001];

describe("turnDirection", () => {
  it("pins the 20° boundary, left and right", () => {
    expect(turnDirection(19.999)).toBe("CONTINUE");
    expect(turnDirection(20)).toBe("SLIGHTLY_RIGHT");
    expect(turnDirection(-19.999)).toBe("CONTINUE");
    expect(turnDirection(-20)).toBe("SLIGHTLY_LEFT");
  });

  it("pins the 45° boundary, left and right", () => {
    expect(turnDirection(44.999)).toBe("SLIGHTLY_RIGHT");
    expect(turnDirection(45)).toBe("RIGHT");
    expect(turnDirection(-44.999)).toBe("SLIGHTLY_LEFT");
    expect(turnDirection(-45)).toBe("LEFT");
  });

  it("pins the 135° boundary, left and right", () => {
    expect(turnDirection(134.999)).toBe("RIGHT");
    expect(turnDirection(135)).toBe("HARD_RIGHT");
    expect(turnDirection(-134.999)).toBe("LEFT");
    expect(turnDirection(-135)).toBe("HARD_LEFT");
  });
});

describe("buildCsrWalkSteps", () => {
  it("always reports DEPART for the first edge, even a facility edge", () => {
    const graph = createGraph(
      [{ edgeType: EDGE_TYPE.OSM_ELEVATOR }, { edgeType: EDGE_TYPE.SIDEWALK }],
      nodes(3),
    );
    const steps = buildCsrWalkSteps(
      graph,
      Int32Array.from([0, 1, 2]),
      Int32Array.from([0, 1]),
      contiguousSpans(2),
      [BASE, NORTH, EAST],
      0,
      "normal",
    );

    expect(steps[0].relativeDirection).toBe("DEPART");
  });

  it.each([
    ["ELEVATOR" as const, EDGE_TYPE.OSM_ELEVATOR, NAV_MSG.ELEVATOR],
    ["ELEVATOR" as const, EDGE_TYPE.INDOOR_ELEVATOR, NAV_MSG.ELEVATOR],
    ["ESCALATOR" as const, EDGE_TYPE.INDOOR_ESCALATOR, NAV_MSG.ESCALATOR],
    [
      "MOVING_WALKWAY" as const,
      EDGE_TYPE.INDOOR_MOVING_WALKWAY,
      NAV_MSG.MOVING_WALKWAY,
    ],
    ["FARE_GATE" as const, EDGE_TYPE.INDOOR_FARE_GATE, NAV_MSG.FARE_GATE],
    ["FARE_GATE" as const, EDGE_TYPE.INDOOR_EXIT_GATE, NAV_MSG.FARE_GATE],
  ])(
    "classifies edgeType %s (%d) as the facility token with its instruction text",
    (expectedDirection, edgeType, expectedInstruction) => {
      const graph = createGraph(
        [{ edgeType: EDGE_TYPE.SIDEWALK }, { edgeType }],
        nodes(3),
      );
      const steps = buildCsrWalkSteps(
        graph,
        Int32Array.from([0, 1, 2]),
        Int32Array.from([0, 1]),
        contiguousSpans(2),
        [BASE, NORTH, EAST],
        0,
        "normal",
      );

      expect(steps[1].relativeDirection).toBe(expectedDirection);
      expect(steps[1].instruction).toBe(expectedInstruction);
    },
  );

  it("classifies an outdoor-to-indoor node transition as ENTER_STATION", () => {
    const graph = createGraph(
      [{ edgeType: EDGE_TYPE.SIDEWALK }, { edgeType: EDGE_TYPE.SIDEWALK }],
      nodes(3, { 2: true }),
    );
    const steps = buildCsrWalkSteps(
      graph,
      Int32Array.from([0, 1, 2]),
      Int32Array.from([0, 1]),
      contiguousSpans(2),
      [BASE, NORTH, EAST],
      0,
      "normal",
    );

    expect(steps[1].relativeDirection).toBe("ENTER_STATION");
    expect(steps[1].instruction).toBe(NAV_MSG.ENTER_STATION);
  });

  it("classifies an indoor-to-outdoor node transition as EXIT_STATION", () => {
    const graph = createGraph(
      [{ edgeType: EDGE_TYPE.SIDEWALK }, { edgeType: EDGE_TYPE.SIDEWALK }],
      nodes(3, { 1: true }),
    );
    const steps = buildCsrWalkSteps(
      graph,
      Int32Array.from([0, 1, 2]),
      Int32Array.from([0, 1]),
      contiguousSpans(2),
      [BASE, NORTH, EAST],
      0,
      "normal",
    );

    expect(steps[1].relativeDirection).toBe("EXIT_STATION");
    expect(steps[1].instruction).toBe(NAV_MSG.EXIT_STATION);
  });

  it.each([EDGE_TYPE.STEPS, EDGE_TYPE.INDOOR_STAIRS])(
    "reports stairs: true for edgeType %d",
    (edgeType) => {
      const graph = createGraph(
        [{ edgeType: EDGE_TYPE.SIDEWALK }, { edgeType }],
        nodes(3),
      );
      const steps = buildCsrWalkSteps(
        graph,
        Int32Array.from([0, 1, 2]),
        Int32Array.from([0, 1]),
        contiguousSpans(2),
        [BASE, NORTH, EAST],
        0,
        "normal",
      );

      expect(steps[1].stairs).toBe(true);
    },
  );

  it("reports stairs: false for a plain sidewalk edge", () => {
    const graph = createGraph(
      [{ edgeType: EDGE_TYPE.SIDEWALK }, { edgeType: EDGE_TYPE.SIDEWALK }],
      nodes(3),
    );
    const steps = buildCsrWalkSteps(
      graph,
      Int32Array.from([0, 1, 2]),
      Int32Array.from([0, 1]),
      contiguousSpans(2),
      [BASE, NORTH, EAST],
      0,
      "normal",
    );

    expect(steps[1].stairs).toBe(false);
  });

  it("reports steepSlope: false below the wheelchair 8.3% threshold and true at/above it", () => {
    const below = createGraph(
      [{ slopeRatio: (WHEELCHAIR_STEEP_SLOPE_THRESHOLD_PERCENT - 1) / 100 }],
      nodes(2),
    );
    const above = createGraph(
      [{ slopeRatio: (WHEELCHAIR_STEEP_SLOPE_THRESHOLD_PERCENT + 1) / 100 }],
      nodes(2),
    );

    const belowSteps = buildCsrWalkSteps(
      below,
      Int32Array.from([0, 1]),
      Int32Array.from([0]),
      contiguousSpans(1),
      [BASE, NORTH],
      0,
      "wheelchair",
    );
    const aboveSteps = buildCsrWalkSteps(
      above,
      Int32Array.from([0, 1]),
      Int32Array.from([0]),
      contiguousSpans(1),
      [BASE, NORTH],
      0,
      "wheelchair",
    );

    expect(belowSteps[0].steepSlope).toBe(false);
    expect(aboveSteps[0].steepSlope).toBe(true);
  });

  it("reports steepSlope: false below the normal-mode 12% threshold and true at/above it", () => {
    const below = createGraph(
      [{ slopeRatio: (STANDARD_STEEP_SLOPE_THRESHOLD_PERCENT - 1) / 100 }],
      nodes(2),
    );
    const above = createGraph(
      [{ slopeRatio: (STANDARD_STEEP_SLOPE_THRESHOLD_PERCENT + 1) / 100 }],
      nodes(2),
    );

    const belowSteps = buildCsrWalkSteps(
      below,
      Int32Array.from([0, 1]),
      Int32Array.from([0]),
      contiguousSpans(1),
      [BASE, NORTH],
      0,
      "normal",
    );
    const aboveSteps = buildCsrWalkSteps(
      above,
      Int32Array.from([0, 1]),
      Int32Array.from([0]),
      contiguousSpans(1),
      [BASE, NORTH],
      0,
      "normal",
    );

    expect(belowSteps[0].steepSlope).toBe(false);
    expect(aboveSteps[0].steepSlope).toBe(true);
  });

  it("reports steepSlope: false when the edge has no slope measurement, in any mode", () => {
    const graph = createGraph([{}], nodes(2));

    const steps = buildCsrWalkSteps(
      graph,
      Int32Array.from([0, 1]),
      Int32Array.from([0]),
      contiguousSpans(1),
      [BASE, NORTH],
      0,
      "wheelchair",
    );

    expect(steps[0].steepSlope).toBe(false);
  });

  it("shifts the reported location by indexOffset", () => {
    const graph = createGraph([{ edgeType: EDGE_TYPE.SIDEWALK }], nodes(2));
    const polyline: LngLat[] = [[999, 999], BASE, NORTH];

    const steps = buildCsrWalkSteps(
      graph,
      Int32Array.from([0, 1]),
      Int32Array.from([0]),
      [{ startIndex: 0, endIndex: 1 }],
      polyline,
      1,
      "normal",
    );

    expect(steps[0].location).toEqual(BASE);
  });

  it("falls back to cumulative haversine distance when edgeLengthM is non-finite", () => {
    const graph = createGraph(
      [{ edgeType: EDGE_TYPE.SIDEWALK, lengthM: Number.NaN }],
      nodes(2),
    );
    const polyline: LngLat[] = [BASE, NORTH, EAST];

    const steps = buildCsrWalkSteps(
      graph,
      Int32Array.from([0, 1]),
      Int32Array.from([0]),
      [{ startIndex: 0, endIndex: 2 }],
      polyline,
      0,
      "normal",
    );

    expect(steps[0].distanceM).toBeGreaterThan(0);
    expect(Number.isFinite(steps[0].distanceM)).toBe(true);
  });

  it("falls back to cumulative haversine distance when edgeLengthM is negative", () => {
    const graph = createGraph(
      [{ edgeType: EDGE_TYPE.SIDEWALK, lengthM: -1 }],
      nodes(2),
    );
    const polyline: LngLat[] = [BASE, NORTH, EAST];

    const steps = buildCsrWalkSteps(
      graph,
      Int32Array.from([0, 1]),
      Int32Array.from([0]),
      [{ startIndex: 0, endIndex: 2 }],
      polyline,
      0,
      "normal",
    );

    expect(steps[0].distanceM).toBeGreaterThan(0);
  });

  it("emits streetName '' and bogusName true, matching the CSR graph's lack of street names", () => {
    const graph = createGraph([{ edgeType: EDGE_TYPE.SIDEWALK }], nodes(2));

    const steps = buildCsrWalkSteps(
      graph,
      Int32Array.from([0, 1]),
      Int32Array.from([0]),
      contiguousSpans(1),
      [BASE, NORTH],
      0,
      "normal",
    );

    expect(steps[0].streetName).toBe("");
    expect(steps[0].bogusName).toBe(true);
  });
});
