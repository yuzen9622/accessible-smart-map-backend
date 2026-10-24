import { afterEach, describe, expect, it, vi } from "vitest";
import * as terrain from "../../adapters/terrain-elevation.adapter";
import type { AccessibleRoute, TravelMode } from "../../types/route";
import { attachWalkElevationProfiles } from "./route-elevation-enrichment";

const route = (): AccessibleRoute => ({
  routeId: "candidate",
  routeName: "walk",
  totalMinutes: 1,
  transferCount: 0,
  accessibilityHighlights: [],
  legs: [
    {
      type: "WALK",
      from: "A",
      to: "B",
      distanceM: 5,
      minutesEst: 1,
      polyline: [
        [121, 25],
        [121, 25.00005],
      ],
      a11yFacilities: [],
      maxSlopePercent: null,
      crossings: null,
      crossingsWithCurbRamp: null,
      minPathWidthCm: null,
      surfaceType: "unknown",
      restPoints: [],
    },
  ],
});
afterEach(() => vi.restoreAllMocks());

describe("walk-only elevation enrichment policy", () => {
  it.each(["transit", "drive", "motorcycle"] as TravelMode[])(
    "does not read DTM or change a %s result with WALK connectors",
    async (mode) => {
      const read = vi.spyOn(terrain, "sampleTerrain");
      const routes = [route()];
      const before = JSON.stringify(routes);
      await attachWalkElevationProfiles(routes, mode);
      expect(read).not.toHaveBeenCalled();
      expect(JSON.stringify(routes)).toBe(before);
    },
  );

  it("batches final walking candidates once without mutating their geometry or score", async () => {
    const read = vi
      .spyOn(terrain, "sampleTerrain")
      .mockResolvedValue({ ok: true, elevations: [1, 2, 3, 4] });
    const routes = [route(), route()];
    const before = routes.map((r) => ({ ...r }));
    await attachWalkElevationProfiles(routes, "walk");
    expect(read).toHaveBeenCalledTimes(1);
    expect(read.mock.calls[0][0]).toHaveLength(4);
    for (const [i, candidate] of routes.entries()) {
      expect(candidate.elevationProfile).toMatchObject({
        status: "complete",
        summary: { ascentM: 1 },
      });
      const { elevationProfile: _, ...rest } = candidate;
      expect(rest).toEqual(before[i]);
    }
  });

  it("does not launch a reader for invalid or too-long geometries, and limits candidates", async () => {
    const read = vi
      .spyOn(terrain, "sampleTerrain")
      .mockResolvedValue({ ok: false, reason: "busy" });
    const invalid = route();
    invalid.legs[0].polyline = [];
    const long = route();
    long.legs[0].polyline = [
      [121, 25],
      [121, 26],
    ];
    await attachWalkElevationProfiles([invalid, long], "walk");
    expect(read).not.toHaveBeenCalled();
    const routes = [route(), route(), route(), route()];
    await attachWalkElevationProfiles(routes, "walk");
    expect(read).toHaveBeenCalledTimes(1);
    expect(read.mock.calls[0][0]).toHaveLength(6);
    expect(routes[3].elevationProfile).toEqual({
      status: "unavailable",
      reason: "resource_limit",
    });
  });

  it("isolates unexpected reader failures and replaces stale geometry-specific data", async () => {
    const read = vi
      .spyOn(terrain, "sampleTerrain")
      .mockResolvedValueOnce({ ok: true, elevations: [10, 20] });
    const candidate = route();
    await attachWalkElevationProfiles([candidate], "walk");
    expect(candidate.elevationProfile).toMatchObject({
      status: "complete",
      summary: { netElevationM: 10 },
    });
    candidate.legs[0].polyline = [
      [121, 25],
      [121.00005, 25],
    ];
    read.mockRejectedValueOnce(new Error("reader failure"));
    await attachWalkElevationProfiles([candidate], "walk");
    expect(candidate.elevationProfile).toEqual({
      status: "unavailable",
      reason: "data_unavailable",
    });
  });
});
