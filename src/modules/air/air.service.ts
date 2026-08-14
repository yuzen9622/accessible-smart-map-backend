import type { MOENVAirQualityRecord, AIResponse } from "../../types/air";
import type { AirReading, AirData } from "./air.types";
import { googleGenAi, model } from "../../config/ai";
import { airConfig } from "../../config/ai/config";
import { airContents } from "../../config/ai/contents";

export type { AirReading, AirData };

const MOENV_AIR_QUALITY_URL = "https://data.moenv.gov.tw/api/v2/aqx_p_432";
const AIR_DATA_CACHE_TTL_MS = 10 * 60 * 1000;
const EARTH_RADIUS_METERS = 6_371_000;

let airDataCache: { records: MOENVAirQualityRecord[]; expiresAt: number } | null = null;

function isMOENVAirQualityRecord(value: unknown): value is MOENVAirQualityRecord {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return typeof record.sitename === "string" && typeof record.county === "string";
}

function parseNumber(value: unknown): number | undefined {
  if (typeof value !== "string" || !value.trim()) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function haversineDistanceMeters(
  lat1: number,
  lng1: number,
  lat2: number,
  lng2: number,
): number {
  const latitudeDelta = ((lat2 - lat1) * Math.PI) / 180;
  const longitudeDelta = ((lng2 - lng1) * Math.PI) / 180;
  const a =
    Math.sin(latitudeDelta / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(longitudeDelta / 2) ** 2;
  return EARTH_RADIUS_METERS * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

async function getMOENVAirQualityRecords(): Promise<MOENVAirQualityRecord[] | null> {
  const apiKey = process.env.MOENV_API_KEY;
  if (!apiKey) return null;

  if (airDataCache && airDataCache.expiresAt > Date.now()) {
    return airDataCache.records;
  }

  try {
    const url = new URL(MOENV_AIR_QUALITY_URL);
    url.searchParams.set("api_key", apiKey);
    url.searchParams.set("limit", "1000");
    url.searchParams.set("format", "JSON");

    const response = await fetch(url, { signal: AbortSignal.timeout(5000) });
    if (!response.ok) return null;

    const data: unknown = await response.json();
    if (!Array.isArray(data)) return null;

    const records = data.filter(isMOENVAirQualityRecord);
    airDataCache = {
      records,
      expiresAt: Date.now() + AIR_DATA_CACHE_TTL_MS,
    };
    return records;
  } catch {
    return null;
  }
}

export async function getAirData(lat: number, lng: number): Promise<AirData | null> {
  const records = await getMOENVAirQualityRecords();
  if (!records) return null;

  const readings = records
    .map((record) => {
      const pm25 = parseNumber(record["pm2.5"]);
      if (pm25 === undefined) return null;

      const longitude = parseNumber(record.longitude);
      const latitude = parseNumber(record.latitude);
      const coordinates: [number, number] | undefined =
        longitude === undefined || latitude === undefined
          ? undefined
          : [longitude, latitude];
      const reading: AirReading = {
        area: record.sitename,
        pm25,
        coordinates,
        city: record.county,
      };

      return {
        reading,
        distance: coordinates
          ? haversineDistanceMeters(lat, lng, coordinates[1], coordinates[0])
          : Number.POSITIVE_INFINITY,
      };
    })
    .filter((value): value is { reading: AirReading; distance: number } => value !== null)
    .sort((a, b) => a.distance - b.distance)
    .slice(0, 5)
    .map(({ reading }) => reading);

  if (!readings.length) return null;

  const city = readings[0].city;
  if (!city) return null;

  return { city, readings };
}

export function classifyPm25(pm25: number): { quality: string; advice: string } {
  if (pm25 <= 12) return { quality: "良好", advice: "空氣品質良好，適合戶外活動" };
  if (pm25 <= 35.4) return { quality: "普通", advice: "空氣品質尚可，敏感族群可考慮減少長時間戶外活動" };
  if (pm25 <= 55.4) return { quality: "對敏感族群不健康", advice: "輪椅使用者及呼吸道敏感者建議配戴口罩，減少戶外停留時間" };
  if (pm25 <= 150.4) return { quality: "不健康", advice: "建議所有人減少戶外活動，出門配戴口罩" };
  return { quality: "非常不健康", advice: "強烈建議不要外出，若必須外出請配戴 N95 口罩" };
}

/**
 * Full air-quality lookup that fetches the nearest PM2.5 readings, then has
 * Gemini turn them into a user-facing description.
 *
 * @param lat Latitude of the location to assess.
 * @param lng Longitude of the location to assess.
 * @returns The AI air-quality response, or null when no sensor covers the area.
 */
export async function getAirQualityWithAI(
  lat: number,
  lng: number,
): Promise<AIResponse | null> {
  const airData = await getAirData(lat, lng);
  if (!airData) return null;

  const aiResponse = await googleGenAi.models.generateContent({
    model,
    contents: [
      ...airContents,
      {
        role: "user",
        parts: [
          {
            text: `感測器座標：${JSON.stringify(airData.readings[0])}\n路線位置：{lat: ${lat}, lng: ${lng}}`,
          },
        ],
      },
    ],
    config: airConfig,
  });

  const raw = aiResponse?.candidates?.[0].content?.parts?.[0].text ?? "";
  try {
    return JSON.parse(raw) as AIResponse;
  } catch {
    return {
      description: "此區域沒有空氣品質監測器喔!",
      quality: "",
    };
  }
}
