import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("axios", () => ({ default: { get: vi.fn() } }));

import axios from "axios";
import { searchOsmPlaces } from "./photon.adapter";

const mockGet = axios.get as unknown as ReturnType<typeof vi.fn>;

const feature = (overrides: Record<string, unknown> = {}, geometry?: unknown) => ({
  type: "Feature",
  properties: {
    osm_type: "W",
    osm_id: 1159328965,
    osm_key: "tourism",
    osm_value: "attraction",
    name: "台北101",
    housenumber: "7",
    street: "信義路五段",
    locality: "西村里",
    district: "信義區",
    city: "台北市",
    postcode: "11049",
    countrycode: "TW",
    ...overrides,
  },
  geometry: geometry ?? { type: "Point", coordinates: [121.5644995, 25.0338352] },
});

beforeEach(() => {
  vi.clearAllMocks();
  delete process.env.PHOTON_BASE_URL;
});

describe("searchOsmPlaces", () => {
  it("normalizes a feature into an OsmPlace with a Taiwanese-order address", async () => {
    mockGet.mockResolvedValue({ data: { features: [feature()] } });

    const places = await searchOsmPlaces("台北1", { latitude: 25.033, longitude: 121.565 });

    expect(places).toEqual([
      {
        osmType: "way",
        osmId: "1159328965",
        name: "台北101",
        displayName: "台北市信義區信義路五段7號",
        latitude: 25.0338352,
        longitude: 121.5644995,
        placeClass: "tourism",
        placeType: "attraction",
        address: {
          road: "信義路五段",
          district: "信義區",
          city: "台北市",
          postcode: "11049",
        },
        tags: {},
      },
    ]);
  });

  it("asks Photon for English names and builds an English-order address", async () => {
    mockGet.mockResolvedValue({
      data: {
        features: [
          feature({
            name: "Taipei 101",
            street: "Section 5, Xinyi Road",
            district: "Xinyi District",
            city: "Taipei City",
          }),
        ],
      },
    });

    const places = await searchOsmPlaces("taipei", { lang: "en" });

    expect(mockGet).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ params: expect.objectContaining({ lang: "en" }) }),
    );
    expect(places[0].displayName).toBe("7 Section 5, Xinyi Road, Xinyi District, Taipei City");
  });

  it("sends the bias coordinates and over-fetches to survive country filtering", async () => {
    mockGet.mockResolvedValue({ data: { features: [] } });

    await searchOsmPlaces("台北", { latitude: 25.033, longitude: 121.565, limit: 3 });

    expect(mockGet).toHaveBeenCalledWith(
      "https://photon.komoot.io/api/",
      expect.objectContaining({
        params: { q: "台北", limit: 9, lang: "default", lat: 25.033, lon: 121.565 },
      }),
    );
  });

  it("omits the bias coordinates when they are absent", async () => {
    mockGet.mockResolvedValue({ data: { features: [] } });

    await searchOsmPlaces("台北");

    expect(mockGet).toHaveBeenCalledWith(
      "https://photon.komoot.io/api/",
      expect.objectContaining({ params: { q: "台北", limit: 15, lang: "default" } }),
    );
  });

  it("drops results outside Taiwan", async () => {
    mockGet.mockResolvedValue({
      data: {
        features: [
          feature({ osm_id: 1, countrycode: "CN", city: "厦门市" }),
          feature({ osm_id: 2, countrycode: "JP", city: "東京都" }),
          feature({ osm_id: 3 }),
          feature({ osm_id: 4, countrycode: undefined }),
        ],
      },
    });

    const places = await searchOsmPlaces("台北101");

    expect(places.map((p) => p.osmId)).toEqual(["3"]);
  });

  it("caps the filtered list at the requested limit", async () => {
    mockGet.mockResolvedValue({
      data: {
        features: [
          feature({ osm_id: 1, name: "甲" }),
          feature({ osm_id: 2, name: "乙" }),
          feature({ osm_id: 3, name: "丙" }),
        ],
      },
    });

    const places = await searchOsmPlaces("台北", { limit: 2 });

    expect(places.map((p) => p.osmId)).toEqual(["1", "2"]);
  });

  it("returns an empty array for a non-positive limit without calling the API", async () => {
    for (const limit of [0, -1]) {
      mockGet.mockClear();
      expect(await searchOsmPlaces("台北", { limit })).toEqual([]);
      expect(mockGet).not.toHaveBeenCalled();
    }
  });

  it("collapses name repeats that differ only by width, case or spacing", async () => {
    mockGet.mockResolvedValue({
      data: {
        features: [
          feature({ osm_id: 1, name: "台北101" }),
          feature({ osm_id: 2, name: "臺北 101" }),
          feature({ osm_id: 3, name: "台北1號隧道" }),
        ],
      },
    });

    const places = await searchOsmPlaces("台北1");

    expect(places.map((p) => p.osmId)).toEqual(["1", "3"]);
  });

  it("collapses exact name repeats, keeping the first", async () => {
    mockGet.mockResolvedValue({
      data: {
        features: [
          feature({ osm_id: 1, name: "台北101" }),
          feature({ osm_id: 2, name: "台北101/世貿" }),
          feature({ osm_id: 3, name: "台北101" }),
          feature({ osm_id: 4, name: "台北1號隧道" }),
        ],
      },
    });

    const places = await searchOsmPlaces("台北1");

    expect(places.map((p) => p.osmId)).toEqual(["1", "2", "4"]);
  });

  it("maps every osm_type prefix", async () => {
    for (const [prefix, expected] of [
      ["N", "node"],
      ["W", "way"],
      ["R", "relation"],
    ] as const) {
      mockGet.mockResolvedValue({ data: { features: [feature({ osm_type: prefix })] } });
      const [place] = await searchOsmPlaces("q");
      expect(place.osmType).toBe(expected);
    }
  });

  it("drops features with an unknown osm_type, no id, or no coordinates", async () => {
    mockGet.mockResolvedValue({
      data: {
        features: [
          feature({ osm_type: "X" }),
          feature({ osm_id: null }),
          feature({}, { type: "Point", coordinates: ["nope", "nope"] }),
        ],
      },
    });

    expect(await searchOsmPlaces("q")).toEqual([]);
  });

  it("falls back to the street when a feature carries no name", async () => {
    mockGet.mockResolvedValue({
      data: { features: [feature({ name: undefined, housenumber: undefined })] },
    });

    const [place] = await searchOsmPlaces("q");

    expect(place.name).toBe("信義路五段");
    expect(place.displayName).toBe("台北市信義區信義路五段");
  });

  it("falls back to the name when there is no address at all", async () => {
    mockGet.mockResolvedValue({
      data: {
        features: [
          feature({
            street: undefined,
            housenumber: undefined,
            district: undefined,
            locality: undefined,
            city: undefined,
          }),
        ],
      },
    });

    const [place] = await searchOsmPlaces("q");

    expect(place.displayName).toBe("台北101");
  });

  it("returns an empty array on a transport failure", async () => {
    mockGet.mockRejectedValue(new Error("network down"));
    expect(await searchOsmPlaces("台北")).toEqual([]);
  });

  it("returns an empty array when the payload is not a feature collection", async () => {
    mockGet.mockResolvedValue({ data: { error: "nope" } });
    expect(await searchOsmPlaces("台北")).toEqual([]);
  });

  it("honours PHOTON_BASE_URL for a self-hosted instance", async () => {
    process.env.PHOTON_BASE_URL = "http://photon:2322";
    mockGet.mockResolvedValue({ data: { features: [] } });

    await searchOsmPlaces("台北");

    expect(mockGet).toHaveBeenCalledWith("http://photon:2322/api/", expect.any(Object));
  });
});
