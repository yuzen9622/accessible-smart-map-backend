import { decodeCsv } from "./taipei-aps.adapter";

/**
 * 衛生福利部社會及家庭署「全國身心障礙福利機構一覽表」(data.gov.tw 12061).
 * Served as a Big5 CSV.
 */

const MOHW_WELFARE_URL =
  "https://www.opendata.mohw.gov.tw/dataset/opendata/sfaa/12061/%E5%85%A8%E5%9C%8B%E8%BA%AB%E5%BF%83%E9%9A%9C%E7%A4%99%E7%A6%8F%E5%88%A9%E6%A9%9F%E6%A7%8B%E4%B8%80%E8%A6%BD%E8%A1%A8.csv";
const MOHW_WELFARE_TIMEOUT_MS = 30_000;

/**
 * Download the welfare institution CSV.
 *
 * @returns The CSV text.
 */
export async function fetchWelfareCsv(): Promise<string> {
  const res = await fetch(MOHW_WELFARE_URL, {
    signal: AbortSignal.timeout(MOHW_WELFARE_TIMEOUT_MS),
  });
  if (!res.ok)
    throw new Error(`MOHW welfare download failed: HTTP ${res.status}`);
  return decodeCsv(new Uint8Array(await res.arrayBuffer()));
}
