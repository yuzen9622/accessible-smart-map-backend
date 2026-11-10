import { beforeEach, describe, expect, it, vi } from "vitest";
import { copyWithDescriptors } from "../../../utils/route-source-names";
import {
  RoadSpeedLimitsSchema,
  RoadRangeSchema,
} from "../../../schemas/road-guidance.schema";
import { computeValhallaTraceAttributes } from "../../../adapters/valhalla.adapter";
import {
  isValhallaReleaseCurrent,
  type ValhallaReleaseSnapshot,
} from "../../../adapters/valhalla-release.adapter";
import type { AccessibleRoute, DriveLeg } from "../../../types/route";
import type {
  DirectedRoadSpan,
  RoadSpeedRules,
} from "../../../types/road-guidance";
import {
  getRoadMatchingData,
  attachRoadMatchingData,
  geometrySha256,
} from "../../../utils/road-matching-data";
import {
  osmTraversalDirection,
  applyLaneApproachRanges,
  buildRoadSpeedLimits,
  enrichRoadRoutes,
} from "./road-guidance";
vi.mock("../../../adapters/valhalla.adapter", () => ({
  computeValhallaTraceAttributes: vi.fn(),
}));
vi.mock("../../../adapters/valhalla-release.adapter", () => ({
  isValhallaReleaseCurrent: vi.fn(),
}));
const trace = vi.mocked(computeValhallaTraceAttributes),
  current = vi.mocked(isValhallaReleaseCurrent);
const span: DirectedRoadSpan = {
  fromIndex: 0,
  toIndex: 2,
  directedEdgeId: "123",
  osmWayId: "456",
  osmForward: true,
};
const rawSpan = {
  fromIndex: 0,
  toIndex: 2,
  directedEdgeId: "123",
  osmWayId: "456",
  edgeForward: false,
};
const snapshot: ValhallaReleaseSnapshot = {
  roadNetwork: {
    tilesetId: "release1",
    sourcePbfSha256: "a".repeat(64),
    provenance: "verified",
  },
  identity: "runtime1",
  rules: {
    schemaVersion: 1,
    sourcePbfSha256: "a".repeat(64),
    ways: {
      "456": {
        unresolvedConditional: false,
        unresolvedLaneSpecific: false,
        osmGeometry: [
          [121, 25],
          [121, 25.001],
          [121, 25.002],
        ],
      },
    },
  },
};
function route(): AccessibleRoute {
  return {
    routeId: "r",
    routeName: "road",
    totalMinutes: 1,
    transferCount: 0,
    totalWalkDistanceM: 0,
    accessibilityHighlights: [],
    legs: [
      {
        type: "DRIVE",
        from: { lat: 25, lng: 121 },
        to: { lat: 25.002, lng: 121 },
        distanceM: 200,
        durationMin: 1,
        polyline: [
          [121, 25],
          [121, 25.001],
          [121, 25.002],
        ],
        maneuvers: [
          {
            type: 9,
            lengthKm: 0.1,
            timeSec: 1,
            beginShapeIndex: 1,
            endShapeIndex: 2,
            lanes: [
              {
                directions: ["slight_right"],
                recommendation: "preferred",
                maneuverDirection: "slight_right",
              },
            ],
          },
        ],
      },
    ],
  };
}
const roadLeg = (r: AccessibleRoute) =>
  r.legs.find((l) => l.type === "DRIVE") as DriveLeg;
