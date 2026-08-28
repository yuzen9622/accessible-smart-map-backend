import { describe, expect, it } from "vitest";
import {
  buildA11ySegments,
  classifyEdgeFeature,
  type EdgeGeometrySpan,
} from "./a11y-segments";
import { EDGE_FLAG, EDGE_TYPE, type PedGraph } from "./graph.types";

interface EdgeFixture {
  edgeType: number;
  flags: number;
  lengthM: number;
  slopeRatio: number;
  widthM: number;
}

/**
 * @param edges Edge attribute values, one per dense attribute index.
 * @returns A minimal CSR graph exposing only the edge attribute arrays that
 * `buildA11ySegments` reads.
 */
function createGraph(edges: readonly Partial<EdgeFixture>[]): PedGraph {
  const count = edges.length;
  const edgeType = new Uint8Array(count);
  const edgeFlags = new Uint8Array(count);
  const edgeLengthM = new Float32Array(count);
  const edgeSlope = new Float32Array(count);
  const edgeWidthM = new Float32Array(count);

  edges.forEach((edge, index) => {
    edgeType[index] = edge.edgeType ?? EDGE_TYPE.SIDEWALK;
    edgeFlags[index] = edge.flags ?? 0;
    edgeLengthM[index] = edge.lengthM ?? Number.NaN;
    edgeSlope[index] = edge.slopeRatio ?? Number.NaN;
    edgeWidthM[index] = edge.widthM ?? Number.NaN;
  });

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
    edgeLengthM,
    edgeType,
    edgeSlope,
    edgeSurface: new Uint8Array(count),
    edgeSmoothness: new Uint8Array(count),
    edgeWidthM,
    edgeWheelchair: new Uint8Array(count),
    edgeStairCount: new Uint16Array(count),
    edgeTraversalTimeS: new Float32Array(count),
    edgeFlags,
    edgeSidewalkId: new Int32Array(count).fill(-1),
    sidewalkIds: Object.freeze([]),
    edgeSidewalkRampCount: new Uint16Array(count),
    edgeStreetName: new Int32Array(count).fill(-1),
    streetNames: Object.freeze([]),
  };
}

/**
 * @param count Number of adjacent single-step spans to generate.
 * @param startAt First span's `startIndex`.
 * @returns One span per step, each contiguous with the previous.
 */
function contiguousSpans(count: number, startAt = 0): EdgeGeometrySpan[] {
  return Array.from({ length: count }, (_, step) => ({
    startIndex: startAt + step,
    endIndex: startAt + step + 1,
  }));
}

describe("classifyEdgeFeature", () => {
  it("classifies every edge type in the plan's precedence order", () => {
    expect(classifyEdgeFeature(EDGE_TYPE.OSM_ELEVATOR, 0)).toBe("elevator");
    expect(classifyEdgeFeature(EDGE_TYPE.INDOOR_ELEVATOR, 0)).toBe("elevator");
    expect(classifyEdgeFeature(EDGE_TYPE.INDOOR_ESCALATOR, 0)).toBe(
      "escalator",
    );
    expect(classifyEdgeFeature(EDGE_TYPE.INDOOR_MOVING_WALKWAY, 0)).toBe(
      "moving_walkway",
    );
    expect(classifyEdgeFeature(EDGE_TYPE.STEPS, 0)).toBe("stairs");
    expect(classifyEdgeFeature(EDGE_TYPE.INDOOR_STAIRS, 0)).toBe("stairs");
    expect(classifyEdgeFeature(EDGE_TYPE.INDOOR_FARE_GATE, 0)).toBe(
      "fare_gate",
    );
    expect(classifyEdgeFeature(EDGE_TYPE.INDOOR_EXIT_GATE, 0)).toBe(
      "exit_gate",
    );
    expect(classifyEdgeFeature(EDGE_TYPE.CROSSING, EDGE_FLAG.HAS_RAMP)).toBe(
      "curb_ramp_crossing",
    );
    expect(classifyEdgeFeature(EDGE_TYPE.CROSSING, 0)).toBe("crossing");
    expect(classifyEdgeFeature(EDGE_TYPE.SIDEWALK, EDGE_FLAG.HAS_RAMP)).toBe(
      "ramp",
    );
    expect(classifyEdgeFeature(EDGE_TYPE.SIDEWALK, 0)).toBeNull();
  });

  it("classifies a ramp-flagged elevator edge as elevator, not ramp", () => {
    expect(
      classifyEdgeFeature(EDGE_TYPE.OSM_ELEVATOR, EDGE_FLAG.HAS_RAMP),
    ).toBe("elevator");
  });
});

