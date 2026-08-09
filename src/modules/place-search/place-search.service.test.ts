import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../adapters/google.adapter", () => ({
  autocompletePlaces: vi.fn(),
  getPlaceDetails: vi.fn(),
}));
vi.mock("../../adapters/photon.adapter", () => ({
  searchOsmPlaces: vi.fn(),
}));
vi.mock("../../adapters/nominatim.adapter", () => ({
  lookupOsmPlace: vi.fn(),
}));
vi.mock("../../config/redis", () => ({
  redisGet: vi.fn(),
  redisSet: vi.fn(),
}));
vi.mock("../campus/campus.service", () => ({
  findFacilitiesNearby: vi.fn(),
}));
vi.mock("../../model/a11y.model", () => ({ default: { find: vi.fn() } }));
vi.mock("../../model/osm-a11y.model", () => ({ default: { find: vi.fn() } }));
vi.mock("../../model/bathroom.model", () => ({ default: { find: vi.fn() } }));
vi.mock("../../model/disabled-parking.model", () => ({ default: { find: vi.fn() } }));

import * as service from "./place-search.service";
import { autocompletePlaces, getPlaceDetails } from "../../adapters/google.adapter";
import { searchOsmPlaces } from "../../adapters/photon.adapter";
import { lookupOsmPlace } from "../../adapters/nominatim.adapter";
import { redisGet, redisSet } from "../../config/redis";
import * as campusService from "../campus/campus.service";
import A11y from "../../model/a11y.model";
import OsmA11y from "../../model/osm-a11y.model";
import BathroomModel from "../../model/bathroom.model";
import DisabledParkingModel from "../../model/disabled-parking.model";

/** Makes a model's `.find()` support both `.lean()` and `.limit().lean()`. */
function stubFind(model: { find: unknown }, docs: unknown[]) {
  const chain: any = { lean: () => Promise.resolve(docs), limit: () => chain };
  vi.mocked(model.find as any).mockReturnValue(chain);
}

function stubAllModelsEmpty() {
  stubFind(A11y as any, []);
  stubFind(OsmA11y as any, []);
  stubFind(BathroomModel as any, []);
  stubFind(DisabledParkingModel as any, []);
  vi.mocked(campusService.findFacilitiesNearby).mockResolvedValue([] as any);
}

const googleDetails = (overrides: Partial<any> = {}) => ({
  id: "ChIJ123",
  name: "台北101",
  formattedAddress: "台北市信義區信義路五段7號",
  location: { latitude: 25.0339, longitude: 121.5645 },
  rating: 4.5,
  wheelchair: null,
  wheelchairPartial: false,
  wheelchairAccessibleEntrance: null,
  wheelchairAccessibleRestroom: null,
  types: ["shopping_mall", "point_of_interest"],
  addressComponents: {
    road: "信義路五段",
    district: "信義區",
    city: "臺北市",
    postcode: "110",
  },
  ...overrides,
});

const osmPlace = (overrides: Partial<any> = {}) => ({
  osmType: "node" as const,
  osmId: "123456",
  name: "台北101",
  displayName: "台北101, 信義路五段, 信義區, 臺北市, 110, 臺灣",
  latitude: 25.0339,
  longitude: 121.5645,
  placeClass: "tourism",
  placeType: "attraction",
  address: { road: "信義路五段", district: "信義區", city: "臺北市", postcode: "110" },
  tags: {},
  ...overrides,
});

const legacyOsmPlace = () => {
  const place = osmPlace();
  delete place.tags;
  return place;
};

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(redisGet).mockResolvedValue(null);
  vi.mocked(redisSet).mockResolvedValue(undefined);
  vi.mocked(searchOsmPlaces).mockResolvedValue([]);
  vi.mocked(autocompletePlaces).mockResolvedValue([]);
});

