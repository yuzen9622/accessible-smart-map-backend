import { getCity } from "../../adapters/google.adapter";
import { getNlscAdministrativeArea } from "../../adapters/nlsc.adapter";
import type { TaiwanCityEn } from "../../types/transit";

/** Resolve administrative city using NLSC first, then Google; unknown cities remain null. */
export async function resolveCity(
  lat: number,
  lng: number,
): Promise<TaiwanCityEn | null> {
  const area = await getNlscAdministrativeArea(lat, lng);
  if (area) return area.city;
  console.info("[city] NLSC unavailable; falling back to Google");
  return getCity(lat, lng);
}
