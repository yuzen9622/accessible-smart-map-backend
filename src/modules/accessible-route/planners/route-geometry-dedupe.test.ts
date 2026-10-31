import { describe, expect, it } from "vitest";
import type { AccessibleRoute, DriveLeg, WalkLeg } from "../../../types/route";
import { dedupeRouteGeometry } from "./route-geometry-dedupe";

const start: [number, number] = [121.5, 25];
const end: [number, number] = [121.51, 25];

function route(
  id: string,
  polyline: [number, number][],
  minutes = 10,
): AccessibleRoute {
  const leg: WalkLeg = {
    type: "WALK",
    from: "A",
    to: "B",
    distanceM: 1000,
    minutesEst: minutes,
    polyline,
    a11yFacilities: [],
    maxSlopePercent: null,
    crossings: null,
    crossingsWithCurbRamp: null,
    minPathWidthCm: null,
    surfaceType: "unknown",
    restPoints: [],
  };
  return {
    routeId: id,
    routeName: id,
    totalMinutes: minutes,
    transferCount: 0,
    legs: [leg],
    accessibilityHighlights: [],
  };
}

describe("dedupeRouteGeometry", () => {
  it("removes the same path even when sampling and estimated times differ", () => {
    const original = route("first", [start, end]);
    const resampled = route(
      "resampled",
      [start, [121.503, 25], [121.507, 25], end],
      30,
    );
    const resampledLeg = resampled.legs[0];
    if (resampledLeg.type === "WALK") resampledLeg.distanceM = 1200;
    expect(dedupeRouteGeometry([original, resampled])).toEqual([original]);
  });

  it.each(["DRIVE", "MOTORCYCLE"] as const)(
    "deduplicates %s geometry rather than duration",
    (type) => {
      const first = route("first", []);
      const leg: DriveLeg = {
        type,
        from: { lat: start[1], lng: start[0] },
        to: { lat: end[1], lng: end[0] },
        distanceM: 1000,
        durationMin: 5,
        polyline: [start, end],
      };
      first.legs = [leg];
      const same = {
        ...first,
        routeId: "same",
        totalMinutes: 30,
        legs: [
          { ...leg, polyline: [start, [121.505, 25] as [number, number], end] },
        ],
      };
      const branch = {
        ...first,
        routeId: "branch",
        legs: [
          {
            ...leg,
            polyline: [start, [121.505, 25.001] as [number, number], end],
          },
        ],
      };
      expect(dedupeRouteGeometry([first, same, branch])).toEqual([
        first,
        branch,
      ]);
    },
  );

  it("matches the same path even if a waypoint splits it into legs", () => {
    const middle: [number, number] = [121.505, 25];
    const direct = route("direct", [start, end]);
    const split = route("split", [start, middle]);
    const second = route("second", [middle, end]);
    split.legs.push(...second.legs);
    expect(dedupeRouteGeometry([direct, split])).toEqual([direct]);
  });

  it("keeps a short branch on a long route even between regular samples", () => {
    const farEnd: [number, number] = [122.5, 25];
    const direct = route("direct", [start, farEnd]);
    const branch = route("branch", [
      start,
      [121.6234, 25],
      [121.6235, 25.0001],
      [121.6236, 25],
      farEnd,
    ]);
    expect(dedupeRouteGeometry([direct, branch])).toEqual([direct, branch]);
  });

  it("does not drop routes with a missing waypoint segment", () => {
    const first = route("first", [start, end]);
    const incomplete = route("incomplete", [start, end]);
    incomplete.legs.push(...route("missing", []).legs);
    expect(dedupeRouteGeometry([first, incomplete])).toEqual([
      first,
      incomplete,
    ]);
  });

  it("keeps distinct branches even when time and distance are equal", () => {
    const direct = route("direct", [start, end]);
    const branch = route("branch", [start, [121.505, 25.001], end]);
    expect(dedupeRouteGeometry([direct, branch])).toEqual([direct, branch]);
  });

  it("keeps nearby parallel paths separate", () => {
    const first = route("first", [
      start,
      [121.5, 25.00003],
      [121.51, 25.00003],
      end,
    ]);
    const second = route("second", [start, end]);
    expect(dedupeRouteGeometry([first, second])).toEqual([first, second]);
  });

  it("keeps paths whose geometry is missing or degenerate", () => {
    const first = route("first", []);
    const second = route("second", []);
    const third = route("third", [start, start]);
    expect(dedupeRouteGeometry([first, second, third])).toEqual([
      first,
      second,
      third,
    ]);
  });

  it("removes identical complete routes longer than the geometry sampling limit", () => {
    const points = Array.from({ length: 12_001 }, (_, i): [number, number] => [
      121.5 + i / 1_000_000,
      25,
    ]);
    const first = route("first", points);
    const duplicate = route(
      "duplicate",
      points.map(([lng, lat]) => [lng, lat]),
    );
    expect(
      dedupeRouteGeometry([first, duplicate]).map((item) => item.routeId),
    ).toEqual(["first"]);
  });

  it("keeps long routes when their exact geometries differ", () => {
    const points = Array.from({ length: 12_001 }, (_, i): [number, number] => [
      121.5 + i / 1_000_000,
      25,
    ]);
    const first = route("first", points);
    const altered = points.map(([lng, lat]): [number, number] => [lng, lat]);
    altered[6000] = [altered[6000][0], 25.001];
    const different = route("different", altered);
    expect(
      dedupeRouteGeometry([first, different]).map((item) => item.routeId),
    ).toEqual(["first", "different"]);
  });

  it("does not confuse the same roads travelled in a different order", () => {
    const first = route("first", [start, [121.505, 25], end]);
    const second = route("reverse", [end, [121.505, 25], start]);
    expect(dedupeRouteGeometry([first, second])).toEqual([first, second]);
  });
});