describe("buildA11ySegments", () => {
  it("merges adjacent edges of the same feature and indoor state into one run", () => {
    const graph = createGraph([
      { edgeType: EDGE_TYPE.CROSSING, flags: EDGE_FLAG.HAS_RAMP, lengthM: 5 },
      { edgeType: EDGE_TYPE.CROSSING, flags: EDGE_FLAG.HAS_RAMP, lengthM: 7 },
    ]);
    const edgeAttrPath = Int32Array.from([0, 1]);
    const spans = contiguousSpans(2);

    const segments = buildA11ySegments(graph, edgeAttrPath, spans, 0);

    expect(segments).toEqual([
      {
        feature: "curb_ramp_crossing",
        startIndex: 0,
        endIndex: 2,
        indoor: false,
        distanceM: 12,
        maxSlopePercent: null,
        minWidthCm: null,
      },
    ]);
  });

  it("does not merge across an unclassified run in between", () => {
    const graph = createGraph([
      { edgeType: EDGE_TYPE.CROSSING, flags: EDGE_FLAG.HAS_RAMP, lengthM: 5 },
      { edgeType: EDGE_TYPE.SIDEWALK, flags: 0, lengthM: 20 },
      { edgeType: EDGE_TYPE.CROSSING, flags: EDGE_FLAG.HAS_RAMP, lengthM: 5 },
    ]);
    const edgeAttrPath = Int32Array.from([0, 1, 2]);
    const spans = contiguousSpans(3);

    const segments = buildA11ySegments(graph, edgeAttrPath, spans, 0);

    expect(segments).toHaveLength(2);
    expect(segments[0]).toMatchObject({ startIndex: 0, endIndex: 1 });
    expect(segments[1]).toMatchObject({ startIndex: 2, endIndex: 3 });
  });

  it("never produces a run for an unclassified edge", () => {
    const graph = createGraph([{ edgeType: EDGE_TYPE.SIDEWALK, flags: 0 }]);
    const segments = buildA11ySegments(
      graph,
      Int32Array.from([0]),
      contiguousSpans(1),
      0,
    );

    expect(segments).toEqual([]);
  });

  it("does not merge two adjacent same-feature edges when their indoor state differs", () => {
    const graph = createGraph([
      {
        edgeType: EDGE_TYPE.INDOOR_STAIRS,
        flags: EDGE_FLAG.INDOOR,
        lengthM: 4,
      },
      { edgeType: EDGE_TYPE.STEPS, flags: 0, lengthM: 4 },
    ]);
    const segments = buildA11ySegments(
      graph,
      Int32Array.from([0, 1]),
      contiguousSpans(2),
      0,
    );

    expect(segments).toHaveLength(2);
    expect(segments[0].indoor).toBe(true);
    expect(segments[1].indoor).toBe(false);
  });

  it("reports distanceM as null for the whole run when any edge lacks a usable length", () => {
    const graph = createGraph([
      { edgeType: EDGE_TYPE.CROSSING, flags: EDGE_FLAG.HAS_RAMP, lengthM: 5 },
      {
        edgeType: EDGE_TYPE.CROSSING,
        flags: EDGE_FLAG.HAS_RAMP,
        lengthM: Number.NaN,
      },
    ]);
    const segments = buildA11ySegments(
      graph,
      Int32Array.from([0, 1]),
      contiguousSpans(2),
      0,
    );

    expect(segments).toHaveLength(1);
    expect(segments[0].distanceM).toBeNull();
  });

  it("reports distanceM as null when the first edge lacks a usable length, even though the second edge has one", () => {
    const graph = createGraph([
      {
        edgeType: EDGE_TYPE.CROSSING,
        flags: EDGE_FLAG.HAS_RAMP,
        lengthM: Number.NaN,
      },
      { edgeType: EDGE_TYPE.CROSSING, flags: EDGE_FLAG.HAS_RAMP, lengthM: 5 },
    ]);
    const segments = buildA11ySegments(
      graph,
      Int32Array.from([0, 1]),
      contiguousSpans(2),
      0,
    );

    expect(segments).toHaveLength(1);
    expect(segments[0].distanceM).toBeNull();
  });

  it("reports distanceM as null for the whole run when an edge's length is negative", () => {
    const graph = createGraph([
      { edgeType: EDGE_TYPE.CROSSING, flags: EDGE_FLAG.HAS_RAMP, lengthM: 5 },
      {
        edgeType: EDGE_TYPE.CROSSING,
        flags: EDGE_FLAG.HAS_RAMP,
        lengthM: -1,
      },
    ]);
    const segments = buildA11ySegments(
      graph,
      Int32Array.from([0, 1]),
      contiguousSpans(2),
      0,
    );

    expect(segments).toHaveLength(1);
    expect(segments[0].distanceM).toBeNull();
  });

  it("applies indexOffset to every emitted index", () => {
    const graph = createGraph([
      { edgeType: EDGE_TYPE.CROSSING, flags: EDGE_FLAG.HAS_RAMP, lengthM: 5 },
    ]);
    const segments = buildA11ySegments(
      graph,
      Int32Array.from([0]),
      [{ startIndex: 0, endIndex: 1 }],
      1,
    );

    expect(segments).toEqual([
      {
        feature: "curb_ramp_crossing",
        startIndex: 1,
        endIndex: 2,
        indoor: false,
        distanceM: 5,
        maxSlopePercent: null,
        minWidthCm: null,
      },
    ]);
  });

  it("preserves a zero-length span as a point feature", () => {
    const graph = createGraph([
      {
        edgeType: EDGE_TYPE.INDOOR_ELEVATOR,
        flags: EDGE_FLAG.INDOOR,
        lengthM: Number.NaN,
      },
    ]);
    const segments = buildA11ySegments(
      graph,
      Int32Array.from([0]),
      [{ startIndex: 3, endIndex: 3 }],
      0,
    );

    expect(segments).toEqual([
      {
        feature: "elevator",
        startIndex: 3,
        endIndex: 3,
        indoor: true,
        distanceM: null,
        maxSlopePercent: null,
        minWidthCm: null,
      },
    ]);
  });

  it("takes the steepest slope and narrowest width across a merged run", () => {
    const graph = createGraph([
      {
        edgeType: EDGE_TYPE.SIDEWALK,
        flags: EDGE_FLAG.HAS_RAMP,
        lengthM: 5,
        slopeRatio: 0.05,
        widthM: 1.5,
      },
      {
        edgeType: EDGE_TYPE.SIDEWALK,
        flags: EDGE_FLAG.HAS_RAMP,
        lengthM: 5,
        slopeRatio: -0.08,
        widthM: 0.9,
      },
    ]);
    const segments = buildA11ySegments(
      graph,
      Int32Array.from([0, 1]),
      contiguousSpans(2),
      0,
    );

    expect(segments).toHaveLength(1);
    expect(segments[0].maxSlopePercent).toBeCloseTo(8, 4);
    expect(segments[0].minWidthCm).toBe(90);
  });

  it("stops at the shorter of spans and edgeAttrPath", () => {
    const graph = createGraph([
      { edgeType: EDGE_TYPE.CROSSING, flags: EDGE_FLAG.HAS_RAMP, lengthM: 5 },
      { edgeType: EDGE_TYPE.CROSSING, flags: EDGE_FLAG.HAS_RAMP, lengthM: 5 },
    ]);
    const segments = buildA11ySegments(
      graph,
      Int32Array.from([0, 1]),
      [{ startIndex: 0, endIndex: 1 }],
      0,
    );

    expect(segments).toHaveLength(1);
    expect(segments[0].endIndex).toBe(1);
  });
});
