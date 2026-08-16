import { describe, it, expect } from "vitest";
import {
  degreesToCardinal,
  mergeWeather,
  parseCameras,
  parseObservation,
  parseWeather,
} from "./environment.parse";
import type {
  CwaLocation,
  CwaObservationStation,
  RawCamera,
} from "./environment.types";

function makeLocation(overrides: Partial<CwaLocation> = {}): CwaLocation {
  return {
    LocationName: "大安區",
    Latitude: "25.0260",
    Longitude: "121.5417",
    WeatherElement: [
      {
        ElementName: "溫度",
        Time: [
          {
            DataTime: "2026-06-20T10:00:00+08:00",
            ElementValue: [{ Temperature: "31" }],
          },
        ],
      },
      {
        ElementName: "3小時降雨機率",
        Time: [
          {
            StartTime: "2026-06-20T09:00:00+08:00",
            EndTime: "2026-06-20T12:00:00+08:00",
            ElementValue: [{ ProbabilityOfPrecipitation: "20" }],
          },
        ],
      },
      {
        ElementName: "風速",
        Time: [
          {
            DataTime: "2026-06-20T10:00:00+08:00",
            ElementValue: [{ WindSpeed: "3" }],
          },
        ],
      },
      {
        ElementName: "風向",
        Time: [
          {
            DataTime: "2026-06-20T10:00:00+08:00",
            ElementValue: [{ WindDirection: "南風" }],
          },
        ],
      },
      {
        ElementName: "天氣現象",
        Time: [
          {
            StartTime: "2026-06-20T09:00:00+08:00",
            EndTime: "2026-06-20T12:00:00+08:00",
            ElementValue: [{ Weather: "多雲時晴" }],
          },
        ],
      },
    ],
    ...overrides,
  };
}

describe("parseWeather", () => {
  it("maps CWA elements to typed weather fields", () => {
    const result = parseWeather(makeLocation());
    expect(result).toEqual({
      temperature: 31,
      precipitationProbability: 20,
      windSpeed: 3,
      windDirection: "南風",
      condition: "多雲時晴",
      forecastTime: "2026-06-20T10:00:00+08:00",
    });
  });

  it("leaves non-numeric or missing values undefined", () => {
    const loc = makeLocation({
      WeatherElement: [
        {
          ElementName: "3小時降雨機率",
          Time: [
            {
              StartTime: "2026-06-20T09:00:00+08:00",
              ElementValue: [{ ProbabilityOfPrecipitation: "-" }],
            },
          ],
        },
      ],
    });
    const result = parseWeather(loc);
    expect(result.precipitationProbability).toBeUndefined();
    expect(result.temperature).toBeUndefined();
    expect(result.forecastTime).toBe("2026-06-20T09:00:00+08:00");
  });
});

describe("degreesToCardinal", () => {
  it("converts degrees to 16-point cardinal Chinese direction", () => {
    expect(degreesToCardinal(0)).toBe("北風");
    expect(degreesToCardinal(360)).toBe("北風");
    expect(degreesToCardinal(45)).toBe("東北風");
    expect(degreesToCardinal(90)).toBe("東風");
    expect(degreesToCardinal(180)).toBe("南風");
    expect(degreesToCardinal(225)).toBe("西南風");
    expect(degreesToCardinal(270)).toBe("西風");
    expect(degreesToCardinal(315)).toBe("西北風");
    expect(degreesToCardinal(22.5)).toBe("北北東風");
  });

  it("returns empty string for invalid degree values", () => {
    expect(degreesToCardinal(-1)).toBe("");
    expect(degreesToCardinal(Number.NaN)).toBe("");
  });
});

describe("parseObservation", () => {
  function makeStation(
    overrides: Partial<CwaObservationStation> = {},
  ): CwaObservationStation {
    return {
      StationName: "臺北觀測站",
      StationId: "C0A980",
      ObsTime: { DateTime: "2026-08-16T15:00:00+08:00" },
      GeoInfo: {
        Coordinates: [
          {
            CoordinateName: "WGS84",
            StationLatitude: "25.037",
            StationLongitude: "121.514",
          },
        ],
      },
      WeatherElement: {
        AirTemperature: "32.5",
        WindSpeed: "2.1",
        WindDirection: "45.0",
        Now: { Precipitation: "1.5" },
        Weather: "多雲",
      },
      ...overrides,
    };
  }

  it("maps valid observation elements correctly", () => {
    const parsed = parseObservation(makeStation());
    expect(parsed).toEqual({
      temperature: 32.5,
      windSpeed: 2.1,
      windDirection: "東北風",
      condition: "多雲",
      rainfall: 1.5,
      observationTime: "2026-08-16T15:00:00+08:00",
      stationName: "臺北觀測站",
    });
  });

  it("handles -99 sentinel values by leaving fields undefined", () => {
    const parsed = parseObservation(
      makeStation({
        WeatherElement: {
          AirTemperature: "-99",
          WindSpeed: "-99",
          WindDirection: "-99",
          Now: { Precipitation: "-99" },
          Weather: "-99",
        },
      }),
    );
    expect(parsed.temperature).toBeUndefined();
    expect(parsed.windSpeed).toBeUndefined();
    expect(parsed.windDirection).toBeUndefined();
    expect(parsed.condition).toBeUndefined();
    expect(parsed.rainfall).toBeUndefined();
    expect(parsed.stationName).toBe("臺北觀測站");
  });

  it("maps zero wind speed to 靜風", () => {
    const parsed = parseObservation(
      makeStation({
        WeatherElement: {
          AirTemperature: "28.0",
          WindSpeed: "0.0",
          WindDirection: "0.0",
          Now: { Precipitation: "0.0" },
        },
      }),
    );
    expect(parsed.windSpeed).toBe(0);
    expect(parsed.windDirection).toBe("靜風");
  });
});

