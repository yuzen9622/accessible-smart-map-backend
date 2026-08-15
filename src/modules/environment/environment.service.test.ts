import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../config/redis", () => ({
  redisGet: vi.fn(),
  redisSet: vi.fn(),
}));
vi.mock("../../adapters/cwa.adapter", () => ({
  fetchNearestWeather: vi.fn(),
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
import { fetchNearestWeather } from "../../adapters/cwa.adapter";
import { getAirData } from "../air/air.service";
import { getWeatherAndAirQuality } from "./environment.service";

beforeEach(() => {
  vi.resetAllMocks();
});

describe("getWeatherAndAirQuality", () => {
  it("returns {} and never throws when both upstreams fail", async () => {
    vi.mocked(redisGet).mockResolvedValue(null);
    vi.mocked(fetchNearestWeather).mockRejectedValue(new Error("weather down"));
    vi.mocked(getAirData).mockRejectedValue(new Error("air down"));

    await expect(getWeatherAndAirQuality(25.033, 121.565)).resolves.toEqual({});
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
