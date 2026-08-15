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
  RawCamera,
  WeatherBlock,
} from "./environment.types";

export type ParsedWeather = Omit<WeatherBlock, "status" | "reason">;

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