describe("autocomplete", () => {
  it("merges both sources, OSM first, and caches the merged list", async () => {
    vi.mocked(searchOsmPlaces).mockResolvedValue([osmPlace()] as any);
    vi.mocked(autocompletePlaces).mockResolvedValue([
      { placeId: "p2", primaryText: "台北車站", secondaryText: "中正區" },
    ]);

    const items = await service.autocomplete({
      q: "台北",
      sessionToken: "tok",
      lat: 25.03,
      lng: 121.5,
    });

    expect(items.map((i) => i.id)).toEqual(["osm:node:123456", "google:p2"]);
    expect(items[0]).toMatchObject({
      source: "osm",
      primaryText: "台北101",
      placeClass: "tourism",
      placeType: "attraction",
      typeLabel: "景點",
      location: { type: "Point", coordinates: [121.5645, 25.0339] },
    });
    expect(items[1]).toMatchObject({
      source: "google",
      location: null,
      distanceMeters: null,
      typeLabel: null,
    });
    expect(autocompletePlaces).toHaveBeenCalledWith("台北", {
      sessionToken: "tok",
      latitude: 25.03,
      longitude: 121.5,
      lang: "zh-TW",
    });
  });

  it("passes the language to both upstreams and labels types in it", async () => {
    vi.mocked(searchOsmPlaces).mockResolvedValue([osmPlace()] as any);
    vi.mocked(autocompletePlaces).mockResolvedValue([]);

    const items = await service.autocomplete({ q: "taipei", lang: "en" });

    expect(searchOsmPlaces).toHaveBeenCalledWith("taipei", expect.objectContaining({ lang: "en" }));
    expect(autocompletePlaces).toHaveBeenCalledWith("taipei", expect.objectContaining({ lang: "en" }));
    expect(items[0].typeLabel).toBe("Attraction");
  });

  it("keys the caches per language so locales never share an entry", async () => {
    vi.mocked(searchOsmPlaces).mockResolvedValue([]);
    vi.mocked(autocompletePlaces).mockResolvedValue([]);

    await service.autocomplete({ q: "台北" });
    await service.autocomplete({ q: "台北", lang: "en" });

    const keys = vi.mocked(redisGet).mock.calls.map(([key]) => key);
    expect(keys.some((k) => k.startsWith("ps:ac:zh-TW:"))).toBe(true);
    expect(keys.some((k) => k.startsWith("ps:ac:en:"))).toBe(true);
    expect(keys.some((k) => k.startsWith("ps:osm:zh-TW:"))).toBe(true);
    expect(keys.some((k) => k.startsWith("ps:osm:en:"))).toBe(true);
  });

  it("drops the Google entry when both sources return the same normalized name", async () => {
    vi.mocked(searchOsmPlaces).mockResolvedValue([osmPlace()] as any);
    vi.mocked(autocompletePlaces).mockResolvedValue([
      { placeId: "p1", primaryText: "臺北 101", secondaryText: "信義區" },
    ]);

    const items = await service.autocomplete({ q: "台北" });

    expect(items).toHaveLength(1);
    expect(items[0].source).toBe("osm");
  });

  it("keeps both when the names differ, even for the same place", async () => {
    vi.mocked(searchOsmPlaces).mockResolvedValue([osmPlace()] as any);
    vi.mocked(autocompletePlaces).mockResolvedValue([
      { placeId: "p1", primaryText: "台北101購物中心", secondaryText: "信義區" },
    ]);

    const items = await service.autocomplete({ q: "台北" });

    expect(items).toHaveLength(2);
  });

  it("ranks prefix matches above non-prefix matches", async () => {
    vi.mocked(searchOsmPlaces).mockResolvedValue([
      osmPlace({ osmId: "1", name: "大安森林公園" }),
    ] as any);
    vi.mocked(autocompletePlaces).mockResolvedValue([
      { placeId: "p1", primaryText: "台北101", secondaryText: null },
    ]);

    const items = await service.autocomplete({ q: "台北" });

    expect(items.map((i) => i.primaryText)).toEqual(["台北101", "大安森林公園"]);
  });

  it("caps the merged list at the requested limit", async () => {
    vi.mocked(searchOsmPlaces).mockResolvedValue([
      osmPlace({ osmId: "1", name: "台北一" }),
      osmPlace({ osmId: "2", name: "台北二" }),
      osmPlace({ osmId: "3", name: "台北三" }),
    ] as any);

    const items = await service.autocomplete({ q: "台北", limit: 2 });

    expect(items).toHaveLength(2);
  });

  it("skips Google entirely when sources excludes it", async () => {
    vi.mocked(searchOsmPlaces).mockResolvedValue([osmPlace()] as any);

    const items = await service.autocomplete({ q: "台北", sources: ["osm"] });

    expect(items).toHaveLength(1);
    expect(autocompletePlaces).not.toHaveBeenCalled();
  });

  it("skips Nominatim entirely when sources excludes it", async () => {
    vi.mocked(autocompletePlaces).mockResolvedValue([
      { placeId: "p1", primaryText: "台北101", secondaryText: null },
    ]);

    const items = await service.autocomplete({ q: "台北", sources: ["google"] });

    expect(items).toHaveLength(1);
    expect(searchOsmPlaces).not.toHaveBeenCalled();
  });

  it("keeps the surviving source when the other one throws", async () => {
    vi.mocked(searchOsmPlaces).mockRejectedValue(new Error("nominatim down"));
    vi.mocked(autocompletePlaces).mockResolvedValue([
      { placeId: "p1", primaryText: "台北101", secondaryText: null },
    ]);

    const items = await service.autocomplete({ q: "台北" });

    expect(items).toHaveLength(1);
    expect(items[0].source).toBe("google");
  });

  it("returns cached items without calling either source", async () => {
    const cached = [{ id: "osm:node:1", source: "osm", primaryText: "cached" }];
    vi.mocked(redisGet).mockResolvedValue(JSON.stringify(cached));

    const items = await service.autocomplete({ q: "台北" });

    expect(items).toEqual(cached);
    expect(autocompletePlaces).not.toHaveBeenCalled();
    expect(searchOsmPlaces).not.toHaveBeenCalled();
  });

  it("treats malformed cache as a miss", async () => {
    vi.mocked(redisGet).mockResolvedValue("not json{{");

    const items = await service.autocomplete({ q: "台北" });

    expect(items).toEqual([]);
    expect(autocompletePlaces).toHaveBeenCalledOnce();
  });

  it("degrades to an empty list when both sources return nothing", async () => {
    expect(await service.autocomplete({ q: "zzz" })).toEqual([]);
  });
});

