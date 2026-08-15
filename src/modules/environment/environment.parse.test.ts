import { describe, it, expect } from "vitest";
import { parseWeather, parseCameras } from "./environment.parse";
import type { CwaLocation, RawCamera } from "./environment.types";

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