describe("mergeWeather", () => {
  it("prioritizes observation for realtime fields while keeping forecast rain probability", () => {
    const obs = {
      temperature: 33,
      windSpeed: 4,
      windDirection: "北風",
      condition: "晴",
      rainfall: 0,
      observationTime: "2026-08-16T15:00:00+08:00",
      stationName: "臺北",
    };
    const forecast = {
      temperature: 30,
      precipitationProbability: 30,
      windSpeed: 2,
      windDirection: "東南風",
      condition: "多雲",
      forecastTime: "2026-08-16T15:00:00+08:00",
    };

    const merged = mergeWeather(obs, forecast);
    expect(merged).toEqual({
      temperature: 33,
      precipitationProbability: 30,
      windSpeed: 4,
      windDirection: "北風",
      condition: "晴",
      rainfall: 0,
      forecastTime: "2026-08-16T15:00:00+08:00",
      observationTime: "2026-08-16T15:00:00+08:00",
      stationName: "臺北",
    });
  });

  it("falls back to forecast when observation fields are missing", () => {
    const obs = {
      rainfall: 0.5,
      observationTime: "2026-08-16T15:00:00+08:00",
    };
    const forecast = {
      temperature: 29,
      precipitationProbability: 80,
      windSpeed: 5,
      windDirection: "東北風",
      condition: "陰短暫雨",
      forecastTime: "2026-08-16T15:00:00+08:00",
    };

    const merged = mergeWeather(obs, forecast);
    expect(merged).toEqual({
      temperature: 29,
      precipitationProbability: 80,
      windSpeed: 5,
      windDirection: "東北風",
      condition: "陰短暫雨",
      rainfall: 0.5,
      forecastTime: "2026-08-16T15:00:00+08:00",
      observationTime: "2026-08-16T15:00:00+08:00",
      stationName: undefined,
    });
  });
});

describe("parseCameras", () => {
  const cameras: RawCamera[] = [
    {
      id: "tpe-near",
      name: "近的",
      lat: 25.048,
      lon: 121.532,
      cam_url: "https://cctv/near.mjpg",
    },
    { id: "tpe-mid", name: "中等", lat: 25.052, lon: 121.536 },
    {
      id: "tpe-far",
      name: "遠的",
      lat: 25.2,
      lon: 121.7,
      cam_url: "https://cctv/far.mjpg",
    },
  ];

  it("filters by radius, sorts by distance, derives snapshot/stream URLs", () => {
    const result = parseCameras(cameras, 25.0478, 121.5318, 1000, 5);
    expect(result.map((c) => c.id)).toEqual(["tpe-near", "tpe-mid"]);
    expect(result[0]).toMatchObject({
      id: "tpe-near",
      location: { lat: 25.048, lng: 121.532 },
      snapshotUrl: "https://c01.twipcam.com/cam/snapshot/tpe-near.jpg",
      streamUrl: "https://cctv/near.mjpg",
    });
    expect(result[0].distanceM).toBeLessThan(result[1].distanceM);
    expect(result[1].streamUrl).toBeNull();
  });

  it("caps results at the limit", () => {
    expect(parseCameras(cameras, 25.0478, 121.5318, 50000, 1)).toHaveLength(1);
  });

  it("returns an empty array when nothing is within radius", () => {
    expect(parseCameras(cameras, 25.0478, 121.5318, 10, 5)).toEqual([]);
  });

  it("skips cameras with invalid coordinates", () => {
    const bad: RawCamera[] = [{ id: "bad", name: "壞", lat: NaN, lon: 121.5 }];
    expect(parseCameras(bad, 25.0478, 121.5318, 1000, 5)).toEqual([]);
  });
});
