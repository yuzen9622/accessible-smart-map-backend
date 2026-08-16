import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../config/redis", () => ({
  redisGet: vi.fn(),
  redisSet: vi.fn(),
}));
vi.mock("../../adapters/cwa.adapter", () => ({
  fetchNearestWeather: vi.fn(),
  fetchNearestObservation: vi.fn(),
}));
vi.mock("../../adapters/twipcam.adapter", () => ({
  fetchCamList: vi.fn(),
}));
vi.mock("../air/air.service", () => ({
  getAirData: vi.fn(),
  classifyPm25: (pm25: number) => ({
    quality: pm25 > 55.4 ? "不健康" : "良好",
    advice: "",
  }),
}));

import { redisGet } from "../../config/redis";
import {
  fetchNearestObservation,
  fetchNearestWeather,
} from "../../adapters/cwa.adapter";
import { getAirData } from "../air/air.service";
import {
  getEnvironmentInfo,
  getWeatherAndAirQuality,
} from "./environment.service";
import type { CwaLocation, CwaObservationStation } from "./environment.types";

beforeEach(() => {
  vi.resetAllMocks();
});

const mockObservation: CwaObservationStation = {
  StationName: "臺北",
  StationId: "C0A980",
  ObsTime: { DateTime: "2026-08-16T15:00:00+08:00" },
  WeatherElement: {
    AirTemperature: "32.5",
    WindSpeed: "3.0",
    WindDirection: "90.0",
    Now: { Precipitation: "0.2" },
    Weather: "晴",
  },
};

const mockForecast: CwaLocation = {
  LocationName: "大安區",
  Latitude: "25.0260",
  Longitude: "121.5417",
  WeatherElement: [
    {
      ElementName: "溫度",
      Time: [
        {
          DataTime: "2026-08-16T15:00:00+08:00",
          ElementValue: [{ Temperature: "30" }],
        },
      ],
    },
    {
      ElementName: "3小時降雨機率",
      Time: [
        {
          StartTime: "2026-08-16T15:00:00+08:00",
          ElementValue: [{ ProbabilityOfPrecipitation: "40" }],
        },
      ],
    },
  ],
};

describe("getWeatherAndAirQuality", () => {
  it("returns {} and never throws when both upstreams fail", async () => {
    vi.mocked(redisGet).mockResolvedValue(null);
    vi.mocked(fetchNearestObservation).mockRejectedValue(new Error("obs down"));
    vi.mocked(fetchNearestWeather).mockRejectedValue(new Error("weather down"));
    vi.mocked(getAirData).mockRejectedValue(new Error("air down"));

    await expect(getWeatherAndAirQuality(25.033, 121.565)).resolves.toEqual({});
  });

  it("combines realtime temperature from observation with forecast rain probability", async () => {
    vi.mocked(redisGet).mockResolvedValue(null);
    vi.mocked(fetchNearestObservation).mockResolvedValue(mockObservation);
    vi.mocked(fetchNearestWeather).mockResolvedValue(mockForecast);
    vi.mocked(getAirData).mockResolvedValue({
      readings: [{ pm25: 15, area: "北部", coordinates: [25, 121] }],
    } as any);

    const res = await getWeatherAndAirQuality(25.033, 121.565);
    expect(res.temperature).toBe(32.5); // From observation (32.5) over forecast (30)
    expect(res.precipitationProbability).toBe(40); // From forecast
    expect(res.airQuality).toBe("良好");
  });

  it("maps a cached ok weather block and omits a failed air source", async () => {
    // weather served from cache (bypasses the adapter); air source fails
    vi.mocked(redisGet).mockImplementation(async (key: string) =>
      key.includes("air")
        ? null
        : JSON.stringify({
            status: "ok",
            temperature: 30,
            precipitationProbability: 60,
          }),
    );
    vi.mocked(getAirData).mockRejectedValue(new Error("air down"));

    const res = await getWeatherAndAirQuality(25.033, 121.565);
    expect(res.temperature).toBe(30);
    expect(res.precipitationProbability).toBe(60);
    expect(res.airQuality).toBeUndefined();
  });
});

describe("getEnvironmentInfo dual-track resilience", () => {
  it("merges observation and forecast when both succeed", async () => {
    vi.mocked(redisGet).mockResolvedValue(null);
    vi.mocked(fetchNearestObservation).mockResolvedValue(mockObservation);
    vi.mocked(fetchNearestWeather).mockResolvedValue(mockForecast);
    vi.mocked(getAirData).mockResolvedValue({ readings: [] } as any);

    const info = await getEnvironmentInfo(25.033, 121.565, 500);
    expect(info.weather.status).toBe("ok");
    expect(info.weather.temperature).toBe(32.5);
    expect(info.weather.precipitationProbability).toBe(40);
    expect(info.weather.windSpeed).toBe(3.0);
    expect(info.weather.windDirection).toBe("東風");
    expect(info.weather.condition).toBe("晴");
    expect(info.weather.rainfall).toBe(0.2);
    expect(info.weather.stationName).toBe("臺北");
  });

  it("gracefully falls back to forecast if observation fails", async () => {
    vi.mocked(redisGet).mockResolvedValue(null);
    vi.mocked(fetchNearestObservation).mockRejectedValue(
      new Error("obs timeout"),
    );
    vi.mocked(fetchNearestWeather).mockResolvedValue(mockForecast);
    vi.mocked(getAirData).mockResolvedValue({ readings: [] } as any);

    const info = await getEnvironmentInfo(25.033, 121.565, 500);
    expect(info.weather.status).toBe("ok");
    expect(info.weather.temperature).toBe(30); // from forecast
    expect(info.weather.precipitationProbability).toBe(40);
    expect(info.weather.rainfall).toBeUndefined();
  });

  it("gracefully uses observation if forecast fails", async () => {
    vi.mocked(redisGet).mockResolvedValue(null);
    vi.mocked(fetchNearestObservation).mockResolvedValue(mockObservation);
    vi.mocked(fetchNearestWeather).mockRejectedValue(
      new Error("forecast timeout"),
    );
    vi.mocked(getAirData).mockResolvedValue({ readings: [] } as any);

    const info = await getEnvironmentInfo(25.033, 121.565, 500);
    expect(info.weather.status).toBe("ok");
    expect(info.weather.temperature).toBe(32.5);
    expect(info.weather.precipitationProbability).toBeUndefined();
    expect(info.weather.rainfall).toBe(0.2);
    expect(info.weather.condition).toBe("晴");
  });

  it("returns unavailable when both observation and forecast fail", async () => {
    vi.mocked(redisGet).mockResolvedValue(null);
    vi.mocked(fetchNearestObservation).mockRejectedValue(new Error("obs down"));
    vi.mocked(fetchNearestWeather).mockRejectedValue(
      new Error("forecast down"),
    );
    vi.mocked(getAirData).mockResolvedValue({ readings: [] } as any);

    const info = await getEnvironmentInfo(25.033, 121.565, 500);
    expect(info.weather.status).toBe("unavailable");
  });
});
