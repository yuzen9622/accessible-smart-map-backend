import { describe, expect, it } from "vitest";
import {
  cleanSidewalkFeature,
  parseCountyCollection,
} from "./sidewalk-source-parse";

function feature(overrides: Record<string, unknown> = {}) {
  return {
    type: "Feature",
    properties: {
      COUNTY_NA: "臺北市",
      SW_WTH: 2,
      SWW_WTH: 1.2,
      SW_RAMP: 0,
      SW_DIRECT: "1",
      ...overrides,
    },
    geometry: {
      type: "Polygon",
      coordinates: [
        [
          [121, 25],
          [121.01, 25],
          [121.01, 25.01],
          [121, 25],
        ],
      ],
    },
  };
}
function polygon(value: unknown) {
  const result = cleanSidewalkFeature(value, "台北市");
  if (!("polygon" in result)) throw new Error(result.reason);
  return result.polygon;
}

describe("county schema", () => {
  it("accepts GeoJSON default WGS84 and explicit CRS84", () => {
    expect(
      parseCountyCollection({ type: "FeatureCollection", features: [] }),
    ).toEqual([]);
    expect(
      parseCountyCollection({
        type: "FeatureCollection",
        crs: {
          type: "name",
          properties: { name: "urn:ogc:def:crs:OGC:1.3:CRS84" },
        },
        features: [],
      }),
    ).toEqual([]);
  });
  it("rejects projected coordinates and malformed collections", () => {
    expect(() =>
      parseCountyCollection({
        type: "FeatureCollection",
        crs: { type: "name", properties: { name: "EPSG:3826" } },
        features: [],
      }),
    ).toThrow(/CRS/);
    expect(() => parseCountyCollection({ features: [] })).toThrow(/schema/);
  });
});

describe("feature cleaning", () => {
  it("normalizes county and Polygon, retaining roadside and raw values", () => {
    const result = polygon(feature());
    expect(result.county).toBe("台北市");
    expect(result.geometry.type).toBe("MultiPolygon");
    expect(result.raw_properties.SW_DIRECT).toBe("1");
    expect(result.effective_width_m).toBe(1.2);
    expect(result.quality_flags).toEqual([]);
  });
  it.each([null, undefined, 0, -1, "", "NaN", "Infinity"])(
    "retains geometry with unusable net width %s",
    (width) => {
      const result = polygon(feature({ SWW_WTH: width }));
      expect(result.effective_width_m).toBeNull();
      expect(result.raw_properties.SWW_WTH).toBe(width);
      expect(result.quality_flags).toContain("invalid_or_missing_net_width");
    },
  );
  it("rejects contradictory width without deleting sidewalk evidence", () => {
    expect(polygon(feature({ SW_WTH: 1, SWW_WTH: 3 }))).toMatchObject({
      width_m: 1,
      effective_width_m: null,
      quality_flags: ["net_width_exceeds_gross"],
    });
  });
  it.each([0, -1])(
    "does not trust positive clearance exceeding raw gross width %s",
    (gross) => {
      const result = polygon(feature({ SW_WTH: gross, SWW_WTH: 1.2 }));
      expect(result.width_m).toBeNull();
      expect(result.effective_width_m).toBeNull();
      expect(result.quality_flags).toEqual([
        "invalid_or_missing_gross_width",
        "net_width_exceeds_gross",
      ]);
      expect(result.raw_properties.SW_WTH).toBe(gross);
    },
  );
  it.each([
    [0, "recorded", 0],
    ["2", "recorded", 2],
    ["N", "not_required", null],
    [null, "unknown", null],
    [-1, "unknown", null],
    [1.5, "unknown", null],
  ])("keeps ramp %s distinct", (raw, status, count) => {
    expect(polygon(feature({ SW_RAMP: raw }))).toMatchObject({
      ramp_status: status,
      ramp_count: count,
    });
  });
  it("uses order-independent original content identity, not normalized numeric attributes", () => {
    const original = feature();
    const reordered = {
      ...original,
      properties: Object.fromEntries(
        Object.entries(original.properties).reverse(),
      ),
    };
    expect(polygon(original).source_id).toBe(polygon(reordered).source_id);
    expect(polygon(feature({ SWW_WTH: "1.2" })).source_id).not.toBe(
      polygon(original).source_id,
    );
  });
  it.each([
    null,
    { type: "Point", coordinates: [121, 25] },
    { type: "Polygon", coordinates: [] },
    {
      type: "Polygon",
      coordinates: [
        [
          [121, 25],
          [121, 26],
          [122, 26],
          [122, 25],
        ],
      ],
    },
    {
      type: "Polygon",
      coordinates: [
        [
          [121, 0],
          [121, 1],
          [122, 1],
          [121, 0],
        ],
      ],
    },
    {
      type: "Polygon",
      coordinates: [
        [
          [121, 25, 0],
          [121, 26, 0],
          [122, 26, 0],
          [121, 25, 0],
        ],
      ],
    },
  ])("quarantines malformed geometry %#", (geometry) => {
    expect(
      cleanSidewalkFeature({ ...feature(), geometry }, "台北市"),
    ).toHaveProperty("reason");
  });
  it("quarantines a mismatched county feature", () => {
    expect(
      cleanSidewalkFeature(feature({ COUNTY_NA: "未知" }), "台北市"),
    ).toEqual({ reason: "county_mismatch" });
  });
});
