import type { STAApiResponse, AIResponse } from "../../types/air";
import type { AirReading, AirData } from "./air.types";
import { getCityZh } from "../../adapters/google.adapter";
import { googleGenAi, model } from "../../config/ai";
import { airConfig } from "../../config/ai/config";
import { airContents } from "../../config/ai/contents";
import { odataUrlLiteral } from "../../utils/transit-text";

export type { AirReading, AirData };

export async function getAirData(lat: number, lng: number): Promise<AirData | null> {
  const city = await getCityZh(lat, lng);

  const staUrl =
    `https://sta.ci.taiwan.gov.tw/STA_AirQuality_EPAIoT/v1.0/Datastreams` +
    `?$expand=Thing,Observations($orderby=phenomenonTime desc;$top=1)` +
    `&$filter=name eq 'PM2.5' and Thing/properties/city eq '${odataUrlLiteral(city)}'`;

  const staRes = await fetch(staUrl);
  const staData = (await staRes.json()) as STAApiResponse;

  const readings: AirReading[] = staData.value
    .map((item) => ({
      area: item.Thing?.properties?.area ?? item.Thing?.properties?.areaDescription ?? null,
      pm25: item.Observations?.[0]?.result ?? null,
      coordinates: item.observedArea?.coordinates,
      city: item.Thing?.properties?.city ?? null,
    }))
    .filter((v): v is AirReading => v.pm25 !== null);

  if (!readings.length) return null;

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