beforeEach(() => {
  vi.clearAllMocks();
  current.mockResolvedValue(true);
  trace.mockResolvedValue({
    status: "OK",
    shapePolyline6: "unused",
    speedLimitValues: [100, 60],
    spans: [
      { ...rawSpan, toIndex: 1 },
      { ...rawSpan, fromIndex: 1, directedEdgeId: "124" },
    ],
  });
});
describe("speed partition and incoming lanes", () => {
  it("does not derive direction from displacement within the rounding envelope", () => {
    const horizontal: [number, number][] = [
      [121, 25],
      [121.001, 25],
    ];
    expect(
      osmTraversalDirection(
        [
          [121, 24.999999],
          [121.000001, 25.000001],
        ],
        horizontal,
      ),
    ).toBeUndefined();
    expect(
      osmTraversalDirection(
        [
          [121.000001, 25.000001],
          [121, 24.999999],
        ],
        horizontal,
      ),
    ).toBeUndefined();
    expect(
      osmTraversalDirection(
        [
          [121.0002, 25],
          [121.000202, 25],
        ],
        horizontal,
      ),
    ).toBeUndefined();
    expect(
      osmTraversalDirection(
        [
          [121.0002, 25],
          [121.0008, 25],
        ],
        horizontal,
      ),
    ).toBe(true);
    expect(
      osmTraversalDirection(
        [
          [121.0008, 25],
          [121.0002, 25],
        ],
        horizontal,
      ),
    ).toBe(false);
  });
  it("derives source-way direction from unique geometry, not storage forward", () => {
    const way: [number, number][] = [
      [121, 25],
      [121, 25.001],
      [121.001, 25.001],
    ];
    expect(
      osmTraversalDirection(
        [
          [121, 25.0002],
          [121, 25.0008],
        ],
        way,
      ),
    ).toBe(true);
    expect(
      osmTraversalDirection(
        [
          [121, 25.0008],
          [121, 25.0002],
        ],
        way,
      ),
    ).toBe(false);
    expect(
      osmTraversalDirection(
        [
          [121.00001, 25.0002],
          [121.00001, 25.0008],
        ],
        way,
      ),
    ).toBeUndefined();
    expect(
      osmTraversalDirection(
        [
          [121, 25],
          [121, 25.001],
        ],
        [
          [121, 25],
          [121, 25.001],
          [121, 25],
        ],
      ),
    ).toBeUndefined();
    expect(
      osmTraversalDirection(
        [
          [121, 25],
          [121, 25],
        ],
        way,
      ),
    ).toBeUndefined();
  });
  it("keeps changes inside one maneuver and unknown boundaries", () => {
    expect(buildRoadSpeedLimits([40, 40, 0, 50, 50, 0], [])).toEqual({
      status: "available",
      direction: "along_leg",
      segments: [
        {
          fromIndex: 0,
          toIndex: 2,
          kind: "known",
          limitKph: 40,
          source: "valhalla",
        },
        {
          fromIndex: 2,
          toIndex: 3,
          kind: "unknown",
          limitKph: null,
          source: null,
        },
        {
          fromIndex: 3,
          toIndex: 5,
          kind: "known",
          limitKph: 50,
          source: "valhalla",
        },
        {
          fromIndex: 5,
          toIndex: 6,
          kind: "unknown",
          limitKph: null,
          source: null,
        },
      ],
    });
  });
  it("distinguishes unknown and unlimited", () => {
    expect(buildRoadSpeedLimits([0, 255], [])).toMatchObject({
      segments: [
        { kind: "unknown", limitKph: null, source: null },
        { kind: "unlimited", limitKph: null, source: "valhalla" },
      ],
    });
  });
  it("pure rule application uses actual OSM direction, never routing speed", () => {
    const rules: RoadSpeedRules = {
      schemaVersion: 1,
      sourcePbfSha256: "a".repeat(64),
      ways: {
        "456": {
          forward: { kind: "known", limitKph: 30, rawValue: "30" },
          backward: { kind: "known", limitKph: 50, rawValue: "50" },
          unresolvedConditional: false,
          unresolvedLaneSpecific: false,
        },
      },
    };
    expect(buildRoadSpeedLimits([0, 0], [span], rules)).toMatchObject({
      segments: [{ kind: "known", limitKph: 30, source: "osm_directional" }],
    });
    expect(
      buildRoadSpeedLimits([0, 0], [{ ...span, osmForward: false }], rules),
    ).toMatchObject({
      segments: [{ kind: "known", limitKph: 50, source: "osm_directional" }],
    });
    rules.ways["456"].unresolvedConditional = true;
    expect(buildRoadSpeedLimits([90, 90], [span], rules)).toMatchObject({
      segments: [{ kind: "unknown", source: null }],
    });
    rules.ways["456"].unresolvedConditional = false;
    rules.ways["456"].forward = {
      kind: "invalid",
      limitKph: null,
      rawValue: "50|40",
    };
    expect(buildRoadSpeedLimits([90, 90], [span], rules)).toMatchObject({
      segments: [{ kind: "unknown", source: null }],
    });
  });
  it("keeps same values separate across source boundaries and rejects invalid public partitions", () => {
    const rules: RoadSpeedRules = {
      schemaVersion: 1,
      sourcePbfSha256: "a".repeat(64),
      ways: {
        "456": {
          forward: { kind: "known", limitKph: 50, rawValue: "50" },
          unresolvedConditional: false,
          unresolvedLaneSpecific: false,
        },
      },
    };
    const result = buildRoadSpeedLimits(
      [50, 50],
      [{ ...span, toIndex: 1 }],
      rules,
    );
    expect(result).toMatchObject({
      segments: [
        { fromIndex: 0, toIndex: 1, source: "osm_directional" },
        { fromIndex: 1, toIndex: 2, source: "valhalla" },
      ],
    });
    expect(RoadSpeedLimitsSchema.safeParse(result).success).toBe(true);
    expect(
      RoadSpeedLimitsSchema.safeParse({
        status: "available",
        direction: "along_leg",
        segments: [
          {
            fromIndex: 1,
            toIndex: 2,
            kind: "unknown",
            limitKph: null,
            source: null,
          },
        ],
      }).success,
    ).toBe(false);
    expect(
      RoadRangeSchema.safeParse({ fromIndex: 2, toIndex: 2 }).success,
    ).toBe(false);
    rules.ways["456"].unresolvedLaneSpecific = true;
    expect(buildRoadSpeedLimits([90, 90], [span], rules)).toMatchObject({
      segments: [{ kind: "unknown" }],
    });
  });
  it("extends lanes back along the approach, stopping at the prep distance or previous maneuver", () => {
    // Vertices ~111 m apart along one meridian.
    const leg: DriveLeg = {
      ...roadLeg(route()),
      polyline: Array.from(
        { length: 8 },
        (_, i) => [121, 25 + i * 0.001] as [number, number],
      ),
      maneuvers: [
        {
          type: 1,
          instruction: "",
          lengthKm: 0.2,
          timeSec: 1,
          beginShapeIndex: 0,
          endShapeIndex: 2,
        },
        {
          type: 10,
          instruction: "",
          lengthKm: 0.6,
          timeSec: 1,
          beginShapeIndex: 2,
          endShapeIndex: 7,
          lanes: [
            {
              directions: ["right"],
              recommendation: "preferred",
              maneuverDirection: "right",
            },
          ],
        },
        {
          type: 15,
          instruction: "",
          lengthKm: 0,
          timeSec: 1,
          beginShapeIndex: 7,
          endShapeIndex: 7,
          lanes: [
            {
              directions: ["left"],
              recommendation: "preferred",
              maneuverDirection: "left",
            },
          ],
        },
      ],
    };
    applyLaneApproachRanges(leg, 300);
    // Bounded by the departure at index 0 (only ~222 m available).
    expect(leg.maneuvers?.[1].laneApproachRange).toEqual({
      fromIndex: 0,
      toIndex: 2,
    });
    // 300 m reaches back three ~111 m segments, still after the previous maneuver.
    expect(leg.maneuvers?.[2].laneApproachRange).toEqual({
      fromIndex: 4,
      toIndex: 7,
    });
    delete leg.maneuvers?.[1].lanes;
    applyLaneApproachRanges(leg, 300);
    expect(leg.maneuvers?.[1].laneApproachRange).toBeUndefined();
  });
  it("gives no range to lanes on the departure maneuver", () => {
    const leg = roadLeg(route());
    leg.maneuvers = [
      {
        type: 1,
        instruction: "",
        lengthKm: 0.1,
        timeSec: 1,
        beginShapeIndex: 0,
        endShapeIndex: 1,
        lanes: [
          {
            directions: ["straight"],
            recommendation: "preferred",
            maneuverDirection: "straight",
          },
        ],
      },
    ];
    applyLaneApproachRanges(leg);
    expect(leg.maneuvers[0].laneApproachRange).toBeUndefined();
  });
});
describe("final candidate enrichment", () => {
  it("keeps an all-tiny rounding-ambiguous directional span unknown", async () => {
    const r = route();
    roadLeg(r).polyline = [
      [121, 24.999999],
      [121.000001, 25.000001],
      [121.000002, 25],
    ];
    const rules: RoadSpeedRules = {
      schemaVersion: 1,
      sourcePbfSha256: "a".repeat(64),
      ways: {
        "456": {
          forward: { kind: "known", limitKph: 30, rawValue: "30" },
          backward: { kind: "known", limitKph: 50, rawValue: "50" },
          unresolvedConditional: false,
          unresolvedLaneSpecific: false,
          osmGeometry: [
            [121, 25],
            [121.001, 25],
          ],
        },
      },
    };
    trace.mockResolvedValue({
      status: "OK",
      shapePolyline6: "unused",
      speedLimitValues: [100, 60],
      spans: [rawSpan],
    });
    await enrichRoadRoutes([r], "auto", { ...snapshot, rules });
    expect(roadLeg(r).speedLimits).toMatchObject({
      status: "available",
      segments: [
        {
          fromIndex: 0,
          toIndex: 2,
          kind: "unknown",
          limitKph: null,
          source: null,
        },
      ],
    });
    expect(getRoadMatchingData(r)).toBeUndefined();
  });
  it("overlays 30/50 only from same-source ordered geometry while ignoring storage flag", async () => {
    const rules: RoadSpeedRules = {
      schemaVersion: 1,
      sourcePbfSha256: "a".repeat(64),
      ways: {
        "456": {
          forward: { kind: "known", limitKph: 30, rawValue: "30" },
          backward: { kind: "known", limitKph: 50, rawValue: "50" },
          unresolvedConditional: false,
          unresolvedLaneSpecific: false,
          osmGeometry: [
            [121, 25],
            [121, 25.001],
            [121, 25.002],
          ],
        },
      },
    };
    const forward = route();
    await enrichRoadRoutes([forward], "auto", { ...snapshot, rules });
    expect(roadLeg(forward).speedLimits).toMatchObject({
      segments: [{ limitKph: 30, source: "osm_directional" }],
    });
    expect(getRoadMatchingData(forward)?.legs[0].spans[0].osmForward).toBe(
      true,
    );
    const backward = route();
    roadLeg(backward).polyline.reverse();
    await enrichRoadRoutes([backward], "auto", { ...snapshot, rules });
    expect(roadLeg(backward).speedLimits).toMatchObject({
      segments: [{ limitKph: 50, source: "osm_directional" }],
    });
    expect(getRoadMatchingData(backward)?.legs[0].spans[0].osmForward).toBe(
      false,
    );
    delete rules.ways["456"].osmGeometry;
    const legacy = route();
    await enrichRoadRoutes([legacy], "auto", { ...snapshot, rules });
    expect(roadLeg(legacy).speedLimits).toMatchObject({
      segments: [{ kind: "unknown", limitKph: null, source: null }],
    });
    expect(getRoadMatchingData(legacy)).toBeUndefined();
    rules.ways["456"].osmGeometry = [
      [121, 25],
      [121, 25.001],
      [121, 25.002],
      [121, 25.001],
      [121, 25],
    ];
    const loop = route();
    await enrichRoadRoutes([loop], "auto", { ...snapshot, rules });
    expect(roadLeg(loop).speedLimits).toMatchObject({
      segments: [{ kind: "unknown" }],
    });
    expect(getRoadMatchingData(loop)).toBeUndefined();
  });
  it("retains connector-adjusted legIndex with private descriptor and unchanged geometry", async () => {
    const r = route();
    r.legs.unshift({
      type: "WALK",
      from: "start",
      to: "car",
      distanceM: 1,
      minutesEst: 1,
      polyline: [
        [121, 25],
        [121, 25],
      ],
      a11yFacilities: [],
    } as any);
    const before = JSON.stringify(roadLeg(r).polyline);
    await enrichRoadRoutes([r], "auto", snapshot);
    expect(JSON.stringify(roadLeg(r).polyline)).toBe(before);
    expect(roadLeg(r).speedLimits).toMatchObject({
      status: "available",
      segments: [
        { fromIndex: 0, toIndex: 1, limitKph: 100 },
        { fromIndex: 1, toIndex: 2, limitKph: 60 },
      ],
    });
    const data = getRoadMatchingData(r);
    expect(data?.legs[0].legIndex).toBe(1);
    expect(JSON.stringify(r)).not.toContain("directedEdgeId");
    const copied = copyWithDescriptors(r, { routeName: "presented" });
    expect(getRoadMatchingData(copied)).toEqual(data);
    roadLeg(copied).polyline[1] = [121, 25.003];
    expect(getRoadMatchingData(copied)).toBeUndefined();
  });
  it.each([
    ["NO_MATCH", "geometry_mismatch"],
    ["INVALID_RESPONSE", "invalid_response"],
    ["UPSTREAM_ERROR", "upstream_error"],
  ] as const)("preserves route on %s", async (status, reason) => {
    trace.mockResolvedValue({ status });
    const r = route();
    await enrichRoadRoutes([r], "auto", snapshot);
    expect(r.legs).toHaveLength(1);
    expect(roadLeg(r).speedLimits).toMatchObject({
      status: "unavailable",
      reason,
    });
    expect(getRoadMatchingData(r)).toBeUndefined();
  });
  it("cannot enrich without serving snapshot", async () => {
    const r = route();
    await enrichRoadRoutes([r], "auto", null);
    expect(trace).not.toHaveBeenCalled();
    expect(roadLeg(r).speedLimits).toMatchObject({ reason: "tileset_changed" });
  });
  it("release changing during trace discards metadata", async () => {
    current.mockResolvedValueOnce(true).mockResolvedValue(false);
    const r = route();
    await enrichRoadRoutes([r], "auto", snapshot);
    expect(roadLeg(r).speedLimits).toMatchObject({ reason: "tileset_changed" });
    expect(getRoadMatchingData(r)).toBeUndefined();
  });
  it("has max2 in-flight and one absolute caller budget across all candidates", async () => {
    vi.useFakeTimers();
    try {
      let active = 0,
        max = 0;
      trace.mockImplementation(async () => {
        active++;
        max = Math.max(active, max);
        await new Promise((resolve) => setTimeout(resolve, 40));
        active--;
        return {
          status: "OK",
          shapePolyline6: "unused",
          speedLimitValues: [100, 60],
          spans: [rawSpan],
        };
      });
      const routes = Array.from({ length: 7 }, route);
      const promise = enrichRoadRoutes(
        routes,
        "auto",
        snapshot,
        Date.now() + 50,
      );
      await vi.advanceTimersByTimeAsync(50);
      await promise;
      expect(max).toBe(2);
      expect(trace).toHaveBeenCalledTimes(4);
      expect(
        routes.every((r) => roadLeg(r).speedLimits?.status === "unavailable"),
      ).toBe(true);
      expect(roadLeg(routes[6]).speedLimits).toMatchObject({
        reason: "budget_exhausted",
      });
      await vi.advanceTimersByTimeAsync(100);
    } finally {
      vi.useRealTimers();
    }
  });
  it("does not apply rules from another source", async () => {
    const r = route();
    await enrichRoadRoutes([r], "auto", {
      ...snapshot,
      rules: {
        schemaVersion: 1,
        sourcePbfSha256: "b".repeat(64),
        ways: {
          "456": {
            forward: { kind: "known", limitKph: 30, rawValue: "30" },
            unresolvedConditional: false,
            unresolvedLaneSpecific: false,
          },
        },
      },
    });
    expect(roadLeg(r).speedLimits).toMatchObject({
      segments: [
        { limitKph: 100, source: "valhalla" },
        { limitKph: 60, source: "valhalla" },
      ],
    });
  });
  it("refuses attaching mismatched final geometry", () => {
    const r = route();
    r.roadNetwork = snapshot.roadNetwork;
    attachRoadMatchingData(r, {
      tilesetId: "release1",
      legs: [
        {
          legIndex: 0,
          geometrySha256: geometrySha256([
            [121, 25],
            [121, 25.003],
          ]),
          spans: [span],
        },
      ],
    });
    expect(getRoadMatchingData(r)).toBeUndefined();
  });
});
