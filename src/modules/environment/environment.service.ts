/**
 * Degradation *policy* layer for the environment endpoint: cache-aside per
 * source, `Promise.allSettled` across the three sources, and mapping any rejected
 * source to a `status: "unavailable"` block carrying the normalized `reason`.
 * The *mechanism* (timeout/circuit/normalization) lives in `config/resilience.ts`.
 */
import { redisGet, redisSet } from "../../config/redis";
import {
  ResilienceError,
  UpstreamBadPayloadError,
  UpstreamHttpError,
  withResilience,
} from "../../config/resilience";
import { fetchNearestWeather } from "../../adapters/cwa.adapter";
import { fetchCamList } from "../../adapters/twipcam.adapter";
import { getAirData, classifyPm25 } from "../air/air.service";
import { parseCameras, parseWeather } from "./environment.parse";
import {
  DEFAULT_CCTV_LIMIT,
  ENV_CACHE_TTL_SEC,
  ENV_REASON,
  airCacheKey,
  weatherCacheKey,
} from "../../constants/environment";
import type {
  AirQualityBlock,
  CctvBlock,
  EnvironmentData,
  WeatherBlock,
} from "./environment.types";

function reasonOf(err: unknown): string {
  if (err instanceof ResilienceError) return err.reason;
  if (err instanceof UpstreamBadPayloadError)
    return ENV_REASON.UPSTREAM_BAD_PAYLOAD;
  if (err instanceof UpstreamHttpError) return ENV_REASON.UPSTREAM_HTTP_ERROR;
  return ENV_REASON.UPSTREAM_HTTP_ERROR;
}

function unavailable(err: unknown): { status: "unavailable"; reason: string } {
  return { status: "unavailable", reason: reasonOf(err) };
}

async function loadWeather(lat: number, lng: number): Promise<WeatherBlock> {
  const cacheKey = weatherCacheKey(lat, lng);
  const cached = await redisGet(cacheKey);
  if (cached) return JSON.parse(cached) as WeatherBlock;

  const raw = await fetchNearestWeather(lat, lng);
  const block: WeatherBlock = { status: "ok", ...parseWeather(raw) };
  await redisSet(cacheKey, JSON.stringify(block), ENV_CACHE_TTL_SEC.WEATHER);
  return block;
}

async function loadAirQuality(
  lat: number,
  lng: number,
): Promise<AirQualityBlock> {
  const cacheKey = airCacheKey(lat, lng);
  const cached = await redisGet(cacheKey);
  if (cached) return JSON.parse(cached) as AirQualityBlock;

  const airData = await withResilience("air", () => getAirData(lat, lng));
  if (!airData || !airData.readings.length) {
    return { status: "unavailable" };
  }

  const reading = airData.readings[0];
  const { quality, advice } = classifyPm25(reading.pm25);
  const block: AirQualityBlock = {
    status: "ok",
    pm25: reading.pm25,
    quality,
    advice,
    area: reading.area,
    stationCoordinates: reading.coordinates ?? null,
  };
  await redisSet(cacheKey, JSON.stringify(block), ENV_CACHE_TTL_SEC.AIR);
  return block;
}

async function loadNearbyCctv(
  lat: number,
  lng: number,
  radius: number,
): Promise<CctvBlock> {
  const cameras = await fetchCamList();
  return {
    status: "ok",
    cameras: parseCameras(cameras, lat, lng, radius, DEFAULT_CCTV_LIMIT),
  };
}

/**
 * Lightweight weather + air-quality lookup for consumers that need only the
 * conditions (e.g. route scoring's environment factor) — runs the same cached
 * weather/air branches as `getEnvironmentInfo` but skips the uncached CCTV
 * fetch. Never throws: any failed/unavailable source simply omits its field, so
 * the worst case is an empty object.
 *
 * @param lat Query latitude.
 * @param lng Query longitude.
 * @returns `{ precipitationProbability?, temperature?, airQuality? }` — only the
 *   fields that resolved successfully.
 */
export async function getWeatherAndAirQuality(
  lat: number,
  lng: number,
): Promise<{
  precipitationProbability?: number;
  temperature?: number;
  airQuality?: string;
}> {
  const [weather, airQuality] = await Promise.allSettled([
    loadWeather(lat, lng),
    loadAirQuality(lat, lng),
  ]);

  const result: {
    precipitationProbability?: number;
    temperature?: number;
    airQuality?: string;
  } = {};

  if (weather.status === "fulfilled" && weather.value.status === "ok") {
    result.temperature = weather.value.temperature;
    result.precipitationProbability = weather.value.precipitationProbability;
  }
  if (airQuality.status === "fulfilled" && airQuality.value.status === "ok") {
    result.airQuality = airQuality.value.quality;
  }

  return result;
}

/**
 * Aggregates weather, air quality and nearby CCTV for a coordinate. Each source
 * runs concurrently and degrades independently — a failing source yields an
 * `unavailable` block while the others still return their data.
 *
 * @param lat Query latitude.
 * @param lng Query longitude.
 * @param radius CCTV search radius in metres.
 * @returns The aggregated environment data with per-block status.
 */
export async function getEnvironmentInfo(
  lat: number,
  lng: number,
  radius: number,
): Promise<EnvironmentData> {
  const [weather, airQuality, nearbyCctv] = await Promise.allSettled([
    loadWeather(lat, lng),
    loadAirQuality(lat, lng),
    loadNearbyCctv(lat, lng, radius),
  ]);

  return {
    location: { lat, lng },
    weather:
      weather.status === "fulfilled"
        ? weather.value
        : unavailable(weather.reason),
    airQuality:
      airQuality.status === "fulfilled"
        ? airQuality.value
        : unavailable(airQuality.reason),
    nearbyCctv:
      nearbyCctv.status === "fulfilled"
        ? nearbyCctv.value
        : unavailable(nearbyCctv.reason),
  };
}
