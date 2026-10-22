import type { IA11y } from "../types";

/**
 * Parse helpers for the Taipei Metro exit accessibility CSV
 * (臺北捷運車站出入口無障礙電梯、無障礙坡道GPS座標).
 *
 * Source and download: taipei-metro-a11y.adapter.ts
 * (headers: 項次,出入口電梯/無障礙坡道名稱,出入口編號,經度,緯度).
 */

const TW_BOUNDS = { lngMin: 119, lngMax: 122.5, latMin: 21.5, latMax: 26.5 };

/** Upstream coordinates are written with 7 decimals. */
const COORD_DECIMALS = 1e7;

/**
 * Parse one coordinate. Upstream occasionally drops the decimal point
 * (圓山站出口無障礙坡道2 緯度 `250717908` = 25.0717908); a bare integer that
 * lands in range once divided by 10^7 is read that way.
 */
function parseCoord(raw: string, min: number, max: number): number {
  const value = parseFloat(raw);
  if (/^\d+$/.test(raw.trim()) && (value < min || value > max)) {
    const repaired = value / COORD_DECIMALS;
    if (repaired >= min && repaired <= max) return repaired;
  }
  return value;
}

/**
 * Map one parsed CSV row (項次, 名稱, 出入口編號, 經度, 緯度) to an
 * Accessibility document. Rows with a missing name or non-finite /
 * out-of-Taiwan coordinates are skipped (return null).
 */
export function rowToMetroA11yDoc(fields: string[]): Omit<IA11y, "_id"> | null {
  const [serial, name, , lngStr, latStr] = fields;
  if (!name || !serial || lngStr === undefined || latStr === undefined)
    return null;
  const lng = parseCoord(lngStr, TW_BOUNDS.lngMin, TW_BOUNDS.lngMax);
  const lat = parseCoord(latStr, TW_BOUNDS.latMin, TW_BOUNDS.latMax);
  if (!Number.isFinite(lng) || !Number.isFinite(lat)) return null;
  if (
    lng < TW_BOUNDS.lngMin ||
    lng > TW_BOUNDS.lngMax ||
    lat < TW_BOUNDS.latMin ||
    lat > TW_BOUNDS.latMax
  ) {
    return null;
  }
  return {
    項次: serial,
    "出入口電梯/無障礙坡道名稱": name,
    經度: lng,
    緯度: lat,
    location: { type: "Point", coordinates: [lng, lat] },
  };
}
