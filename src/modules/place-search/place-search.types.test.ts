import { describe, it, expect } from "vitest";
import {
  buildGooglePlaceId,
  buildOsmPlaceId,
  facilityLabelOf,
  googleTypesToClassType,
  mapOsmAccessibilityTags,
  normalizeName,
  parsePlaceId,
  toReviewOsmId,
  typeLabelOf,
} from "./place-search.types";

describe("place id", () => {
  it("round-trips a google id", () => {
    const id = buildGooglePlaceId("ChIJ123");
    expect(id).toBe("google:ChIJ123");
    expect(parsePlaceId(id)).toEqual({ source: "google", googlePlaceId: "ChIJ123" });
  });

  it("round-trips every osm type", () => {
    for (const osmType of ["node", "way", "relation"] as const) {
      const id = buildOsmPlaceId(osmType, "123");
      expect(parsePlaceId(id)).toEqual({ source: "osm", osmType, osmId: "123" });
    }
  });

  it("preserves colon-bearing google ids", () => {
    expect(parsePlaceId("google:ChIJ:weird:id")).toEqual({
      source: "google",
      googlePlaceId: "ChIJ:weird:id",
    });
  });

  it("rejects unprefixed, unknown-prefix and malformed ids", () => {
    expect(parsePlaceId("ChIJ123")).toBeNull();
    expect(parsePlaceId("metro:TRTC-BL12")).toBeNull();
    expect(parsePlaceId("google:")).toBeNull();
    expect(parsePlaceId("osm:node")).toBeNull();
    expect(parsePlaceId("osm:node:abc")).toBeNull();
    expect(parsePlaceId("osm:planet:123")).toBeNull();
    expect(parsePlaceId("osm:node:123:extra")).toBeNull();
  });

  it("restores the slash form the review module stores", () => {
    expect(toReviewOsmId("way", "456")).toBe("way/456");
  });
});

describe("normalizeName", () => {
  it("folds width, case, spacing and the 臺/台 variants together", () => {
    expect(normalizeName("臺北 101")).toBe(normalizeName("台北101"));
    expect(normalizeName("ＴＡＩＰＥＩ 101")).toBe(normalizeName("taipei101"));
  });

  it("keeps genuinely different names apart", () => {
    expect(normalizeName("台北101")).not.toBe(normalizeName("台北車站"));
  });
});

describe("googleTypesToClassType", () => {
  it("maps known types onto the OSM vocabulary, most specific first", () => {
    expect(googleTypesToClassType(["subway_station", "transit_station"])).toEqual({
      placeClass: "railway",
      placeType: "station",
    });
    expect(googleTypesToClassType(["shopping_mall"])).toEqual({
      placeClass: "shop",
      placeType: "mall",
    });
  });

  it("falls back to the raw type when nothing is mapped", () => {
    expect(googleTypesToClassType(["zoo", "point_of_interest"])).toEqual({
      placeClass: null,
      placeType: "zoo",
    });
  });

  it("ignores the generic Google types when falling back", () => {
    expect(googleTypesToClassType(["point_of_interest", "establishment"])).toEqual({
      placeClass: null,
      placeType: null,
    });
  });

  it("returns nulls for an empty type list", () => {
    expect(googleTypesToClassType([])).toEqual({ placeClass: null, placeType: null });
  });
});

describe("typeLabelOf", () => {
  it("translates known types and returns null otherwise", () => {
    expect(typeLabelOf("station")).toBe("車站");
    expect(typeLabelOf("attraction")).toBe("景點");
    expect(typeLabelOf("zoo")).toBeNull();
    expect(typeLabelOf(null)).toBeNull();
  });

  it("serves the English table when asked, with the same key coverage", () => {
    expect(typeLabelOf("station", "en")).toBe("Station");
    expect(typeLabelOf("attraction", "en")).toBe("Attraction");
    expect(typeLabelOf("zoo", "en")).toBeNull();
    expect(typeLabelOf(null, "en")).toBeNull();
  });
});

describe("mapOsmAccessibilityTags", () => {
  it("keeps missing and limited wheelchair tags out of boolean false", () => {
    expect(mapOsmAccessibilityTags({})).toEqual({
      wheelchair: null,
      wheelchairAccess: null,
      elevator: null,
      ramp: null,
      accessibleToilet: null,
    });
    expect(mapOsmAccessibilityTags({ wheelchair: "limited" })).toMatchObject({
      wheelchair: "limited",
      wheelchairAccess: null,
    });
    expect(mapOsmAccessibilityTags({ wheelchair: "no" })).toMatchObject({
      wheelchair: "no",
      wheelchairAccess: false,
    });
  });

  it("recognizes explicit facility tags and highway=elevator", () => {
    expect(
      mapOsmAccessibilityTags({
        highway: "elevator",
        "wheelchair:ramp": "no",
        "toilet:wheelchair": "yes",
      }),
    ).toMatchObject({
      elevator: true,
      ramp: false,
      accessibleToilet: true,
    });
  });

  it("reads the standard ramp:wheelchair key first", () => {
    expect(mapOsmAccessibilityTags({ "ramp:wheelchair": "no" })).toMatchObject({ ramp: false });
    expect(mapOsmAccessibilityTags({ "ramp:wheelchair": "yes" })).toMatchObject({ ramp: true });
  });

  it("keeps reading the legacy wheelchair:ramp alias", () => {
    expect(mapOsmAccessibilityTags({ "wheelchair:ramp": "yes" })).toMatchObject({ ramp: true });
  });

  it("maps class=highway,type=elevator to elevator even with empty extratags", () => {
    expect(mapOsmAccessibilityTags({}, "highway", "elevator")).toMatchObject({
      elevator: true,
      wheelchairAccess: null,
      ramp: null,
      accessibleToilet: null,
    });
  });

  it("never treats arbitrary class/type pairs as accessibility evidence", () => {
    expect(mapOsmAccessibilityTags({}, "amenity", "restaurant")).toMatchObject({
      elevator: null,
    });
    expect(mapOsmAccessibilityTags({}, "highway", "bus_stop")).toMatchObject({
      elevator: null,
    });
    expect(mapOsmAccessibilityTags({}, "railway", "station")).toMatchObject({
      elevator: null,
    });
  });

  it("lets an explicit elevator tag override the highway=elevator classification", () => {
    expect(mapOsmAccessibilityTags({ elevator: "no" }, "highway", "elevator")).toMatchObject({
      elevator: false,
    });
  });
});

describe("facilityLabelOf", () => {
  it("labels facility categories per language", () => {
    expect(facilityLabelOf("elevator")).toBe("電梯");
    expect(facilityLabelOf("elevator", "en")).toBe("Elevator");
    expect(facilityLabelOf("toilet", "en")).toBe("Accessible restroom");
  });

  it("falls back to the generic wording for unknown categories", () => {
    expect(facilityLabelOf("teleporter")).toBe("無障礙設施");
    expect(facilityLabelOf("teleporter", "en")).toBe("Accessible facility");
  });
});
