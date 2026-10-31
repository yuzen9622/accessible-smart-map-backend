import { describe, expect, it } from "vitest";
import type { AccessibleRoute, DriveLeg, WalkLeg } from "../../../types/route";
import { selectRoadCandidates } from "./road-candidate-selection";

let nextRouteGeometry = 0;

function route(
  id: string,
  time: number,
  distance: number,
  blocking = 0,
): AccessibleRoute {
  const displacement = ++nextRouteGeometry * 0.002;
  const leg: DriveLeg = {
    type: "DRIVE",
    from: { lat: 25, lng: 121 },
    to: { lat: 25.01, lng: 121 },
    distanceM: distance,
    durationMin: time,
    polyline: [
      [121, 25],
      [121 + displacement, 25.005],
      [121, 25.01],
    ],
  };
  return {
    routeId: id,
    routeName: id,
    totalMinutes: time,
    transferCount: 0,
    legs: [leg],
    accessibilityHighlights: [],
    hazardAdvisory: {
      onRoute: [],
      avoided: [],
      blockingOnRoute: blocking,
      penaltyPoints: 0,
    },
  };
}

const ids = (routes: AccessibleRoute[]) => routes.map((value) => value.routeId);

describe("selectRoadCandidates", () => {
  it("retains the recommended route and selects shortest and fastest alternatives", () => {
    const routes = [
      route("recommended", 12, 5000),
      route("ordinary", 15, 5500),
      route("shortest", 18, 3000),
      route("fastest", 8, 6000),
    ];
    expect(ids(selectRoadCandidates(routes))).toEqual([
      "recommended",
      "shortest",
      "fastest",
    ]);
  });

  it("fills remaining slots in ranked order if one route is both fastest and shortest", () => {
    const routes = [
      route("recommended", 15, 6000),
      route("ordinary", 20, 7000),
      route("both", 10, 3000),
      route("other", 25, 8000),
    ];
    expect(ids(selectRoadCandidates(routes))).toEqual([
      "recommended",
      "ordinary",
      "both",
    ]);
  });

  it("does not select a faster or shorter route with more blocking hazards over safer routes", () => {
    const routes = [
      route("recommended", 20, 7000),
      route("safe-two", 25, 8000),
      route("safe-three", 30, 9000),
      route("blocked", 1, 10, 1),
    ];
    expect(ids(selectRoadCandidates(routes))).toEqual([
      "recommended",
      "safe-two",
      "safe-three",
    ]);
  });

  it("prefers lower hazard penalty among routes with the same blocking count", () => {
    const recommended = route("recommended", 30, 7000, 1);
    const lowPenaltyOne = route("low-one", 35, 8000, 1);
    const lowPenaltyTwo = route("low-two", 40, 9000, 1);
    const highPenalty = route("high", 1, 10, 1);
    if (highPenalty.hazardAdvisory)
      highPenalty.hazardAdvisory.penaltyPoints = 10;
    expect(
      ids(
        selectRoadCandidates([
          recommended,
          lowPenaltyOne,
          lowPenaltyTwo,
          highPenalty,
        ]),
      ),
    ).toEqual(["recommended", "low-one", "low-two"]);
  });

  it("does not split the zero-blocking tier by penalty", () => {
    const recommended = route("recommended", 30, 7000);
    const ordinary = route("ordinary", 35, 8000);
    const fastest = route("fastest", 1, 10000);
    const shortest = route("shortest", 40, 1000);
    if (fastest.hazardAdvisory) fastest.hazardAdvisory.penaltyPoints = 10;
    expect(
      ids(selectRoadCandidates([recommended, ordinary, fastest, shortest])),
    ).toEqual(["recommended", "fastest", "shortest"]);
  });

  it("fills unused slots from the next hazard level", () => {
    const routes = [
      route("recommended", 20, 7000),
      route("safe", 25, 8000),
      route("blocked-one", 15, 6000, 1),
      route("blocked-two", 1, 10, 2),
    ];
    expect(ids(selectRoadCandidates(routes))).toEqual([
      "recommended",
      "safe",
      "blocked-one",
    ]);
  });

  it("includes walking connector distance and motorcycle legs in the full distance", () => {
    const recommended = route("recommended", 30, 7000);
    const misleading = route("misleading", 20, 1000);
    const connector = {
      type: "WALK",
      distanceM: 5000,
      polyline: [
        [121, 25.01],
        [121, 25.02],
      ],
    } as WalkLeg;
    misleading.legs.push(connector);
    const shortest = route("shortest", 25, 2000);
    const road = shortest.legs[0];
    if (road.type === "DRIVE") road.type = "MOTORCYCLE";
    const fastest = route("fastest", 10, 8000);
    expect(
      ids(selectRoadCandidates([recommended, misleading, shortest, fastest])),
    ).toEqual(["recommended", "shortest", "fastest"]);
  });

  it("does not treat missing distance or time as zero", () => {
    const recommended = route("recommended", 30, 7000);
    const invalid = route("invalid", Number.NaN, Number.NaN);
    const shortest = route("shortest", 25, 2000);
    const fastest = route("fastest", 10, 8000);
    expect(
      ids(selectRoadCandidates([recommended, invalid, shortest, fastest])),
    ).toEqual(["recommended", "shortest", "fastest"]);
  });

  it("does not treat missing geometry as the shortest path", () => {
    const recommended = route("recommended", 30, 7000);
    const missing = route("missing", 35, 100);
    const leg = missing.legs[0];
    if (leg.type === "DRIVE") leg.polyline = [];
    const shortest = route("shortest", 25, 2000);
    const fastest = route("fastest", 10, 8000);
    expect(
      ids(selectRoadCandidates([recommended, missing, shortest, fastest])),
    ).toEqual(["recommended", "shortest", "fastest"]);
  });

  it("preserves distinct candidates in original order when there are at most three", () => {
    const routes = [
      route("recommended", 30, 7000),
      route("shortest", 25, 2000),
    ];
    expect(selectRoadCandidates(routes)).toEqual(routes);
    expect(selectRoadCandidates([])).toEqual([]);
  });

  it.each(["DRIVE", "MOTORCYCLE"] as const)(
    "removes near-identical %s routes even when only two were supplied",
    (type) => {
      const first = route("first", 12, 2200);
      const duplicate = route("duplicate", 11, 2200);
      const originalLeg = first.legs[0];
      const duplicateLeg = duplicate.legs[0];
      if (originalLeg.type !== "DRIVE" || duplicateLeg.type !== "DRIVE")
        throw new Error();
      originalLeg.type = type;
      duplicateLeg.type = type;
      originalLeg.polyline = [
        [121.514417, 25.041825],
        [121.518, 25.04],
        [121.523207, 25.033894],
      ];
      duplicateLeg.polyline = [
        [121.514417, 25.041825],
        [121.518001, 25.04],
        [121.523207, 25.033894],
      ];
      expect(ids(selectRoadCandidates([first, duplicate]))).toEqual(["first"]);
    },
  );

  it("compares alternative routes with each other, not just the recommended route", () => {
    const first = route("first", 30, 5000);
    const second = route("second", 20, 4000);
    const duplicate = route("duplicate", 10, 3000);
    duplicate.legs[0].polyline = second.legs[0].polyline.map(([lng, lat]) => [
      lng + 0.000001,
      lat,
    ]);
    const third = route("third", 40, 6000);
    expect(
      ids(selectRoadCandidates([first, second, duplicate, third])),
    ).toEqual(["first", "duplicate", "third"]);
  });

  it("retains the safer route when a faster, highly overlapping route has a blocking hazard", () => {
    const first = route("first", 30, 5000);
    const safe = route("safe", 25, 4000);
    const blocked = route("blocked", 1, 1000, 1);
    blocked.legs[0].polyline = safe.legs[0].polyline.map(([lng, lat]) => [
      lng + 0.000001,
      lat,
    ]);
    expect(ids(selectRoadCandidates([first, safe, blocked]))).toEqual([
      "first",
      "safe",
    ]);
  });

  it("conservatively keeps only the recommended route if its geometry is unknown", () => {
    const first = route("first", 30, 5000);
    first.legs[0].polyline = [];
    expect(
      ids(selectRoadCandidates([first, route("other", 20, 4000)])),
    ).toEqual(["first"]);
  });

  it("includes all legs and both directions when comparing complete paths", () => {
    const first = route("first", 30, 5000);
    const duplicate = route("duplicate", 20, 4000);
    const firstRoad = first.legs[0];
    const secondRoad = duplicate.legs[0];
    firstRoad.polyline = [
      [121, 25],
      [121, 25.01],
    ];
    secondRoad.polyline = [
      [121, 25],
      [121, 25.01],
    ];
    const connector = {
      type: "WALK",
      distanceM: 100,
      polyline: [
        [121, 25.01],
        [121, 25.011],
      ],
    } as WalkLeg;
    first.legs.push(connector);
    duplicate.legs.push({
      ...connector,
      polyline: connector.polyline.map(([lng, lat]) => [lng + 0.000001, lat]),
    });
    expect(ids(selectRoadCandidates([first, duplicate]))).toEqual(["first"]);
  });

  it("requires both directions to be distinct when a long route contains the shorter route", () => {
    const short = route("short", 10, 1000);
    const long = route("long", 30, 4000);
    short.legs[0].polyline = [
      [121, 25],
      [121, 25.01],
    ];
    long.legs[0].polyline = [
      [121, 25],
      [121, 25.01],
      [121, 25.04],
    ];
    expect(ids(selectRoadCandidates([short, long]))).toEqual(["short"]);
  });

  it("does not count slightly offset lanes on the same corridor as distinct", () => {
    const first = route("first", 10, 1000);
    const adjacent = route("adjacent", 10, 1000);
    const separate = route("separate", 12, 1200);
    first.legs[0].polyline = [
      [121, 25],
      [121, 25.01],
    ];
    adjacent.legs[0].polyline = [
      [121.00003, 25],
      [121.00003, 25.01],
    ];
    separate.legs[0].polyline = [
      [121.00015, 25],
      [121.00015, 25.01],
    ];
    expect(ids(selectRoadCandidates([first, adjacent, separate]))).toEqual([
      "first",
      "separate",
    ]);
  });

  it("does not claim an oversized geometry is a distinct route", () => {
    const first = route("first", 10, 1000);
    const oversized = route("oversized", 11, 1100);
    oversized.legs[0].polyline = Array.from({ length: 12001 }, (_, index) => [
      121,
      25 + index * 0.000001,
    ]);
    expect(ids(selectRoadCandidates([first, oversized]))).toEqual(["first"]);
  });

  it("does not compare disconnected legs as a complete route", () => {
    const first = route("first", 10, 1000);
    const disconnected = route("disconnected", 11, 1100);
    disconnected.legs.push({
      type: "WALK",
      distanceM: 100,
      polyline: [
        [121.02, 25.02],
        [121.021, 25.021],
      ],
    } as WalkLeg);
    expect(ids(selectRoadCandidates([first, disconnected]))).toEqual(["first"]);
  });
});
