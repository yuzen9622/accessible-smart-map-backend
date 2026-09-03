import { describe, expect, it } from "vitest";
import type { TrafficSectionGeometry } from "../../types/traffic";
import {
  buildSegmentIndex,
  querySegmentCandidates,
  segmentIndexStats,
} from "./traffic-segment-index";

describe("traffic-segment-index", () => {
  it("indexes LineString geometries with correct segment counts and sectionIds", () => {
    const geometries: TrafficSectionGeometry[] = [
      {
        sectionId: "sec-1",
        city: "Taipei",
        geometry: {
          type: "LineString",
          coordinates: [
            [121.5, 25.0],
            [121.51, 25.01],
            [121.52, 25.02],
          ],
        },
      },
      {
        sectionId: "sec-2",
        city: "Taipei",
        geometry: {
          type: "LineString",
          coordinates: [
            [121.6, 25.1],
            [121.61, 25.11],
          ],
        },
      },
    ];

    const index = buildSegmentIndex(geometries);
    expect(index.segmentCount).toBe(3);
    expect(index.sectionIds).toEqual(["sec-1", "sec-2"]);
    expect(index.flatbush).not.toBeNull();

    // First section segments
    expect(index.sectionIdx[0]).toBe(0);
    expect(index.sectionIdx[1]).toBe(0);
    // Second section segments
    expect(index.sectionIdx[2]).toBe(1);

    const stats = segmentIndexStats(index);
    expect(stats.segments).toBe(3);
    expect(stats.sections).toBe(2);
  });

  it("handles MultiLineString without generating spurious cross-line segments", () => {
    const geometries: TrafficSectionGeometry[] = [
      {
        sectionId: "multi-sec",
        city: "Taipei",
        geometry: {
          type: "MultiLineString",
          coordinates: [
            [
              [121.5, 25.0],
              [121.51, 25.0],
            ],
            [
              [121.6, 25.1],
              [121.61, 25.1],
            ],
          ],
        },
      },
    ];

    const index = buildSegmentIndex(geometries);
    // Exactly 2 segments (1 per sub-line), NOT 3 (no connector between [121.51, 25.0] and [121.6, 25.1])
    expect(index.segmentCount).toBe(2);
    expect(index.ax[0]).toBe(121.5);
    expect(index.bx[0]).toBe(121.51);
    expect(index.ax[1]).toBe(121.6);
    expect(index.bx[1]).toBe(121.61);
  });

  it("skips zero-length segments so bearings are never undefined", () => {
    const geometries: TrafficSectionGeometry[] = [
      {
        sectionId: "sec-with-zero",
        city: "Taipei",
        geometry: {
          type: "LineString",
          coordinates: [
            [121.5, 25.0],
            [121.5, 25.0], // duplicate / zero length
            [121.51, 25.0],
          ],
        },
      },
    ];

    const index = buildSegmentIndex(geometries);
    expect(index.segmentCount).toBe(1);
    expect(index.ax[0]).toBe(121.5);
    expect(index.bx[0]).toBe(121.51);
    expect(Number.isFinite(index.bearing[0])).toBe(true);
  });

  it("handles empty input gracefully without throwing", () => {
    const index = buildSegmentIndex([]);
    expect(index.segmentCount).toBe(0);
    expect(index.flatbush).toBeNull();
    expect(index.sectionIds).toEqual([]);

    const candidates = querySegmentCandidates(index, 120, 24, 122, 26, 10);
    expect(candidates).toEqual([]);

    const stats = segmentIndexStats(index);
    expect(stats.segments).toBe(0);
    expect(stats.sections).toBe(0);
  });

  it("supports legacy coordinates field without geometry property", () => {
    const geometries: TrafficSectionGeometry[] = [
      {
        sectionId: "legacy-sec",
        city: "Taipei",
        geometry: undefined as unknown as TrafficSectionGeometry["geometry"],
        coordinates: [
          [121.5, 25.0],
          [121.51, 25.0],
        ],
      },
    ];

    const index = buildSegmentIndex(geometries);
    expect(index.segmentCount).toBe(1);
    expect(index.sectionIds).toEqual(["legacy-sec"]);
    expect(index.ax[0]).toBe(121.5);
  });

  it("queries spatial candidates bounded by max limit", () => {
    const geometries: TrafficSectionGeometry[] = [
      {
        sectionId: "s1",
        city: "Taipei",
        geometry: {
          type: "LineString",
          coordinates: [
            [121.5, 25.0],
            [121.51, 25.0],
            [121.52, 25.0],
            [121.53, 25.0],
          ],
        },
      },
    ];

    const index = buildSegmentIndex(geometries);
    expect(index.segmentCount).toBe(3);

    // Query covering all 3
    const all = querySegmentCandidates(index, 121.49, 24.99, 121.54, 25.01, 10);
    expect(all.length).toBe(3);

    // Query with max=2
    const capped = querySegmentCandidates(
      index,
      121.49,
      24.99,
      121.54,
      25.01,
      2,
    );
    expect(capped.length).toBe(2);

    // Query outside
    const none = querySegmentCandidates(index, 122.0, 26.0, 122.1, 26.1, 10);
    expect(none.length).toBe(0);
  });
});
