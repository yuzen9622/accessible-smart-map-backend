import { describe, expect, it } from "vitest";
import {
  INFEASIBLE,
  MINIMUM_ADDITIVE_PENALTY_M,
  UNMEASURABLE_INDOOR_PROXY_COST_M,
  MINIMUM_PENALTY_MULTIPLIER,
  WHEELCHAIR_BAD_SMOOTHNESS_PENALTY_MULTIPLIER,
  WHEELCHAIR_EXTREME_SLOPE_PERCENT,
  WHEELCHAIR_HORRIBLE_SMOOTHNESS_PENALTY_MULTIPLIER,
  WHEELCHAIR_INTERMEDIATE_SMOOTHNESS_PENALTY_MULTIPLIER,
  WHEELCHAIR_LIMITED_TAG_PENALTY_MULTIPLIER,
  WHEELCHAIR_LOOSE_SURFACE_PENALTY_MULTIPLIER,
  WHEELCHAIR_MEDIUM_WIDTH_M,
  WHEELCHAIR_MEDIUM_WIDTH_PENALTY_MULTIPLIER,
  WHEELCHAIR_MIN_EFFECTIVE_WIDTH_M,
  WHEELCHAIR_MODERATE_SLOPE_PENALTY_MULTIPLIER,
  WHEELCHAIR_NARROW_WIDTH_M,
  WHEELCHAIR_NARROW_WIDTH_PENALTY_MULTIPLIER,
  WHEELCHAIR_RELAXED_EXTREME_SLOPE_PENALTY_MULTIPLIER,
  WHEELCHAIR_RELAXED_MIN_WIDTH_PENALTY_MULTIPLIER,
  WHEELCHAIR_RELAXED_STEPS_PENALTY_MULTIPLIER,
  WHEELCHAIR_ESCALATOR_PENALTY_MULTIPLIER,
  WHEELCHAIR_MAX_RELAXATION_LEVEL,
  WHEELCHAIR_RELAX_EXTREME_SLOPE_LEVEL,
  WHEELCHAIR_RELAX_NARROW_WIDTH_LEVEL,
  WHEELCHAIR_RELAX_STEPS_LEVEL,
  WHEELCHAIR_STEEP_SLOPE_PENALTY_MULTIPLIER,
  WHEELCHAIR_UNSTABLE_SURFACE_PENALTY_MULTIPLIER,
  WHEELCHAIR_VERY_BAD_SMOOTHNESS_PENALTY_MULTIPLIER,
  WHEELCHAIR_VERY_HORRIBLE_SMOOTHNESS_PENALTY_MULTIPLIER,
  WHEELCHAIR_WALK_SPEED_MPS,
  WHEELCHAIR_WIDE_WIDTH_M,
  WHEELCHAIR_WIDE_WIDTH_PENALTY_MULTIPLIER,
  edgeCost,
  type CostProfile,
} from "./cost";
import {
  EDGE_FLAG,
  EDGE_TYPE,
  SMOOTHNESS,
  SURFACE,
  WHEELCHAIR,
  type PedGraph,
} from "./graph.types";

interface EdgeFixture {
  lengthM: number;
  slopeRatio: number;
  surface: number;
  smoothness: number;
  widthM: number;
  wheelchair: number;
  traversalTimeS: number;
  edgeType: number;
  flags: number;
}

/**
 * @param edge Edge values to place at attribute index zero.
 * @returns A minimal CSR graph containing the supplied edge attributes.
 */
