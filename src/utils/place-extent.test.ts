import { describe, expect, it } from "vitest";
import {
  PLACE_EXTENT_MAX_SPAN_M,
  PLACE_EXTENT_PADDING_M,
} from "../config/place-extent";
import { haversineMeters } from "./geo";
import {
  bboxPolygon,
  preparePlaceBounds,
  type PlaceBounds,
} from "./place-extent";

describe("bboxPolygon", () => {
  it("returns a closed GeoJSON polygon in bbox order", () => {
    expect(bboxPolygon([120.68, 24.13, 120.69, 24.14])).toEqual({
      type: "Polygon",
      coordinates: [
        [
          [120.68, 24.13],
          [120.69, 24.13],
          [120.69, 24.14],
          [120.68, 24.14],
          [120.68, 24.13],
        ],
      ],
    });
  });
});

describe("preparePlaceBounds", () => {
  it("pads a small viewport on both axes", () => {
    const bounds: PlaceBounds = [120.68, 24.13, 120.681, 24.131];
    const prepared = preparePlaceBounds(bounds);

    expect(prepared[0]).toBeLessThan(bounds[0]);
    expect(prepared[1]).toBeLessThan(bounds[1]);
    expect(prepared[2]).toBeGreaterThan(bounds[2]);
    expect(prepared[3]).toBeGreaterThan(bounds[3]);
    expect(haversineMeters(prepared[1], 120.68, bounds[1], 120.68)).toBeCloseTo(
      PLACE_EXTENT_PADDING_M,
      0,
    );
  });

  it("caps a large viewport around its own centre", () => {
    const bounds: PlaceBounds = [120, 20, 122, 22];
    const prepared = preparePlaceBounds(bounds);
    const centre: [number, number] = [121, 21];

    expect((prepared[0] + prepared[2]) / 2).toBeCloseTo(centre[0], 12);
    expect((prepared[1] + prepared[3]) / 2).toBeCloseTo(centre[1], 12);
    expect(
      haversineMeters(centre[1], prepared[0], centre[1], prepared[2]),
    ).toBeCloseTo(PLACE_EXTENT_MAX_SPAN_M, 0);
    expect(
      haversineMeters(prepared[1], centre[0], prepared[3], centre[0]),
    ).toBeCloseTo(PLACE_EXTENT_MAX_SPAN_M, 0);
  });

  it("does not recenter a viewport that is exactly at the cap after padding", () => {
    const halfSpan = (PLACE_EXTENT_MAX_SPAN_M - 2 * PLACE_EXTENT_PADDING_M) / 2;
    const latDelta = (halfSpan / 6_371_000) * (180 / Math.PI);
    const lngDelta = latDelta / Math.cos((25 * Math.PI) / 180);
    const bounds: PlaceBounds = [
      120 - lngDelta,
      25 - latDelta,
      120 + lngDelta,
      25 + latDelta,
    ];
    const prepared = preparePlaceBounds(bounds);

    expect(prepared[1]).toBeLessThan(bounds[1]);
    expect(prepared[3]).toBeGreaterThan(bounds[3]);
    expect((prepared[1] + prepared[3]) / 2).toBeCloseTo(25, 12);
    expect((prepared[0] + prepared[2]) / 2).toBeCloseTo(120, 12);
    expect(haversineMeters(prepared[1], 120, prepared[3], 120)).toBeCloseTo(
      PLACE_EXTENT_MAX_SPAN_M,
      6,
    );
    expect(haversineMeters(25, prepared[0], 25, prepared[2])).toBeCloseTo(
      PLACE_EXTENT_MAX_SPAN_M,
      4,
    );
  });

  it.each<PlaceBounds>([
    [179.999, 24, 180, 24.001],
    [-180, 24, -179.999, 24.001],
    [120, 89.999, 120.001, 90],
    [120, -90, 120.001, -89.999],
  ])(
    "keeps padded coordinates inside valid longitude and latitude ranges (%s, %s, %s, %s)",
    (...bounds) => {
      const prepared = preparePlaceBounds(bounds);
      expect(prepared.every(Number.isFinite)).toBe(true);
      expect(prepared[0]).toBeGreaterThanOrEqual(-180);
      expect(prepared[2]).toBeLessThanOrEqual(180);
      expect(prepared[1]).toBeGreaterThanOrEqual(-90);
      expect(prepared[3]).toBeLessThanOrEqual(90);
    },
  );
});
