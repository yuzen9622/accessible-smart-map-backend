import type { IA11y } from "../types";

/**
 * Parse helpers for the Taipei Metro exit accessibility CSV
 * (臺北捷運車站出入口無障礙電梯、無障礙坡道GPS座標).
 *
 * Source: 臺北市資料大平臺
 *   dataset https://data.taipei/dataset/detail?id=0a3bb422-9eb5-459b-a9d4-138456516183
 *   resource https://data.taipei/api/frontstage/tpeod/dataset/resource.download?rid=61792c82-6609-41b2-9775-3a346934826d
 *
 * The upstream CSV is Big5-encoded; the copy committed under data/metro-a11y/
 * is the UTF-8 conversion (headers: 項次,出入口電梯/無障礙坡道名稱,出入口編號,經度,緯度).
 * Data fix: row 圓山站出口無障礙坡道2 的緯度原始值 250717908 漏了小數點，
 * 已在資料檔修正為 25.0717908。
 */

const TW_BOUNDS = { lngMin: 119, lngMax: 122.5, latMin: 21.5, latMax: 26.5 };

/**
 * Map one parsed CSV row (項次, 名稱, 出入口編號, 經度, 緯度) to an
 * Accessibility document. Rows with a missing name or non-finite /
 * out-of-Taiwan coordinates are skipped (return null).
 */
export function rowToMetroA11yDoc(fields: string[]): Omit<IA11y, "_id"> | null {
  const [serial, name, , lngStr, latStr] = fields;
  const lng = parseFloat(lngStr);
  const lat = parseFloat(latStr);
  if (!name || !serial) return null;
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