function createGraph(edge: Partial<EdgeFixture> = {}): PedGraph {
  return {
    versionId: 1,
    nodeCount: 2,
    directedEdgeCount: 1,
    undirectedEdgeCount: 1,
    nodeLon: Float64Array.from([121.5, 121.501]),
    nodeLat: Float64Array.from([25.05, 25.05]),
    nodeFlags: new Uint8Array(2),
    nodeStationId: Int32Array.from([-1, -1]),
    stationIds: Object.freeze([]),
    stationRadiusM: new Float32Array(),
    originalNodeId: BigInt64Array.from([0n, 1n]),
    adjOffset: Int32Array.from([0, 1, 1]),
    adjTarget: Int32Array.from([1]),
    adjAttr: Int32Array.from([0]),
    edgeOriginalId: BigInt64Array.from([9_001n]),
    edgeLengthM: Float32Array.from([edge.lengthM ?? 100]),
    edgeType: Uint8Array.from([edge.edgeType ?? EDGE_TYPE.SIDEWALK]),
    edgeSlope: Float32Array.from([edge.slopeRatio ?? Number.NaN]),
    edgeSurface: Uint8Array.from([edge.surface ?? SURFACE.UNKNOWN]),
    edgeSmoothness: Uint8Array.from([edge.smoothness ?? SMOOTHNESS.UNKNOWN]),
    edgeWidthM: Float32Array.from([edge.widthM ?? Number.NaN]),
    edgeWheelchair: Uint8Array.from([edge.wheelchair ?? WHEELCHAIR.UNKNOWN]),
    edgeStairCount: new Uint16Array(1),
    edgeTraversalTimeS: Float32Array.from([edge.traversalTimeS ?? Number.NaN]),
    edgeFlags: Uint8Array.from([edge.flags ?? 0]),
    edgeSidewalkId: Int32Array.from([-1]),
    sidewalkIds: Object.freeze([]),
    edgeSidewalkRampCount: new Uint16Array(1),
    edgeStreetName: Int32Array.from([-1]),
    streetNames: Object.freeze([]),
  };
}

/**
 * @param relaxationLevel Cumulative wheelchair relaxation level.
 * @param walkSpeedMps Walking speed used for indoor equivalent metres.
 * @returns A wheelchair cost profile.
 */
function wheelchairProfile(
  relaxationLevel = 0,
  walkSpeedMps = WHEELCHAIR_WALK_SPEED_MPS,
): CostProfile {
  return { name: "wheelchair", walkSpeedMps, relaxationLevel };
}

