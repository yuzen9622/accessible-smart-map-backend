import { describe, expect, it } from "vitest";
import {
  ACCESSIBLE_RAMP_NAME,
  CAR_RAMP_NAME,
  parseRampFeature,
  tm2ToWgs84,
  type RampFeature,
} from "./taipei-ramps-parse";

function feature(
  overrides: Partial<NonNullable<RampFeature["properties"]>> = {},
): RampFeature {
  return {
    properties: {
      OBJECTID: 1,
      Name: ACCESSIBLE_RAMP_NAME,
      Town_N: "大安區",
      X_3826: 300000,
      Y_3826: 2770000,
      ...overrides,
    },
    geometry: { type: "Point", coordinates: [300000, 2770000] },
  };
}

describe("parseRampFeature Name gate", () => {
  it("accepts a 無障礙斜坡道 feature", () => {
    const result = parseRampFeature(feature());
    expect(result.status).toBe("ok");
  });

  it("rejects a 汽車斜坡道 feature", () => {
    const result = parseRampFeature(feature({ Name: CAR_RAMP_NAME }));
    expect(result).toEqual({ status: "not_accessible_ramp" });
  });

  it("rejects any other Name value", () => {
    const result = parseRampFeature(feature({ Name: "其他設施" }));
    expect(result).toEqual({ status: "not_accessible_ramp" });
  });
});

describe("parseRampFeature coordinate consistency", () => {
  it("keeps a feature whose geometry and X_3826/Y_3826 agree within 1cm", () => {
    const result = parseRampFeature({
      properties: {
        OBJECTID: 2,
        Name: ACCESSIBLE_RAMP_NAME,
        Town_N: "中山區",
        X_3826: 300000.005,
        Y_3826: 2770000,
      },
      geometry: { type: "Point", coordinates: [300000, 2770000] },
    });
    expect(result.status).toBe("ok");
  });

  it("discards a feature whose geometry and X_3826/Y_3826 disagree by more than 1cm", () => {
    const result = parseRampFeature({
      properties: {
        OBJECTID: 3,
        Name: ACCESSIBLE_RAMP_NAME,
        Town_N: "中山區",
        X_3826: 300000.02,
        Y_3826: 2770000,
      },
      geometry: { type: "Point", coordinates: [300000, 2770000] },
    });
    expect(result).toEqual({ status: "coordinate_mismatch" });
  });
});

describe("parseRampFeature malformed input", () => {
  it("does not throw on missing properties", () => {
    expect(() => parseRampFeature({})).not.toThrow();
    expect(parseRampFeature({}).status).toBe("malformed");
  });

  it("does not throw on a non-Point geometry", () => {
    const result = parseRampFeature({
      properties: {
        OBJECTID: 4,
        Name: ACCESSIBLE_RAMP_NAME,
        X_3826: 300000,
        Y_3826: 2770000,
      },
      geometry: { type: "LineString", coordinates: [[300000, 2770000]] },
    });
    expect(result).toEqual({ status: "malformed" });
  });

  it("does not throw on a missing OBJECTID", () => {
    const result = parseRampFeature(feature({ OBJECTID: undefined }));
    expect(result).toEqual({ status: "malformed" });
  });
});

describe("tm2ToWgs84", () => {
  it("maps the TM2 origin (false easting, equator) to the central meridian at the equator", () => {
    const [lng, lat] = tm2ToWgs84(250000, 0);
    expect(lng).toBeCloseTo(121, 6);
    expect(lat).toBeCloseTo(0, 6);
  });
});
