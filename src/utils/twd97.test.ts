import { describe, expect, it } from "vitest";
import { sampleTwd97Lines, twd97ToWgs84 } from "./twd97";

describe("twd97ToWgs84", () => {
  it("maps the TM2 origin to the central meridian at the equator", () => {
    const [lng, lat] = twd97ToWgs84(250000, 0);
    expect(lng).toBeCloseTo(121, 6);
    expect(lat).toBeCloseTo(0, 6);
  });

  it("places a Xinyi District permit point in Taipei", () => {
    const [lng, lat] = twd97ToWgs84(309050.617, 2770535.957);
    expect(lng).toBeGreaterThan(121.57);
    expect(lng).toBeLessThan(121.6);
    expect(lat).toBeGreaterThan(25.02);
    expect(lat).toBeLessThan(25.06);
  });
});

describe("sampleTwd97Lines", () => {
  const line: [number, number][] = [
    [300000, 2770000],
    [300100, 2770000],
  ];

  it("keeps vertices and fills gaps no wider than the spacing", () => {
    const points = sampleTwd97Lines([line], 20, 1000);
    expect(points.length).toBe(7);
    const [first, last] = [points[0], points[points.length - 1]];
    const expectedFirst = twd97ToWgs84(300000, 2770000);
    expect(first.lng).toBeCloseTo(expectedFirst[0], 6);
    expect(last.lng).toBeGreaterThan(first.lng);
  });

  it("never returns more than the cap", () => {
    const long: [number, number][] = [
      [300000, 2770000],
      [310000, 2770000],
    ];
    expect(sampleTwd97Lines([long], 20, 50).length).toBeLessThanOrEqual(50);
  });
});
