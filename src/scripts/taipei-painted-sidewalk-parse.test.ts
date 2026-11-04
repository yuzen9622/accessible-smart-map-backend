import { describe, expect, it } from "vitest";
import {
  isTwd97Tm2Prj,
  parsePaintedSidewalkFeature,
  stripWidthM,
} from "./taipei-painted-sidewalk-parse";

const TM2_PRJ =
  'PROJCS["TWD_1997_TM_Taiwan",GEOGCS["GCS_TWD_1997",DATUM["D_TWD_1997",SPHEROID["GRS_1980",6378137.0,298.257222101]],PRIMEM["Greenwich",0.0],UNIT["Degree",0.0174532925199433]],PROJECTION["Transverse_Mercator"],PARAMETER["False_Easting",250000.0],PARAMETER["False_Northing",0.0],PARAMETER["Central_Meridian",121.0],PARAMETER["Scale_Factor",0.9999],PARAMETER["Latitude_Of_Origin",0.0],UNIT["Meter",1.0]]';

/** A 30 m × 1.5 m strip near Taipei Main Station in TM2 metres. */
function strip(x = 302000, y = 2770000, length = 30, width = 1.5) {
  return [
    [
      [x, y],
      [x + length, y],
      [x + length, y + width],
      [x, y + width],
      [x, y],
    ],
  ];
}

function feature(
  properties: Record<string, unknown>,
  coordinates: unknown = strip(),
) {
  return { properties, geometry: { type: "Polygon", coordinates } };
}

describe("isTwd97Tm2Prj", () => {
  it("accepts the 交工處 TWD97 TM2 projection", () => {
    expect(isTwd97Tm2Prj(TM2_PRJ)).toBe(true);
  });

  it("rejects WGS84 and other TM zones", () => {
    expect(isTwd97Tm2Prj('GEOGCS["GCS_WGS_1984",DATUM["D_WGS_1984"]]')).toBe(
      false,
    );
    expect(isTwd97Tm2Prj(TM2_PRJ.replace("121.0", "119.0"))).toBe(false);
  });
});

describe("stripWidthM", () => {
  it("recovers the short side of a rectangle", () => {
    expect(stripWidthM(30 * 1.5, 2 * (30 + 1.5))).toBe(1.5);
  });

  it("returns null when no rectangle has that area and perimeter", () => {
    expect(stripWidthM(100, 10)).toBeNull();
    expect(stripWidthM(0, 10)).toBeNull();
  });
});

describe("parsePaintedSidewalkFeature", () => {
  it("accepts licode 21 and reprojects to WGS84 with a width estimate", () => {
    const result = parsePaintedSidewalkFeature(
      feature({ licode: "21", keyid: 7 }),
    );
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.sidewalk.keyid).toBe(7);
    expect(result.sidewalk.widthM).toBe(1.5);
    const [lng, lat] = result.sidewalk.coordinates[0][0][0];
    expect(lng).toBeGreaterThan(121.4);
    expect(lng).toBeLessThan(121.7);
    expect(lat).toBeGreaterThan(24.9);
    expect(lat).toBeLessThan(25.3);
  });

  it("drops every other road marking", () => {
    for (const licode of ["07", "08", "A8", "", null]) {
      expect(
        parsePaintedSidewalkFeature(feature({ licode, keyid: 1 })),
      ).toEqual({
        status: "other_marking",
      });
    }
  });

  it("drops strips marked removed (walkerstat D)", () => {
    expect(
      parsePaintedSidewalkFeature(
        feature({ licode: "21", keyid: 1, walkerstat: "D" }),
      ),
    ).toEqual({ status: "removed" });
  });

  it("rejects bad keys, broken rings and slivers", () => {
    expect(
      parsePaintedSidewalkFeature(feature({ licode: "21", keyid: 0 })).status,
    ).toBe("malformed");
    expect(
      parsePaintedSidewalkFeature(
        feature({ licode: "21", keyid: 1 }, [
          [
            [0, 0],
            [1, 1],
          ],
        ]),
      ).status,
    ).toBe("malformed");
    expect(
      parsePaintedSidewalkFeature(
        feature({ licode: "21", keyid: 1 }, strip(302000, 2770000, 0.5, 0.5)),
      ).status,
    ).toBe("malformed");
  });

  it("accepts MultiPolygon geometry", () => {
    const result = parsePaintedSidewalkFeature({
      properties: { licode: "21", keyid: 3 },
      geometry: { type: "MultiPolygon", coordinates: [strip(), strip(302100)] },
    });
    expect(result.status).toBe("ok");
    if (result.status === "ok")
      expect(result.sidewalk.coordinates).toHaveLength(2);
  });
});