describe("edgeCost", () => {
  it("rejects invalid edge indices", () => {
    const graph = createGraph();

    expect(edgeCost(graph, -1, wheelchairProfile())).toBe(INFEASIBLE);
    expect(edgeCost(graph, 0.5, wheelchairProfile())).toBe(INFEASIBLE);
  });

  it("costs the three neutral profiles as base traversal without any penalty", () => {
    // Every wheelchair penalty dimension is set to its worst value at once: a
    // neutral profile must still return the plain base traversal cost, proving
    // no elderly or visual-impairment penalty was invented.
    const graph = createGraph({
      lengthM: 100,
      slopeRatio: 0.3,
      surface: SURFACE.SAND,
      smoothness: SMOOTHNESS.VERY_HORRIBLE,
      widthM: 0.4,
      wheelchair: WHEELCHAIR.NO,
      edgeType: EDGE_TYPE.STEPS,
    });

    for (const name of ["normal", "elderly", "visual_impaired"] as const) {
      for (const relaxationLevel of [0, 1, 2, 3]) {
        expect(
          edgeCost(graph, 0, { name, walkSpeedMps: 1.3, relaxationLevel }),
        ).toBe(100);
      }
    }
    expect(edgeCost(graph, 0, wheelchairProfile())).toBe(INFEASIBLE);
  });

  it("keeps neutral indoor cost at traversal time times the profile speed", () => {
    const graph = createGraph({
      lengthM: Number.NaN,
      traversalTimeS: 20,
      flags: EDGE_FLAG.INDOOR,
      edgeType: EDGE_TYPE.INDOOR_WALKWAY,
    });

    expect(
      edgeCost(graph, 0, {
        name: "normal",
        walkSpeedMps: 1.3,
        relaxationLevel: 0,
      }),
    ).toBeCloseTo(26, 4);
  });

  it("leaves every wheelchair cost unchanged for the four API modes call surface", () => {
    const graph = createGraph({ lengthM: 100, slopeRatio: 0.06 });

    // Locked wheelchair value: 100 m at 6% keeps the moderate-slope multiplier.
    expect(edgeCost(graph, 0, wheelchairProfile())).toBeCloseTo(150, 4);
    for (const name of [
      "wheelchair",
      "normal",
      "elderly",
      "visual_impaired",
    ] as const) {
      expect(() =>
        edgeCost(graph, 0, { name, walkSpeedMps: 1, relaxationLevel: 0 }),
      ).not.toThrow();
    }
  });

  it("uses outdoor length and indoor traversal time as weighted metres", () => {
    expect(
      edgeCost(createGraph({ lengthM: 100 }), 0, wheelchairProfile()),
    ).toBe(100);
    expect(
      edgeCost(
        createGraph({
          lengthM: Number.NaN,
          traversalTimeS: 25,
          flags: EDGE_FLAG.INDOOR,
        }),
        0,
        wheelchairProfile(),
      ),
    ).toBe(25 * WHEELCHAIR_WALK_SPEED_MPS);
    expect(
      edgeCost(
        createGraph({
          lengthM: 5,
          traversalTimeS: Number.NaN,
          flags: EDGE_FLAG.INDOOR,
          edgeType: EDGE_TYPE.FOOTWAY,
        }),
        0,
        wheelchairProfile(),
      ),
    ).toBe(5);
    expect(
      edgeCost(
        createGraph({
          lengthM: Number.NaN,
          traversalTimeS: Number.NaN,
          flags: EDGE_FLAG.INDOOR,
        }),
        0,
        wheelchairProfile(),
      ),
    ).toBe(UNMEASURABLE_INDOOR_PROXY_COST_M);
    expect(
      edgeCost(createGraph({ lengthM: Number.NaN }), 0, wheelchairProfile()),
    ).toBe(INFEASIBLE);
    expect(
      edgeCost(
        createGraph({
          traversalTimeS: 25,
          flags: EDGE_FLAG.INDOOR,
        }),
        0,
        wheelchairProfile(0, -WHEELCHAIR_WALK_SPEED_MPS),
      ),
    ).toBe(INFEASIBLE);
  });

  it("keeps the 8-12 percent band at a fixed cost that no relaxation level lowers", () => {
    expect(
      edgeCost(createGraph({ slopeRatio: 0.08 }), 0, wheelchairProfile()),
    ).toBe(100 * WHEELCHAIR_STEEP_SLOPE_PENALTY_MULTIPLIER);
    expect(
      edgeCost(createGraph({ slopeRatio: 0.12 }), 0, wheelchairProfile()),
    ).toBe(100 * WHEELCHAIR_STEEP_SLOPE_PENALTY_MULTIPLIER);
    expect(
      edgeCost(
        createGraph({ slopeRatio: 0.08 }),
        0,
        wheelchairProfile(WHEELCHAIR_MAX_RELAXATION_LEVEL),
      ),
    ).toBe(100 * WHEELCHAIR_STEEP_SLOPE_PENALTY_MULTIPLIER);
    expect(
      edgeCost(createGraph({ slopeRatio: 0.1201 }), 0, wheelchairProfile()),
    ).toBe(INFEASIBLE);
    expect(
      edgeCost(
        createGraph({ slopeRatio: 0.1201 }),
        0,
        wheelchairProfile(WHEELCHAIR_RELAX_EXTREME_SLOPE_LEVEL),
      ),
    ).toBe(100 * WHEELCHAIR_RELAXED_EXTREME_SLOPE_PENALTY_MULTIPLIER);
    expect(
      edgeCost(createGraph({ slopeRatio: 0.05 }), 0, wheelchairProfile()),
    ).toBe(100 * WHEELCHAIR_MODERATE_SLOPE_PENALTY_MULTIPLIER);
  });

  it("keeps exactly 0.9 metres feasible and applies cumulative width relaxation", () => {
    expect(
      edgeCost(
        createGraph({ widthM: WHEELCHAIR_MIN_EFFECTIVE_WIDTH_M }),
        0,
        wheelchairProfile(),
      ),
    ).toBe(100 * WHEELCHAIR_NARROW_WIDTH_PENALTY_MULTIPLIER);
    expect(
      edgeCost(createGraph({ widthM: 0.899 }), 0, wheelchairProfile()),
    ).toBe(INFEASIBLE);
    expect(
      edgeCost(
        createGraph({ widthM: 0.899 }),
        0,
        wheelchairProfile(WHEELCHAIR_RELAX_NARROW_WIDTH_LEVEL),
      ),
    ).toBe(100 * WHEELCHAIR_RELAXED_MIN_WIDTH_PENALTY_MULTIPLIER);
    expect(
      edgeCost(
        createGraph({ widthM: WHEELCHAIR_NARROW_WIDTH_M }),
        0,
        wheelchairProfile(),
      ),
    ).toBe(100 * WHEELCHAIR_MEDIUM_WIDTH_PENALTY_MULTIPLIER);
    expect(
      edgeCost(
        createGraph({ widthM: WHEELCHAIR_MEDIUM_WIDTH_M }),
        0,
        wheelchairProfile(),
      ),
    ).toBe(100 * WHEELCHAIR_WIDE_WIDTH_PENALTY_MULTIPLIER);
    expect(
      edgeCost(
        createGraph({ widthM: WHEELCHAIR_WIDE_WIDTH_M }),
        0,
        wheelchairProfile(),
      ),
    ).toBe(100);
  });

  it("blocks GTFS indoor stairs for wheelchairs and relaxes them with outdoor steps", () => {
    const indoorStairs = createGraph({
      edgeType: EDGE_TYPE.INDOOR_STAIRS,
      traversalTimeS: 50,
      flags: EDGE_FLAG.INDOOR,
    });
    const baseCost = 50 * WHEELCHAIR_WALK_SPEED_MPS;

    expect(edgeCost(indoorStairs, 0, wheelchairProfile())).toBe(INFEASIBLE);
    expect(
      edgeCost(
        indoorStairs,
        0,
        wheelchairProfile(WHEELCHAIR_RELAX_STEPS_LEVEL),
      ),
    ).toBe(baseCost * WHEELCHAIR_RELAXED_STEPS_PENALTY_MULTIPLIER);
    expect(
      edgeCost(
        createGraph({
          edgeType: EDGE_TYPE.INDOOR_STAIRS,
          traversalTimeS: 50,
          flags: EDGE_FLAG.INDOOR | EDGE_FLAG.HAS_RAMP,
        }),
        0,
        wheelchairProfile(),
      ),
    ).toBe(INFEASIBLE);
  });

  it("keeps indoor escalators usable at a high finite penalty", () => {
    const escalator = createGraph({
      edgeType: EDGE_TYPE.INDOOR_ESCALATOR,
      traversalTimeS: 20,
      flags: EDGE_FLAG.INDOOR,
    });
    const walkway = createGraph({
      edgeType: EDGE_TYPE.INDOOR_WALKWAY,
      traversalTimeS: 20,
      flags: EDGE_FLAG.INDOOR,
    });
    const baseCost = 20 * WHEELCHAIR_WALK_SPEED_MPS;

    expect(edgeCost(escalator, 0, wheelchairProfile())).toBe(
      baseCost * WHEELCHAIR_ESCALATOR_PENALTY_MULTIPLIER,
    );
    expect(edgeCost(walkway, 0, wheelchairProfile())).toBe(baseCost);
    expect(
      edgeCost(
        createGraph({
          edgeType: EDGE_TYPE.INDOOR_ELEVATOR,
          traversalTimeS: 20,
          flags: EDGE_FLAG.INDOOR,
        }),
        0,
        wheelchairProfile(),
      ),
    ).toBe(baseCost);
  });

  it("keeps unramped steps infeasible until level four", () => {
    const steps = createGraph({ edgeType: EDGE_TYPE.STEPS });

    expect(edgeCost(steps, 0, wheelchairProfile())).toBe(INFEASIBLE);
    expect(
      edgeCost(steps, 0, wheelchairProfile(WHEELCHAIR_RELAX_STEPS_LEVEL)),
    ).toBe(100 * WHEELCHAIR_RELAXED_STEPS_PENALTY_MULTIPLIER);
    expect(
      edgeCost(
        createGraph({
          edgeType: EDGE_TYPE.STEPS,
          flags: EDGE_FLAG.HAS_RAMP,
        }),
        0,
        wheelchairProfile(),
      ),
    ).toBe(100);
  });

  it("treats unknown numeric and dictionary attributes as neutral", () => {
    const unknown = edgeCost(
      createGraph({
        slopeRatio: Number.NaN,
        widthM: Number.NaN,
        surface: SURFACE.UNKNOWN,
        smoothness: SMOOTHNESS.UNKNOWN,
        wheelchair: WHEELCHAIR.UNKNOWN,
      }),
      0,
      wheelchairProfile(),
    );
    const knownNeutral = edgeCost(
      createGraph({
        surface: SURFACE.ASPHALT,
        smoothness: SMOOTHNESS.GOOD,
        wheelchair: WHEELCHAIR.YES,
      }),
      0,
      wheelchairProfile(),
    );

    expect(unknown).toBe(100);
    expect(knownNeutral).toBe(unknown);
  });

  it("applies each known surface category without penalizing unknown or other values", () => {
    const looseSurfaces = [
      SURFACE.SETT,
      SURFACE.UNHEWN_COBBLESTONE,
      SURFACE.COBBLESTONE,
      SURFACE.BRICKS,
      SURFACE.METAL,
      SURFACE.WOOD,
      SURFACE.GRASS_PAVER,
      SURFACE.COMPACTED,
      SURFACE.FINE_GRAVEL,
      SURFACE.WOODCHIPS,
      SURFACE.MULCH,
      SURFACE.LEAVES,
      SURFACE.SHELLS,
    ];
    const unstableSurfaces = [
      SURFACE.GRAVEL,
      SURFACE.PEBBLESTONE,
      SURFACE.ROCK,
      SURFACE.DIRT,
      SURFACE.EARTH,
      SURFACE.GROUND,
      SURFACE.MUD,
      SURFACE.SAND,
      SURFACE.GRASS,
      SURFACE.CLAY,
      SURFACE.UNPAVED,
      SURFACE.SOIL,
      SURFACE.ICE,
      SURFACE.SNOW,
    ];

    for (const surface of looseSurfaces) {
      expect(edgeCost(createGraph({ surface }), 0, wheelchairProfile())).toBe(
        100 * WHEELCHAIR_LOOSE_SURFACE_PENALTY_MULTIPLIER,
      );
    }
    for (const surface of unstableSurfaces) {
      expect(edgeCost(createGraph({ surface }), 0, wheelchairProfile())).toBe(
        100 * WHEELCHAIR_UNSTABLE_SURFACE_PENALTY_MULTIPLIER,
      );
    }
    expect(
      edgeCost(createGraph({ surface: SURFACE.OTHER }), 0, wheelchairProfile()),
    ).toBe(100);
  });

  it("applies known smoothness and wheelchair-tag constraints", () => {
    expect(
      edgeCost(
        createGraph({ smoothness: SMOOTHNESS.INTERMEDIATE }),
        0,
        wheelchairProfile(),
      ),
    ).toBe(100 * WHEELCHAIR_INTERMEDIATE_SMOOTHNESS_PENALTY_MULTIPLIER);
    expect(
      edgeCost(
        createGraph({ smoothness: SMOOTHNESS.BAD }),
        0,
        wheelchairProfile(),
      ),
    ).toBe(100 * WHEELCHAIR_BAD_SMOOTHNESS_PENALTY_MULTIPLIER);
    expect(
      edgeCost(
        createGraph({ smoothness: SMOOTHNESS.VERY_BAD }),
        0,
        wheelchairProfile(),
      ),
    ).toBe(100 * WHEELCHAIR_VERY_BAD_SMOOTHNESS_PENALTY_MULTIPLIER);
    expect(
      edgeCost(
        createGraph({ smoothness: SMOOTHNESS.HORRIBLE }),
        0,
        wheelchairProfile(),
      ),
    ).toBe(100 * WHEELCHAIR_HORRIBLE_SMOOTHNESS_PENALTY_MULTIPLIER);
    expect(
      edgeCost(
        createGraph({ smoothness: SMOOTHNESS.VERY_HORRIBLE }),
        0,
        wheelchairProfile(),
      ),
    ).toBe(100 * WHEELCHAIR_VERY_HORRIBLE_SMOOTHNESS_PENALTY_MULTIPLIER);
    expect(
      edgeCost(
        createGraph({ smoothness: SMOOTHNESS.IMPASSABLE }),
        0,
        wheelchairProfile(),
      ),
    ).toBe(INFEASIBLE);
    expect(
      edgeCost(
        createGraph({ wheelchair: WHEELCHAIR.LIMITED }),
        0,
        wheelchairProfile(),
      ),
    ).toBe(100 * WHEELCHAIR_LIMITED_TAG_PENALTY_MULTIPLIER);
    expect(
      edgeCost(
        createGraph({ wheelchair: WHEELCHAIR.NO }),
        0,
        wheelchairProfile(),
      ),
    ).toBe(INFEASIBLE);
  });

  it("keeps every configured multiplier and additive penalty admissible", () => {
    const multipliers = [
      MINIMUM_PENALTY_MULTIPLIER,
      WHEELCHAIR_MODERATE_SLOPE_PENALTY_MULTIPLIER,
      WHEELCHAIR_STEEP_SLOPE_PENALTY_MULTIPLIER,
      WHEELCHAIR_RELAXED_EXTREME_SLOPE_PENALTY_MULTIPLIER,
      WHEELCHAIR_NARROW_WIDTH_PENALTY_MULTIPLIER,
      WHEELCHAIR_MEDIUM_WIDTH_PENALTY_MULTIPLIER,
      WHEELCHAIR_WIDE_WIDTH_PENALTY_MULTIPLIER,
      WHEELCHAIR_RELAXED_MIN_WIDTH_PENALTY_MULTIPLIER,
      WHEELCHAIR_LIMITED_TAG_PENALTY_MULTIPLIER,
      WHEELCHAIR_LOOSE_SURFACE_PENALTY_MULTIPLIER,
      WHEELCHAIR_UNSTABLE_SURFACE_PENALTY_MULTIPLIER,
      WHEELCHAIR_INTERMEDIATE_SMOOTHNESS_PENALTY_MULTIPLIER,
      WHEELCHAIR_BAD_SMOOTHNESS_PENALTY_MULTIPLIER,
      WHEELCHAIR_VERY_BAD_SMOOTHNESS_PENALTY_MULTIPLIER,
      WHEELCHAIR_HORRIBLE_SMOOTHNESS_PENALTY_MULTIPLIER,
      WHEELCHAIR_VERY_HORRIBLE_SMOOTHNESS_PENALTY_MULTIPLIER,
      WHEELCHAIR_RELAXED_STEPS_PENALTY_MULTIPLIER,
      WHEELCHAIR_ESCALATOR_PENALTY_MULTIPLIER,
    ];

    for (const multiplier of multipliers) {
      expect(multiplier).toBeGreaterThanOrEqual(MINIMUM_PENALTY_MULTIPLIER);
    }
    expect(MINIMUM_ADDITIVE_PENALTY_M).toBeGreaterThanOrEqual(0);
    expect(WHEELCHAIR_EXTREME_SLOPE_PERCENT).toBeGreaterThan(0);
  });
});
