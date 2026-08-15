import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("axios", () => ({ default: { post: vi.fn(), get: vi.fn() } }));

import axios from "axios";
import {
  autocompletePlaces,
  getPlaceDetails,
  searchPlaces,
} from "./google.adapter";

const mockPost = axios.post as unknown as ReturnType<typeof vi.fn>;
const mockGet = axios.get as unknown as ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.clearAllMocks();
  process.env.GOOGLE_MAPS_API_KEY = "test-key";
});

describe("searchPlaces distance ordering", () => {
  it("requests extra candidates and returns the locally nearest places first", async () => {
    mockPost.mockResolvedValue({
      data: {
        places: [
          {
            id: "far",
            displayName: { text: "較遠站" },
            formattedAddress: "far",
            location: { latitude: 25.06, longitude: 121.52 },
          },
          {
            id: "near",
            displayName: { text: "最近站" },
            formattedAddress: "near",
            location: { latitude: 25.048, longitude: 121.5171 },
          },
          {
            id: "middle",
            displayName: { text: "中間站" },
            formattedAddress: "middle",
            location: { latitude: 25.05, longitude: 121.518 },
          },
        ],
      },
    });

    const places = await searchPlaces("火車站", {
      latitude: 25.0478,
      longitude: 121.517,
      maxResults: 2,
      sortByDistance: true,
    });

    expect(mockPost).toHaveBeenCalledWith(
      "https://places.googleapis.com/v1/places:searchText",
      expect.objectContaining({ maxResultCount: 10, languageCode: "zh-TW" }),
      expect.any(Object),
    );
    expect(places.map((place) => place.name)).toEqual(["最近站", "中間站"]);
    expect(places[0].distanceMeters).toBeLessThan(places[1].distanceMeters!);
  });

  it("preserves upstream relevance order when no GPS is supplied", async () => {
    mockPost.mockResolvedValue({
      data: {
        places: [
          {
            id: "a",
            displayName: { text: "第一筆" },
            formattedAddress: "a",
            location: { latitude: 25, longitude: 121 },
          },
          {
            id: "b",
            displayName: { text: "第二筆" },
            formattedAddress: "b",
            location: { latitude: 24, longitude: 120 },
          },
        ],
      },
    });

    const places = await searchPlaces("火車站");

    expect(places.map((place) => place.name)).toEqual(["第一筆", "第二筆"]);
    expect(places[0].distanceMeters).toBeUndefined();
  });

  it("drops malformed coordinates without losing valid nearby candidates", async () => {
    mockPost.mockResolvedValue({
      data: {
        places: [
          {
            id: "missing",
            displayName: { text: "缺座標" },
            formattedAddress: "missing",
          },
          {
            id: "nan",
            displayName: { text: "壞座標" },
            formattedAddress: "nan",
            location: { latitude: Number.NaN, longitude: 121 },
          },
          {
            id: "far",
            displayName: { text: "較遠站" },
            formattedAddress: "far",
            location: { latitude: 25.06, longitude: 121.52 },
          },
          {
            id: "near",
            displayName: { text: "最近站" },
            formattedAddress: "near",
            location: { latitude: 25.048, longitude: 121.5171 },
          },
        ],
      },
    });

    const places = await searchPlaces("火車站", {
      latitude: 25.0478,
      longitude: 121.517,
      sortByDistance: true,
    });

    expect(places.map((place) => place.name)).toEqual(["最近站", "較遠站"]);
  });
});

describe("place language", () => {
  it("defaults autocomplete predictions to zh-TW", async () => {
    mockPost.mockResolvedValue({ data: { suggestions: [] } });

    await autocompletePlaces("台北");

    expect(mockPost).toHaveBeenCalledWith(
      "https://places.googleapis.com/v1/places:autocomplete",
      expect.objectContaining({ languageCode: "zh-TW", regionCode: "TW" }),
      expect.any(Object),
    );
  });

  it("asks for predictions in the requested language", async () => {
    mockPost.mockResolvedValue({ data: { suggestions: [] } });

    await autocompletePlaces("taipei", { lang: "en" });

    expect(mockPost).toHaveBeenCalledWith(
      "https://places.googleapis.com/v1/places:autocomplete",
      expect.objectContaining({ languageCode: "en" }),
      expect.any(Object),
    );
  });

  it("sends languageCode on place details alongside the session token", async () => {
    mockGet.mockResolvedValue({
      data: {
        id: "ChIJ123",
        displayName: { text: "Taipei 101" },
        location: { latitude: 25.03, longitude: 121.56 },
      },
    });

    const details = await getPlaceDetails("ChIJ123", {
      sessionToken: "tok",
      lang: "en",
    });

    expect(mockGet).toHaveBeenCalledWith(
      "https://places.googleapis.com/v1/places/ChIJ123",
      expect.objectContaining({
        params: { languageCode: "en", sessionToken: "tok" },
      }),
    );
    expect(details?.name).toBe("Taipei 101");
  });
});

describe("place details accessibility", () => {
  it("preserves explicit false accessibility options", async () => {
    mockGet.mockResolvedValue({
      data: {
        id: "ChIJ123",
        displayName: { text: "台北101" },
        location: { latitude: 25.03, longitude: 121.56 },
        accessibilityOptions: {
          wheelchairAccessibleEntrance: false,
          wheelchairAccessibleRestroom: false,
        },
      },
    });

    const details = await getPlaceDetails("ChIJ123");

    expect(details).toMatchObject({
      wheelchair: "no",
      wheelchairPartial: false,
      wheelchairAccessibleEntrance: false,
      wheelchairAccessibleRestroom: false,
    });
  });

  it("normalizes missing accessibility options to null", async () => {
    mockGet.mockResolvedValue({
      data: {
        id: "ChIJ123",
        displayName: { text: "台北101" },
        location: { latitude: 25.03, longitude: 121.56 },
      },
    });

    const details = await getPlaceDetails("ChIJ123");

    expect(details).toMatchObject({
      wheelchair: null,
      wheelchairPartial: false,
      wheelchairAccessibleEntrance: null,
      wheelchairAccessibleRestroom: null,
    });
  });

  it("marks a restroom-only place as partially wheelchair accessible", async () => {
    mockGet.mockResolvedValue({
      data: {
        id: "ChIJ124",
        displayName: { text: "無障礙廁所站" },
        location: { latitude: 25.03, longitude: 121.56 },
        accessibilityOptions: { wheelchairAccessibleRestroom: true },
      },
    });

    const details = await getPlaceDetails("ChIJ124");

    expect(details).toMatchObject({
      wheelchair: null,
      wheelchairAccessibleEntrance: null,
      wheelchairAccessibleRestroom: true,
      wheelchairPartial: true,
    });
  });

  it("keeps wheelchairPartial when restroom combines with parking or seating and no entrance", async () => {
    mockGet.mockResolvedValue({
      data: {
        id: "ChIJ125",
        displayName: { text: "複合商場" },
        location: { latitude: 25.03, longitude: 121.56 },
        accessibilityOptions: {
          wheelchairAccessibleRestroom: true,
          wheelchairAccessibleParking: true,
          wheelchairAccessibleSeating: true,
        },
      },
    });

    const details = await getPlaceDetails("ChIJ125");

    expect(details).toMatchObject({
      wheelchair: null,
      wheelchairAccessibleEntrance: null,
      wheelchairAccessibleRestroom: true,
      wheelchairPartial: true,
    });
  });
});