describe("details", () => {
  it("returns null on an unparseable id without calling any adapter", async () => {
    expect(await service.details({ id: "ChIJ123" })).toBeNull();
    expect(getPlaceDetails).not.toHaveBeenCalled();
    expect(lookupOsmPlace).not.toHaveBeenCalled();
  });

  it("returns null when the Google adapter returns null", async () => {
    vi.mocked(getPlaceDetails).mockResolvedValue(null);
    expect(await service.details({ id: "google:x" })).toBeNull();
  });

  it("returns null when the place has no coordinates", async () => {
    vi.mocked(getPlaceDetails).mockResolvedValue(googleDetails({ location: null }) as any);
    expect(await service.details({ id: "google:x" })).toBeNull();
  });

  it("resolves a Google place with mapped class/type, links and review key", async () => {
    vi.mocked(getPlaceDetails).mockResolvedValue(googleDetails() as any);
    stubAllModelsEmpty();

    const result = await service.details({
      id: "google:ChIJ123",
      lat: 25.0339,
      lng: 121.5645,
    });

    expect(result).toMatchObject({
      id: "google:ChIJ123",
      source: "google",
      location: { type: "Point", coordinates: [121.5645, 25.0339] },
      distanceMeters: 0,
      placeClass: "shop",
      placeType: "mall",
      typeLabel: "購物中心",
      rating: 4.5,
      reviewKey: { placeId: "ChIJ123", placeType: "google" },
      attribution: "Powered by Google",
    });
    expect(result?.addressComponents).toEqual({
      road: "信義路五段",
      district: "信義區",
      city: "臺北市",
      postcode: "110",
    });
    expect(result?.externalLinks.google).toContain("place_id:ChIJ123");
    expect(result?.externalLinks.osm).toBeNull();
  });

  it("resolves an OSM place without ever touching Google", async () => {
    vi.mocked(lookupOsmPlace).mockResolvedValue(osmPlace() as any);
    stubAllModelsEmpty();

    const result = await service.details({ id: "osm:node:123456" });

    expect(lookupOsmPlace).toHaveBeenCalledWith("node", "123456", { lang: "zh-TW" });
    expect(getPlaceDetails).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      id: "osm:node:123456",
      source: "osm",
      name: "台北101",
      placeClass: "tourism",
      placeType: "attraction",
      typeLabel: "景點",
      rating: null,
      distanceMeters: null,
      reviewKey: { placeId: "node/123456", placeType: "osm" },
      attribution: "© OpenStreetMap contributors",
    });
    expect(result?.externalLinks.osm).toBe("https://www.openstreetmap.org/node/123456");
    expect(result?.externalLinks.google).toBeNull();
  });

  it("returns null when the OSM lookup misses", async () => {
    vi.mocked(lookupOsmPlace).mockResolvedValue(null);
    expect(await service.details({ id: "osm:way:999" })).toBeNull();
  });

  it("normalizes a legacy cached OSM lookup with no tags", async () => {
    vi.mocked(redisGet).mockResolvedValueOnce(JSON.stringify(legacyOsmPlace()));
    stubAllModelsEmpty();

    const result = await service.details({ id: "osm:node:123456" });

    expect(result?.name).toBe("台北101");
    expect(result?.accessibility).toMatchObject({
      wheelchairAccess: null,
      elevator: null,
      ramp: null,
      accessibleToilet: null,
    });
    expect(lookupOsmPlace).not.toHaveBeenCalled();
  });

  it("builds the nearby toilet and metro lists sorted by distance", async () => {
    vi.mocked(lookupOsmPlace).mockResolvedValue(osmPlace() as any);
    stubAllModelsEmpty();
    stubFind(BathroomModel as any, [
      {
        _id: "b1",
        name: "遠處廁所",
        address: "信義路五段100號",
        location: { coordinates: [121.5665, 25.0339] },
      },
      {
        _id: "b2",
        name: "近處廁所",
        address: "信義路五段1號",
        location: { coordinates: [121.5646, 25.0339] },
      },
    ]);
    stubFind(A11y as any, [
      {
        _id: "m1",
        "出入口電梯/無障礙坡道名稱": "市政府站4號出口電梯",
        location: { coordinates: [121.5647, 25.0339] },
      },
    ]);

    const result = await service.details({ id: "osm:node:123456" });

    expect(result?.nearbyFacilities.toilets.map((t) => t.name)).toEqual(["近處廁所", "遠處廁所"]);
    expect(result?.nearbyFacilities.toilets[0]).toMatchObject({
      category: "toilet",
      typeLabel: "無障礙廁所",
      address: "信義路五段1號",
    });
    expect(result?.nearbyFacilities.metro[0]).toMatchObject({
      category: "elevator",
      typeLabel: "電梯",
      address: null,
    });
  });

  it("drops nearby facilities that carry no coordinates", async () => {
    vi.mocked(lookupOsmPlace).mockResolvedValue(osmPlace() as any);
    stubAllModelsEmpty();
    stubFind(BathroomModel as any, [{ _id: "b1", name: "無座標廁所", address: null }]);

    const result = await service.details({ id: "osm:node:123456" });

    expect(result?.nearbyFacilities.toilets).toEqual([]);
  });

  describe("accessibility", () => {
    it("keeps an untagged place unknown/none even when nearby facilities exist", async () => {
      vi.mocked(getPlaceDetails).mockResolvedValue(googleDetails() as any);
      stubAllModelsEmpty();
      stubFind(A11y as any, [{ _id: "e1" }]);

      const r = await service.details({ id: "google:ChIJ123" });

      expect(r?.accessibility).toEqual({
        status: "unknown",
        wheelchair: null,
        wheelchairAccess: null,
        elevator: null,
        ramp: null,
        accessibleToilet: null,
        nearbyFacilityCount: 1,
        source: "none",
      });
    });

    it("is accessible/google when Google explicitly reports a wheelchair entrance", async () => {
      vi.mocked(getPlaceDetails).mockResolvedValue(
        googleDetails({ wheelchair: "yes", wheelchairAccessibleEntrance: true }) as any,
      );
      stubAllModelsEmpty();

      const r = await service.details({ id: "google:ChIJ123" });

      expect(r?.accessibility).toMatchObject({
        status: "accessible",
        wheelchair: "yes",
        wheelchairAccess: true,
        elevator: null,
        ramp: null,
        accessibleToilet: null,
        source: "google",
      });
    });

    it("preserves Google explicit false accessibility options", async () => {
      vi.mocked(getPlaceDetails).mockResolvedValue(
        googleDetails({
          wheelchair: "no",
          wheelchairAccessibleEntrance: false,
          wheelchairAccessibleRestroom: false,
        }) as any,
      );
      stubAllModelsEmpty();

      const r = await service.details({ id: "google:ChIJ123" });

      expect(r?.accessibility).toMatchObject({
        status: "unknown",
        wheelchair: "no",
        wheelchairAccess: false,
        elevator: null,
        ramp: null,
        accessibleToilet: false,
        source: "google",
      });
    });

    it("returns null Google fields when the upstream has no accessibility options", async () => {
      vi.mocked(getPlaceDetails).mockResolvedValue(googleDetails() as any);
      stubAllModelsEmpty();

      const r = await service.details({ id: "google:ChIJ123" });

      expect(r?.accessibility).toMatchObject({
        status: "unknown",
        wheelchair: null,
        wheelchairAccess: null,
        elevator: null,
        ramp: null,
        accessibleToilet: null,
        source: "none",
      });
    });

    it("keeps the adapter wheelchairPartial for a restroom-only Google place", async () => {
      vi.mocked(getPlaceDetails).mockResolvedValue(
        googleDetails({
          wheelchairAccessibleRestroom: true,
          wheelchairPartial: true,
        }) as any,
      );
      stubAllModelsEmpty();

      const r = await service.details({ id: "google:ChIJ123" });

      expect(r?.accessibility).toMatchObject({
        status: "limited",
        wheelchair: "limited",
        wheelchairAccess: null,
        accessibleToilet: true,
        source: "google",
      });
    });

    it("is limited/google when the upstream provides a partial wheelchair signal", async () => {
      vi.mocked(getPlaceDetails).mockResolvedValue(
        googleDetails({ wheelchair: "no", wheelchairPartial: true }) as any,
      );
      stubAllModelsEmpty();

      const r = await service.details({ id: "google:ChIJ123" });

      expect(r?.accessibility).toMatchObject({
        status: "limited",
        wheelchair: "limited",
        source: "google",
      });
    });

    it("returns four null fields for an OSM place with no accessibility tags", async () => {
      vi.mocked(lookupOsmPlace).mockResolvedValue(osmPlace({ tags: {} }) as any);
      stubAllModelsEmpty();

      const r = await service.details({ id: "osm:node:123456" });

      expect(r?.accessibility).toMatchObject({
        status: "unknown",
        wheelchair: null,
        wheelchairAccess: null,
        elevator: null,
        ramp: null,
        accessibleToilet: null,
        source: "none",
      });
    });

    it("maps OSM wheelchair=no to explicit false", async () => {
      vi.mocked(lookupOsmPlace).mockResolvedValue(
        osmPlace({ tags: { wheelchair: "no" } }) as any,
      );
      stubAllModelsEmpty();

      const r = await service.details({ id: "osm:node:123456" });

      expect(r?.accessibility).toMatchObject({
        status: "unknown",
        wheelchair: "no",
        wheelchairAccess: false,
        source: "osm",
      });
    });

    it("keeps OSM wheelchair=limited as null evidence and a limited status", async () => {
      vi.mocked(lookupOsmPlace).mockResolvedValue(
        osmPlace({ tags: { wheelchair: "limited" } }) as any,
      );
      stubAllModelsEmpty();

      const r = await service.details({ id: "osm:node:123456" });

      expect(r?.accessibility).toMatchObject({
        status: "limited",
        wheelchair: "limited",
        wheelchairAccess: null,
        source: "osm",
      });
    });

    it("maps OSM elevator=no and highway=elevator to explicit evidence", async () => {
      vi.mocked(lookupOsmPlace).mockResolvedValue(
        osmPlace({ tags: { "elevator": "no", "highway": "elevator" } }) as any,
      );
      stubAllModelsEmpty();

      const r = await service.details({ id: "osm:node:123456" });

      expect(r?.accessibility).toMatchObject({
        elevator: false,
        source: "osm",
      });
    });

    it("maps a Nominatim highway=elevator classification even with empty extratags", async () => {
      vi.mocked(lookupOsmPlace).mockResolvedValue(
        osmPlace({
          placeClass: "highway",
          placeType: "elevator",
          tags: {},
        }) as any,
      );
      stubAllModelsEmpty();

      const r = await service.details({ id: "osm:node:123456" });

      expect(r?.accessibility).toMatchObject({
        status: "unknown",
        wheelchairAccess: null,
        elevator: true,
        ramp: null,
        accessibleToilet: null,
        source: "osm",
      });
    });

    it("does not treat arbitrary OSM class/type pairs as elevator evidence", async () => {
      vi.mocked(lookupOsmPlace).mockResolvedValue(
        osmPlace({ tags: {}, placeClass: "amenity", placeType: "restaurant" }) as any,
      );
      stubAllModelsEmpty();

      const r = await service.details({ id: "osm:node:123456" });

      expect(r?.accessibility).toMatchObject({
        elevator: null,
        source: "none",
      });
    });

    it("maps explicit OSM ramp and toilet evidence without inferring wheelchair access", async () => {
      vi.mocked(lookupOsmPlace).mockResolvedValue(
        osmPlace({ tags: { ramp: "no", "toilets:wheelchair": "yes" } }) as any,
      );
      stubAllModelsEmpty();

      const r = await service.details({ id: "osm:node:123456" });

      expect(r?.accessibility).toMatchObject({
        status: "unknown",
        wheelchairAccess: null,
        ramp: false,
        accessibleToilet: true,
        source: "osm",
      });
    });
  });
});
