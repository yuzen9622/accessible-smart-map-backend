import { describe, expect, it } from "vitest";
import type { WalkLeg } from "../types/route";
import {
  elevationGain,
  makeElevationProfile,
  sampleWalkingRoute,
} from "./route-elevation";

const leg = (polyline: [number, number][]): WalkLeg => ({
  type: "WALK",
  from: "A",
  to: "B",
  distanceM: 1,
  minutesEst: 1,
  polyline,
  a11yFacilities: [],
  maxSlopePercent: null,
  crossings: null,
  crossingsWithCurbRamp: null,
  minPathWidthCm: null,
  surfaceType: "unknown",
  restPoints: [],
});
const prepare = (points: [number, number][]) => {
  const line = sampleWalkingRoute([leg(points)]);
  if ("status" in line) throw new Error(line.reason);
  return line;
};

describe("terrain profile geometry and arithmetic", () => {
  it("follows all route vertices, includes endpoints and ignores declared leg distance", () => {
    const line = prepare([
      [121, 25],
      [121, 25],
      [121, 25.001],
      [121.001, 25.001],
    ]);
    expect(line.distanceM).toBeGreaterThan(200);
    expect(line.samples[0]).toEqual({ distanceM: 0, coordinates: [121, 25] });
    expect(line.samples.at(-1)).toEqual({
      distanceM: line.distanceM,
      coordinates: [121.001, 25.001],
    });
    for (const point of line.samples) {
      if (point.distanceM < 100) expect(point.coordinates[0]).toBe(121);
      if (point.distanceM > 120) expect(point.coordinates[1]).toBe(25.001);
    }
    expect(line.samples[1].distanceM).toBe(20);
    expect(
      line.distanceM - line.samples[line.samples.length - 2].distanceM,
    ).toBeLessThanOrEqual(20);
  });

  it("keeps a sub-20m route's two endpoints", () => {
    expect(
      prepare([
        [121, 25],
        [121, 25.00005],
      ]).samples,
    ).toHaveLength(2);
  });

  it("accepts connected legs but rejects gaps and missing/nonfinite geometry", () => {
    const points: [number, number][] = [
      [121, 25],
      [121, 25.001],
    ];
    const connected = sampleWalkingRoute([
      leg(points),
      leg([
        [121, 25.001],
        [121.001, 25.001],
      ]),
    ]);
    expect(connected).not.toHaveProperty("status");
    for (const legs of [
      [],
      [leg([])],
      [
        leg([
          [121, 25],
          [121, 25],
        ]),
      ],
      [
        leg([
          [NaN, 25],
          [121, 25],
        ]),
      ],
      [
        leg([
          [181, 25],
          [121, 25],
        ]),
      ],
      [
        leg(points),
        leg([
          [121.01, 25.01],
          [121.02, 25.02],
        ]),
      ],
    ]) {
      expect(sampleWalkingRoute(legs)).toEqual({
        status: "unavailable",
        reason: "invalid_geometry",
      });
    }
  });

  it("rejects a route over 50km before allocating height samples", () => {
    expect(
      sampleWalkingRoute([
        leg([
          [121, 25],
          [121, 26],
        ]),
      ]),
    ).toEqual({ status: "unavailable", reason: "route_too_long" });
  });

  it("adds all rises and falls rather than just subtracting endpoints", () => {
    expect(elevationGain([10, 20, 15, 25])).toEqual({
      ascentM: 20,
      descentM: 5,
      netElevationM: 15,
    });
    expect(elevationGain([25, 15, 20, 10])).toEqual({
      ascentM: 5,
      descentM: 20,
      netElevationM: -15,
    });
    expect(elevationGain([-1, 0, -2])).toEqual({
      ascentM: 1,
      descentM: 2,
      netElevationM: -1,
    });
  });

  it("preserves zero and below-sea-level heights", () => {
    const line = prepare([
      [121, 25],
      [121, 25.00005],
    ]);
    expect(makeElevationProfile(line, [-2, 0])).toMatchObject({
      status: "complete",
      summary: { minElevationM: -2, ascentM: 2, validSamples: 2 },
    });
  });

  it("keeps null gaps with no whole-route cumulative totals", () => {
    const line = prepare([
      [121, 25],
      [121, 25.001],
    ]);
    const values: (number | null)[] = line.samples.map((_, i) => i);
    values[2] = null;
    const profile = makeElevationProfile(line, values);
    expect(profile).toMatchObject({
      status: "partial",
      summary: { ascentM: null, descentM: null, netElevationM: null },
    });
    if (profile.status !== "unavailable")
      expect(profile.samples[2].elevationM).toBeNull();
    expect(
      makeElevationProfile(
        line,
        line.samples.map(() => null),
      ),
    ).toEqual({ status: "unavailable", reason: "no_coverage" });
    expect(makeElevationProfile(line, [])).toEqual({
      status: "unavailable",
      reason: "data_unavailable",
    });
  });
});
