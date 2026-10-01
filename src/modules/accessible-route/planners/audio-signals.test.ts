import { describe, expect, it } from "vitest";
import { matchAudioSignals, paddedBbox } from "./audio-signals";

const street: [number, number][] = [
  [121.55, 25.048],
  [121.56, 25.048],
];
const north = (m: number) => 25.048 + m / 111_195;

describe("matchAudioSignals", () => {
  it("keeps signals within 20 m of the leg and drops farther ones", () => {
    const matched = matchAudioSignals(street, [
      { source: "taipei_tce", location: [121.555, north(10)], name: "A 路口" },
      { source: "taipei_tce", location: [121.557, north(40)], name: "B 路口" },
    ]);
    expect(matched).toEqual([
      { type: "audio_signal", location: [121.555, north(10)], name: "A 路口" },
    ]);
  });

  it("treats an OSM node within 15 m of a TCE record as the same intersection", () => {
    const matched = matchAudioSignals(street, [
      { source: "osm", location: [121.55505, 25.048] },
      { source: "taipei_tce", location: [121.555, 25.048], name: "TCE" },
    ]);
    expect(matched).toHaveLength(1);
    expect(matched[0].name).toBe("TCE");
  });

  it("returns nothing for a degenerate leg", () => {
    expect(
      matchAudioSignals(
        [[121.55, 25.048]],
        [{ source: "osm", location: [121.55, 25.048] }],
      ),
    ).toEqual([]);
  });
});

describe("paddedBbox", () => {
  it("pads the box by the match radius", () => {
    const [minLng, minLat, maxLng, maxLat] = paddedBbox([street])!;
    expect(minLng).toBeLessThan(121.55);
    expect(maxLng).toBeGreaterThan(121.56);
    expect(minLat).toBeLessThan(25.048);
    expect(maxLat).toBeGreaterThan(25.048);
  });

  it("is null without points", () => {
    expect(paddedBbox([])).toBeNull();
  });
});
