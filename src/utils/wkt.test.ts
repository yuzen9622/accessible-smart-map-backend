import { describe, it, expect } from "vitest";
import { wktToGeoJson } from "./wkt";

describe("wktToGeoJson", () => {
  it("parses a LINESTRING in TDX SectionShape form", () => {
    expect(
      wktToGeoJson(
        "LINESTRING(121.57425 25.06921,121.57448 25.0692,121.5747 25.0692)",
      ),
    ).toEqual({
      type: "LineString",
      coordinates: [
        [121.57425, 25.06921],
        [121.57448, 25.0692],
        [121.5747, 25.0692],
      ],
    });
  });

  it("parses a POINT in TDX LiveEvent form", () => {
    expect(wktToGeoJson("POINT(121.463906 25.123330)")).toEqual({
      type: "Point",
      coordinates: [121.463906, 25.12333],
    });
  });

  it("parses a MULTILINESTRING into nested coordinate arrays", () => {
    expect(
      wktToGeoJson(
        "MULTILINESTRING((121.5 25.0,121.51 25.01),(121.52 25.02,121.53 25.03))",
      ),
    ).toEqual({
      type: "MultiLineString",
      coordinates: [
        [
          [121.5, 25.0],
          [121.51, 25.01],
        ],
        [
          [121.52, 25.02],
          [121.53, 25.03],
        ],
      ],
    });
  });

  it("is case insensitive and tolerates padding", () => {
    expect(
      wktToGeoJson("  linestring  ( 121.5 25.0 ,  121.51 25.01 )  "),
    ).toEqual({
      type: "LineString",
      coordinates: [
        [121.5, 25.0],
        [121.51, 25.01],
      ],
    });
  });

  it("tolerates whitespace between MULTILINESTRING members", () => {
    const parsed = wktToGeoJson(
      "MultiLineString( (121.5 25.0, 121.51 25.01) , (121.52 25.02, 121.53 25.03) )",
    );
    expect(parsed?.type).toBe("MultiLineString");
  });

  it("returns null for empty, blank and absent input", () => {
    expect(wktToGeoJson("")).toBeNull();
    expect(wktToGeoJson("   ")).toBeNull();
    expect(wktToGeoJson(undefined)).toBeNull();
    expect(wktToGeoJson(null)).toBeNull();
  });

  it("returns null for an unsupported geometry tag", () => {
    expect(
      wktToGeoJson("POLYGON((121.5 25.0,121.51 25.01,121.5 25.0))"),
    ).toBeNull();
    expect(wktToGeoJson("GEOMETRYCOLLECTION(POINT(121.5 25.0))")).toBeNull();
  });

  it("returns null when a coordinate is not a pair of numbers", () => {
    expect(wktToGeoJson("LINESTRING(121.5 25.0,121.51)")).toBeNull();
    expect(wktToGeoJson("LINESTRING(121.5 25.0 3.0,121.51 25.01)")).toBeNull();
    expect(wktToGeoJson("LINESTRING(121.5 abc,121.51 25.01)")).toBeNull();
    expect(wktToGeoJson("POINT(121.5)")).toBeNull();
  });

  it("returns null for coordinates outside the WGS84 range", () => {
    expect(wktToGeoJson("POINT(200 25.0)")).toBeNull();
    expect(wktToGeoJson("LINESTRING(121.5 91,121.51 25.01)")).toBeNull();
  });

  it("returns null for a degenerate single-point LINESTRING", () => {
    expect(wktToGeoJson("LINESTRING(121.5 25.0)")).toBeNull();
  });

  it("returns null for malformed parentheses", () => {
    expect(wktToGeoJson("LINESTRING 121.5 25.0,121.51 25.01")).toBeNull();
    expect(wktToGeoJson("LINESTRING(121.5 25.0,121.51 25.01")).toBeNull();
    expect(
      wktToGeoJson(
        "MULTILINESTRING((121.5 25.0,121.51 25.01) junk (121.52 25.02,121.53 25.03))",
      ),
    ).toBeNull();
  });

  it("returns null when a MULTILINESTRING member is degenerate", () => {
    expect(
      wktToGeoJson("MULTILINESTRING((121.5 25.0,121.51 25.01),(121.52 25.02))"),
    ).toBeNull();
  });
});
