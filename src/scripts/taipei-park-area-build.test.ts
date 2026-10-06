import { describe, expect, it } from "vitest";
import {
  buildParkAreas,
  convexHull,
  extractOutlines,
  type OverpassParkElement,
} from "./taipei-park-area-build";
import type { ParkEntranceDoc } from "./taipei-park-entrance-parse";

// ~1e-5° ≈ 1 m here; the square spans roughly 200 m × 220 m.
const SQUARE = [
  { lat: 25.02, lon: 121.5 },
  { lat: 25.02, lon: 121.502 },
  { lat: 25.022, lon: 121.502 },
  { lat: 25.022, lon: 121.5 },
  { lat: 25.02, lon: 121.5 },
];

function way(id: number, geometry = SQUARE): OverpassParkElement {
  return { type: "way", id, geometry };
}

function entrance(parkName: string, lat: number, lng: number): ParkEntranceDoc {
  return {
    sourceId: `${parkName}-${lat}-${lng}`,
    district: null,
    parkName,
    entranceName: "出入口",
    location: { type: "Point", coordinates: [lng, lat] },
    minClearWidthM: 2,
    slopePercent: 3,
  };
}

describe("extractOutlines", () => {
  it("keeps closed ways and closed relation outers, drops open rings and inners", () => {
    const outlines = extractOutlines([
      way(1),
      way(2, SQUARE.slice(0, 4)),
      {
        type: "relation",
        id: 3,
        members: [
          { type: "way", role: "outer", geometry: SQUARE },
          { type: "way", role: "inner", geometry: SQUARE },
        ],
      },
    ]);
    expect(outlines.map((o) => o.osmId)).toEqual(["way/1", "relation/3"]);
  });

  it("drops consecutive duplicate vertices", () => {
    const [outline] = extractOutlines([way(1, [SQUARE[0], ...SQUARE])]);
    expect(outline.ring).toHaveLength(5);
  });
});

describe("convexHull", () => {
  it("returns a closed ring around the points", () => {
    const hull = convexHull([
      [0, 0],
      [100, 0],
      [50, 50],
      [100, 100],
      [0, 100],
    ]);
    expect(hull).toEqual([
      [0, 0],
      [100, 0],
      [100, 100],
      [0, 100],
      [0, 0],
    ]);
  });

  it("rejects collinear or sliver hulls", () => {
    expect(
      convexHull([
        [0, 0],
        [50, 0],
        [100, 0],
      ]),
    ).toBeNull();
    expect(
      convexHull([
        [0, 0],
        [100, 0],
        [0, 1],
      ]),
    ).toBeNull();
  });
});

describe("buildParkAreas", () => {
  it("uses the OSM outline that has most of the park's entrances on its edge", () => {
    const [built] = buildParkAreas(
      [
        entrance("青年公園", 25.02, 121.5005), // on the south edge
        entrance("青年公園", 25.0221, 121.501), // ~11 m outside the north edge
        entrance("青年公園", 25.025, 121.501), // far outside
      ],
      [way(7)],
    );
    expect(built.area).toMatchObject({
      parkName: "青年公園",
      source: "osm",
      osmId: "way/7",
    });
    expect(built.fallback?.source).toBe("entrance_hull");
  });

  it("prefers the smaller outline when two hold the same entrances", () => {
    const big = [
      { lat: 25.01, lon: 121.49 },
      { lat: 25.01, lon: 121.51 },
      { lat: 25.03, lon: 121.51 },
      { lat: 25.03, lon: 121.49 },
      { lat: 25.01, lon: 121.49 },
    ];
    const [built] = buildParkAreas(
      [entrance("小公園", 25.021, 121.501)],
      [way(1, big), way(2)],
    );
    expect(built.area.osmId).toBe("way/2");
  });

  it("falls back to the entrance hull when no outline matches", () => {
    const [built] = buildParkAreas(
      [
        entrance("無邊界公園", 25.05, 121.55),
        entrance("無邊界公園", 25.05, 121.552),
        entrance("無邊界公園", 25.052, 121.551),
      ],
      [way(7)],
    );
    expect(built.area.source).toBe("entrance_hull");
    expect(built.area.geometry.coordinates[0]).toHaveLength(4);
    expect(built.fallback).toBeNull();
  });

  it("gives no area to a park with neither an outline nor three entrances", () => {
    expect(
      buildParkAreas(
        [entrance("小綠地", 25.05, 121.55), entrance("小綠地", 25.05, 121.551)],
        [way(7)],
      ),
    ).toEqual([]);
  });
});
