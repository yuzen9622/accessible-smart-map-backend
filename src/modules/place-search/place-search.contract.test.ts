import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import request from "supertest";

vi.mock("axios", () => ({ default: { post: vi.fn(), get: vi.fn() } }));
vi.mock("../../config/redis", () => ({
  redisClient: null,
  redisReady: vi.fn(),
  redisGet: vi.fn(),
  redisSet: vi.fn(),
  redisSetChecked: vi.fn(),
  redisSetNx: vi.fn(),
  redisDel: vi.fn(),
}));

import axios from "axios";
import { redisGet, redisSet } from "../../config/redis";
import {
  startTestServer,
  stopTestServer,
} from "../../../tests/helpers/test-helpers";
import { AutocompleteItemSchema } from "./place-search.schema";

const BASE = "/api/v1/a11y/search/autocomplete";
const KEYS = [
  "id",
  "source",
  "primaryText",
  "secondaryText",
  "placeClass",
  "placeType",
  "typeLabel",
].sort();
const googleItem = {
  id: "google:station-id",
  source: "google",
  primaryText: "台中車站",
  secondaryText: "台中市中區",
  placeClass: "railway",
  placeType: "station",
  typeLabel: "車站",
};
const prediction = (
  types: unknown = ["train_station", "point_of_interest"],
) => ({
  placePrediction: {
    placeId: "station-id",
    structuredFormat: {
      mainText: { text: "台中車站" },
      secondaryText: { text: "台中市中區" },
    },
    types,
  },
});
const photonFeature = (name = "臺中國家歌劇院") => ({
  properties: {
    countrycode: "TW",
    osm_type: "N",
    osm_id: 123,
    name,
    city: "臺中市",
    district: "西屯區",
    osm_key: "amenity",
    osm_value: "theatre",
  },
  geometry: { type: "Point", coordinates: [120.6403, 24.1624] },
});

let app: Awaited<ReturnType<typeof startTestServer>>;
beforeAll(async () => {
  app = await startTestServer();
});
afterAll(async () => {
  await stopTestServer(app);
});
beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv("GOOGLE_MAPS_API_KEY", "test-key");
  vi.mocked(redisGet).mockResolvedValue(null);
  vi.mocked(redisSet).mockResolvedValue(undefined);
  vi.mocked(axios.post).mockResolvedValue({
    data: { suggestions: [prediction()] },
  });
  vi.mocked(axios.get).mockResolvedValue({
    data: { features: [photonFeature()] },
  });
});
afterAll(() => {
  vi.unstubAllEnvs();
});

describe("compact autocomplete public contract", () => {
  it("returns exactly seven fields for both sources through the real service and adapters", async () => {
    const res = await request(app).get(BASE).query({
      q: "台中",
      lat: "24.1",
      lng: "120.6",
      sessiontoken: "search-session",
    });
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(2);
    for (const item of res.body.data) {
      expect(Object.keys(item).sort()).toEqual(KEYS);
      expect(AutocompleteItemSchema.safeParse(item).success).toBe(true);
    }
    expect(res.body.data).toContainEqual(googleItem);
    expect(res.body.data).toContainEqual({
      id: "osm:node:123",
      source: "osm",
      primaryText: "臺中國家歌劇院",
      secondaryText: "臺中市西屯區",
      placeClass: "amenity",
      placeType: "theatre",
      typeLabel: "劇院",
    });
    expect(axios.post).toHaveBeenCalledExactlyOnceWith(
      "https://places.googleapis.com/v1/places:autocomplete",
      expect.objectContaining({
        input: "台中",
        sessionToken: "search-session",
        origin: { latitude: 24.1, longitude: 120.6 },
      }),
      expect.any(Object),
    );
    expect(axios.get).toHaveBeenCalledTimes(1);
    expect(vi.mocked(axios.get).mock.calls[0][0]).toMatch(/\/api\/$/);
  });

  it("maps Google types and labels in English without resolving Details", async () => {
    const res = await request(app)
      .get(BASE)
      .query({ q: "taichung", sources: "google", lang: "en" });
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([{ ...googleItem, typeLabel: "Station" }]);
    expect(axios.get).not.toHaveBeenCalled();
    expect(axios.post).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ languageCode: "en" }),
      expect.any(Object),
    );
  });

  it.each([
    { types: undefined },
    { types: [] },
    { types: null },
    { types: "train_station" },
    { types: [null, 123] },
    { types: ["point_of_interest", "establishment"] },
  ])("keeps unknown Google types nullable ($types)", async ({ types }) => {
    const item = prediction();
    item.placePrediction.types = types;
    vi.mocked(axios.post).mockResolvedValue({ data: { suggestions: [item] } });
    const res = await request(app)
      .get(BASE)
      .query({ q: "台中", sources: "google" });
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([
      { ...googleItem, placeClass: null, placeType: null, typeLabel: null },
    ]);
    expect(axios.get).not.toHaveBeenCalled();
  });

  it("preserves the existing OSM-first normalized-name deduplication", async () => {
    vi.mocked(axios.get).mockResolvedValue({
      data: { features: [photonFeature("臺中 車站")] },
    });
    const res = await request(app).get(BASE).query({ q: "台中" });
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].id).toBe("osm:node:123");
    expect(Object.keys(res.body.data[0]).sort()).toEqual(KEYS);
  });

  it("does not serve legacy merged-cache payloads containing removed fields", async () => {
    vi.mocked(redisGet).mockImplementation(async (key) =>
      key.startsWith("ps:ac:") && !key.startsWith("ps:ac:v2:")
        ? JSON.stringify([
            { ...googleItem, location: null, distanceMeters: null },
          ])
        : null,
    );
    const res = await request(app)
      .get(BASE)
      .query({ q: "台中", sources: "google" });
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([googleItem]);
    expect(axios.post).toHaveBeenCalledTimes(1);
  });

  it("serves compact cached results without calling either upstream", async () => {
    vi.mocked(redisGet).mockResolvedValue(JSON.stringify([googleItem]));
    const res = await request(app)
      .get(BASE)
      .query({ q: "台中", sources: "google" });
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([googleItem]);
    expect(axios.post).not.toHaveBeenCalled();
    expect(axios.get).not.toHaveBeenCalled();
  });

  it("documents the compact schema while preserving location/distance on Details", async () => {
    const res = await request(app).get("/api/v1/openapi.json");
    expect(res.status).toBe(200);
    const schemas = res.body.components.schemas;
    expect(Object.keys(schemas.AutocompleteItem.properties).sort()).toEqual(
      KEYS,
    );
    expect(schemas.AutocompleteItem.required.slice().sort()).toEqual(KEYS);
    expect(schemas.PlaceResult.properties).toHaveProperty("location");
    expect(schemas.PlaceResult.properties).toHaveProperty("distanceMeters");
    expect(
      AutocompleteItemSchema.safeParse({
        ...googleItem,
        location: null,
        distanceMeters: null,
      }).success,
    ).toBe(false);
  });
});
