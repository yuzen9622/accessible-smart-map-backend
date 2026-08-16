import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../config/redis", () => ({
  redisGet: vi.fn(),
  redisSet: vi.fn(),
}));

import { redisGet, redisSet } from "../config/redis";
import {
  fetchNearestObservation,
  fetchNearestWeather,
  nearestObservation,
} from "./cwa.adapter";
import type {
  CwaLocation,
  CwaObservationStation,
} from "../modules/environment/environment.types";

const mockFetch = vi.fn();
global.fetch = mockFetch;

beforeEach(() => {
  vi.clearAllMocks();
  process.env.CWA_API_KEY = "test-cwa-key";
});

describe("nearestObservation", () => {
  const stations: CwaObservationStation[] = [
    {
      StationName: "遠站",
      StationId: "FAR",
      GeoInfo: {
        Coordinates: [
          {
            CoordinateName: "WGS84",
            StationLatitude: "24.0",
            StationLongitude: "120.0",
          },
        ],
      },
    },
    {
      StationName: "近站",
      StationId: "NEAR",
      GeoInfo: {
        Coordinates: [
          {
            CoordinateName: "WGS84",
            StationLatitude: "25.04",
            StationLongitude: "121.53",
          },
        ],
      },
    },
  ];

  it("finds the station closest to the target coordinates", () => {
    const best = nearestObservation(stations, 25.0478, 121.5318);
    expect(best.StationId).toBe("NEAR");
  });

  it("throws when no valid stations with coordinates exist", () => {
    expect(() =>
      nearestObservation(
        [
          {
            StationName: "無座標",
            StationId: "NO_COORD",
          },
        ],
        25.0478,
        121.5318,
      ),
    ).toThrow("no stations with valid coordinates");
  });
});

describe("fetchNearestObservation", () => {
  it("uses cached raw stations list if present in Redis", async () => {
    const cachedStations: CwaObservationStation[] = [
      {
        StationName: "快取站",
        StationId: "CACHED1",
        GeoInfo: {
          Coordinates: [
            {
              CoordinateName: "WGS84",
              StationLatitude: "25.0",
              StationLongitude: "121.5",
            },
          ],
        },
      },
    ];
    vi.mocked(redisGet).mockResolvedValue(JSON.stringify(cachedStations));

    const station = await fetchNearestObservation(25.0, 121.5);
    expect(station.StationId).toBe("CACHED1");
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("fetches from CWA API and caches when Redis is empty", async () => {
    vi.mocked(redisGet).mockResolvedValue(null);
    const apiStations: CwaObservationStation[] = [
      {
        StationName: "API站",
        StationId: "API1",
        GeoInfo: {
          Coordinates: [
            {
              CoordinateName: "WGS84",
              StationLatitude: "25.0",
              StationLongitude: "121.5",
            },
          ],
        },
      },
    ];
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ records: { Station: apiStations } }),
    });

    const station = await fetchNearestObservation(25.0, 121.5);
    expect(station.StationId).toBe("API1");
    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining("O-A0001-001"),
      expect.any(Object),
    );
    expect(redisSet).toHaveBeenCalledWith(
      "env:cwa:raw:O-A0001-001",
      expect.any(String),
      expect.any(Number),
    );
  });
});

describe("fetchNearestWeather", () => {
  it("performs two-stage lookup: county then township", async () => {
    vi.mocked(redisGet).mockResolvedValue(null);

    const countyList: CwaLocation[] = [
      {
        LocationName: "臺北市",
        Latitude: "25.037",
        Longitude: "121.563",
        WeatherElement: [],
      },
    ];

    const townshipList: CwaLocation[] = [
      {
        LocationName: "大安區",
        Latitude: "25.026",
        Longitude: "121.541",
        WeatherElement: [],
      },
    ];

    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          records: { Locations: [{ Location: countyList }] },
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          records: { Locations: [{ Location: townshipList }] },
        }),
      });

    const loc = await fetchNearestWeather(25.03, 121.54);
    expect(loc.LocationName).toBe("大安區");
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });
});
