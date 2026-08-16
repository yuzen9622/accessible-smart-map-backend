/**
 * Pure transforms from raw upstream payloads to the environment response shapes.
 * No I/O, no HTTP, no degradation policy — adapters supply raw data, these
 * functions normalize it.
 */
import { haversineMeters } from "../../utils/geo";
import {
  CWA_WEATHER_ELEMENTS,
  TWIPCAM_SNAPSHOT_BASE_URL,
} from "../../constants/environment";
import type {
  CctvCamera,
  CwaLocation,
  CwaObservationStation,
  RawCamera,
  WeatherBlock,
} from "./environment.types";

export type ParsedWeather = Omit<WeatherBlock, "status" | "reason">;

export interface ParsedObservation {
  temperature?: number;
  windSpeed?: number;
  windDirection?: string;
  condition?: string;
  rainfall?: number;
  observationTime?: string;
  stationName?: string;
}

function firstValue(
  loc: CwaLocation,
  elementName: string,
  key: string,
): string | undefined {
  const element = loc.WeatherElement?.find(
    (e) => e.ElementName === elementName,
  );
  return element?.Time?.[0]?.ElementValue?.[0]?.[key];
}

function numberField(
  loc: CwaLocation,
  elementName: string,
  key: string,
): number | undefined {
  const raw = firstValue(loc, elementName, key);
  if (raw === undefined) return undefined;
  const value = Number(raw);
  return Number.isFinite(value) ? value : undefined;
}

function stringField(
  loc: CwaLocation,
  elementName: string,
  key: string,
): string | undefined {
  const raw = firstValue(loc, elementName, key);
  return raw && raw.trim() ? raw : undefined;
}

function firstForecastTime(loc: CwaLocation): string | undefined {
  for (const name of CWA_WEATHER_ELEMENTS) {
    const time = loc.WeatherElement?.find((e) => e.ElementName === name)
      ?.Time?.[0];
    if (time) return time.DataTime ?? time.StartTime;
  }
  return undefined;
}

/**
 * Maps a raw CWA `Location` to the weather block fields per the element table.
 * Missing or non-numeric values are left undefined rather than throwing.
 *
 * @param loc The nearest township `Location` from the CWA adapter.
 * @returns The normalized weather fields (without `status`).
 */
export function parseWeather(loc: CwaLocation): ParsedWeather {
  return {
    temperature: numberField(loc, "溫度", "Temperature"),
    precipitationProbability: numberField(
      loc,
      "3小時降雨機率",
      "ProbabilityOfPrecipitation",
    ),
    windSpeed: numberField(loc, "風速", "WindSpeed"),
    windDirection: stringField(loc, "風向", "WindDirection"),
    condition: stringField(loc, "天氣現象", "Weather"),
    forecastTime: firstForecastTime(loc),
  };
}

/**
 * Converts wind direction degrees (0–360) to 16-point cardinal Chinese direction.
 *
 * @param deg Wind direction in degrees.
 * @returns Wind direction in Chinese (e.g. 北風, 東北風).
 */
export function degreesToCardinal(deg: number): string {
  if (!Number.isFinite(deg) || deg < 0) return "";
  const directions = [
    "北風",
    "北北東風",
    "東北風",
    "東北東風",
    "東風",
    "東南東風",
    "東南風",
    "南南東風",
    "南風",
    "南南西風",
    "西南風",
    "西南西風",
    "西風",
    "西北西風",
    "西北風",
    "北北西風",
  ];
  const index = Math.round((deg % 360) / 22.5) % 16;
  return directions[index];
}

function parseNumericElement(raw?: string): number | undefined {
  if (!raw || raw === "-99") return undefined;
  const num = Number(raw);
  return Number.isFinite(num) ? num : undefined;
}

function resolveWindDirection(
  speed?: number,
  degRaw?: string,
): string | undefined {
  if (speed === 0) return "靜風";
  const deg = parseNumericElement(degRaw);
  return deg !== undefined ? degreesToCardinal(deg) : undefined;
}

/**
 * Normalizes raw automatic weather station observation (O-A0001-001) to parsed
 * observation fields. -99 sentinel values are treated as missing/undefined.
 *
 * @param station The nearest observation station payload.
 * @returns The parsed real-time observation fields.
 */
export function parseObservation(
  station: CwaObservationStation,
): ParsedObservation {
  const we = station.WeatherElement;
  const windSpeed = parseNumericElement(we?.WindSpeed);
  const condition =
    we?.Weather && we.Weather !== "-99" && we.Weather.trim()
      ? we.Weather.trim()
      : undefined;

  return {
    temperature: parseNumericElement(we?.AirTemperature),
    windSpeed,
    windDirection: resolveWindDirection(windSpeed, we?.WindDirection),
    condition,
    rainfall: parseNumericElement(we?.Now?.Precipitation),
    observationTime: station.ObsTime?.DateTime,
    stationName: station.StationName || undefined,
  };
}

/**
 * Merges real-time observation and township forecast into a single hybrid weather block.
 * Real-time observation takes priority for temperature, wind, condition, and rainfall,
 * while forecast supplies precipitation probability and forecast time.
 *
 * @param obs Parsed observation fields (if available).
 * @param forecast Parsed forecast fields (if available).
 * @returns Merged weather fields.
 */
export function mergeWeather(
  obs?: ParsedObservation,
  forecast?: ParsedWeather,
): ParsedWeather {
  return {
    temperature: obs?.temperature ?? forecast?.temperature,
    precipitationProbability: forecast?.precipitationProbability,
    windSpeed: obs?.windSpeed ?? forecast?.windSpeed,
    windDirection: obs?.windDirection ?? forecast?.windDirection,
    condition: obs?.condition ?? forecast?.condition,
    rainfall: obs?.rainfall,
    forecastTime: forecast?.forecastTime,
    observationTime: obs?.observationTime,
    stationName: obs?.stationName,
  };
}

/**
 * Filters the nationwide camera list to those within `radius` of the query
 * point, sorted by ascending distance and capped at `limit`.
 *
 * @param cameras The raw twipcam list.
 * @param lat Query latitude.
 * @param lng Query longitude.
 * @param radius Search radius in metres.
 * @param limit Maximum number of cameras to return.
 * @returns The nearest cameras with computed distance and derived snapshot URL.
 */
export function parseCameras(
  cameras: RawCamera[],
  lat: number,
  lng: number,
  radius: number,
  limit: number,
): CctvCamera[] {
  return cameras
    .filter((cam) => Number.isFinite(cam.lat) && Number.isFinite(cam.lon))
    .map((cam) => ({
      cam,
      distanceM: Math.round(haversineMeters(lat, lng, cam.lat, cam.lon)),
    }))
    .filter(({ distanceM }) => distanceM <= radius)
    .sort((a, b) => a.distanceM - b.distanceM)
    .slice(0, limit)
    .map(({ cam, distanceM }) => ({
      id: cam.id,
      name: cam.name,
      location: { lat: cam.lat, lng: cam.lon },
      distanceM,
      snapshotUrl: cam.id ? `${TWIPCAM_SNAPSHOT_BASE_URL}/${cam.id}.jpg` : null,
      streamUrl: cam.cam_url ?? null,
    }));
}
