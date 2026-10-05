import { describe, expect, it, vi } from "vitest";

vi.mock("../visual-a11y/visual-a11y.service", () => ({
  findAudioSignalsWithin: vi.fn(),
}));
vi.mock("../../config/fetch", () => ({ tdxFetch: vi.fn() }));

import { findAudioSignalsWithin } from "../visual-a11y/visual-a11y.service";
import type { AccessibleRoute, WalkLeg } from "../../types/route";
import { attachAudioSignals, scoreAndRank } from "./accessible-route.service";

function walkRoute(id: string): AccessibleRoute {
  return {
    routeId: id,
    routeName: id,
    totalMinutes: 10,
    transferCount: 0,
    accessibilityHighlights: [],
    legs: [
      {
        type: "WALK",
        from: "起點",
        to: "終點",
        distanceM: 1000,
        minutesEst: 10,
        polyline: [
          [121.55, 25.048],
          [121.56, 25.048],
        ],
        a11yFacilities: [],
        maxSlopePercent: null,
        crossings: null,
        crossingsWithCurbRamp: null,
        minPathWidthCm: null,
        surfaceType: "unknown",
        restPoints: [],
      } as WalkLeg,
    ],
  };
}

describe("attachAudioSignals", () => {
  it("adds matched signals to WALK legs as a11yPoints", async () => {
    vi.mocked(findAudioSignalsWithin).mockResolvedValue([
      {
        source: "taipei_tce",
        sourceId: "SKWPX10",
        type: "audio_signal",
        location: { type: "Point", coordinates: [121.555, 25.048] },
        properties: { name: "八德路三段 光復北路" },
      } as never,
    ]);
    const route = walkRoute("r");

    await attachAudioSignals([route]);

    expect((route.legs[0] as WalkLeg).a11yPoints).toEqual([
      {
        type: "audio_signal",
        location: [121.555, 25.048],
        name: "八德路三段 光復北路",
      },
    ]);
  });

  it("fails soft when the lookup throws", async () => {
    vi.mocked(findAudioSignalsWithin).mockRejectedValue(new Error("down"));
    const route = walkRoute("r");
    await expect(attachAudioSignals([route])).resolves.toBeUndefined();
    expect((route.legs[0] as WalkLeg).a11yPoints).toBeUndefined();
  });
});

describe("scoreAndRank with audible signals", () => {
  it("scores a visual_impaired route higher when its walk passes an audible signal", () => {
    const plain = walkRoute("plain");
    const withSignal = walkRoute("signal");
    (withSignal.legs[0] as WalkLeg).a11yPoints = [
      { type: "audio_signal", location: [121.555, 25.048] },
    ];

    const [a, b] = [
      scoreAndRank([plain], "visual_impaired")[0],
      scoreAndRank([withSignal], "visual_impaired")[0],
    ];

    expect(b.accessibilityScore).toBeGreaterThan(
      a.accessibilityScore as number,
    );
  });
});
