import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";

vi.mock("./place-search.service", async () => {
  const actual =
    await vi.importActual<typeof import("./place-search.service")>("./place-search.service");
  return {
    ...actual,
    autocomplete: vi.fn(),
    details: vi.fn(),
  };
});

import { buildTestApp } from "../../../tests/helpers/test-helpers";
import * as service from "./place-search.service";

const app = buildTestApp();
const BASE = "/api/v1/a11y";

const autocompleteItem = (): service.AutocompleteItem => ({
  id: "osm:node:123456",
  source: "osm",
  primaryText: "台北101",
  secondaryText: "台北市信義區信義路五段7號",
  placeClass: "tourism",
  placeType: "attraction",
  typeLabel: "景點",
  location: { type: "Point", coordinates: [121.5645, 25.0339] },
  distanceMeters: 1200,
});

const placeResult = (): service.PlaceResult => ({
  id: "google:ChIJ123",
  source: "google",
  name: "台北101",
  fullAddress: "台北市信義區信義路五段7號",
  addressComponents: {
    road: "信義路五段",
    district: "信義區",
    city: "臺北市",
    postcode: "110",
  },
  location: { type: "Point", coordinates: [121.5645, 25.0339] },
  placeClass: "shop",
  placeType: "mall",
  typeLabel: "購物中心",
  distanceMeters: 1200,
  rating: 4.5,
  accessibility: {
    status: "accessible",
    wheelchair: "yes",
    nearbyFacilityCount: 3,
    source: "local-db",
  },
  nearbyFacilities: { toilets: [], metro: [] },
  reviewKey: { placeId: "ChIJ123", placeType: "google" },
  externalLinks: {
    osm: null,
    google: "https://www.google.com/maps/place/?q=place_id:ChIJ123",
  },
  attribution: "Powered by Google",
});

beforeEach(() => {
  vi.resetAllMocks();
});

describe("GET /a11y/search/autocomplete", () => {
  it("returns 200 with the prediction list envelope", async () => {
    const items = [autocompleteItem()];
    vi.mocked(service.autocomplete).mockResolvedValue(items);

    const res = await request(app)
      .get(`${BASE}/search/autocomplete`)
      .query({ q: "台北", sessiontoken: "tok" });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.data).toEqual(items);
    expect(service.autocomplete).toHaveBeenCalledWith({
      q: "台北",
      sessionToken: "tok",
      lat: undefined,
      lng: undefined,
      sources: undefined,
      limit: undefined,
    });
  });

  it("forwards parsed coordinates when provided", async () => {
    vi.mocked(service.autocomplete).mockResolvedValue([]);

    await request(app)
      .get(`${BASE}/search/autocomplete`)
      .query({ q: "台北", lat: "25.033", lng: "121.565" });

    expect(service.autocomplete).toHaveBeenCalledWith({
      q: "台北",
      sessionToken: undefined,
      lat: 25.033,
      lng: 121.565,
      sources: undefined,
      limit: undefined,
    });
  });

  it("forwards the parsed source whitelist and limit", async () => {
    vi.mocked(service.autocomplete).mockResolvedValue([]);

    await request(app)
      .get(`${BASE}/search/autocomplete`)
      .query({ q: "台北", sources: "osm", limit: "3" });

    expect(service.autocomplete).toHaveBeenCalledWith(
      expect.objectContaining({ sources: ["osm"], limit: 3 }),
    );
  });

  it("returns 400 on an unknown source name", async () => {
    const res = await request(app)
      .get(`${BASE}/search/autocomplete`)
      .query({ q: "台北", sources: "bing" });

    expect(res.status).toBe(400);
    expect(service.autocomplete).not.toHaveBeenCalled();
  });

  it("returns 200 with an empty list when the service degrades", async () => {
    vi.mocked(service.autocomplete).mockResolvedValue([]);

    const res = await request(app).get(`${BASE}/search/autocomplete`).query({ q: "zzz" });

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([]);
  });

  it("returns 400 when q is missing", async () => {
    const res = await request(app).get(`${BASE}/search/autocomplete`).query({ sessiontoken: "tok" });

    expect(res.status).toBe(400);
    expect(service.autocomplete).not.toHaveBeenCalled();
  });

  it("returns 400 on an unknown query key", async () => {
    const res = await request(app)
      .get(`${BASE}/search/autocomplete`)
      .query({ q: "台北", foo: "bar" });

    expect(res.status).toBe(400);
  });
});

describe("GET /a11y/search/details/:id", () => {
  it("returns 200 with a single PlaceResult for a google id", async () => {
    const data = placeResult();
    vi.mocked(service.details).mockResolvedValue(data);

    const res = await request(app)
      .get(`${BASE}/search/details/google:ChIJ123`)
      .query({ sessiontoken: "tok", lat: "25.03", lng: "121.5" });

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual(data);
    expect(service.details).toHaveBeenCalledWith({
      id: "google:ChIJ123",
      sessionToken: "tok",
      lat: 25.03,
      lng: 121.5,
    });
  });

  it("accepts an osm id", async () => {
    vi.mocked(service.details).mockResolvedValue(placeResult());

    const res = await request(app).get(`${BASE}/search/details/osm:node:123456`);

    expect(res.status).toBe(200);
    expect(service.details).toHaveBeenCalledWith(
      expect.objectContaining({ id: "osm:node:123456" }),
    );
  });

  it("returns 400 on an unprefixed id", async () => {
    const res = await request(app).get(`${BASE}/search/details/ChIJ123`);

    expect(res.status).toBe(400);
    expect(service.details).not.toHaveBeenCalled();
  });

  it("returns 400 on an unknown prefix", async () => {
    const res = await request(app).get(`${BASE}/search/details/metro:TRTC-BL12`);

    expect(res.status).toBe(400);
    expect(service.details).not.toHaveBeenCalled();
  });

  it("returns 400 on a malformed osm id", async () => {
    const res = await request(app).get(`${BASE}/search/details/osm:node:abc`);

    expect(res.status).toBe(400);
    expect(service.details).not.toHaveBeenCalled();
  });

  it("returns 404 when the place is unresolvable", async () => {
    vi.mocked(service.details).mockResolvedValue(null);

    const res = await request(app).get(`${BASE}/search/details/google:ChIJmissing`);

    expect(res.status).toBe(404);
    expect(res.body.ok).toBe(false);
  });
});
