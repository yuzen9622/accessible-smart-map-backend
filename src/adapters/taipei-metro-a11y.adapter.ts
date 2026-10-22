import { decodeCsv } from "./taipei-aps.adapter";

/**
 * 臺北市資料大平臺「臺北捷運車站出入口無障礙電梯、無障礙坡道GPS座標」
 *   dataset https://data.taipei/dataset/detail?id=0a3bb422-9eb5-459b-a9d4-138456516183
 * Served as a Big5 CSV.
 */

const TAIPEI_METRO_A11Y_URL =
  "https://data.taipei/api/frontstage/tpeod/dataset/resource.download?rid=61792c82-6609-41b2-9775-3a346934826d";
const TAIPEI_METRO_A11Y_TIMEOUT_MS = 30_000;

/**
 * Download the metro exit accessibility CSV.
 *
 * @returns The CSV text.
 */
export async function fetchMetroA11yCsv(): Promise<string> {
  const res = await fetch(TAIPEI_METRO_A11Y_URL, {
    signal: AbortSignal.timeout(TAIPEI_METRO_A11Y_TIMEOUT_MS),
  });
  if (!res.ok)
    throw new Error(`Taipei metro a11y download failed: HTTP ${res.status}`);
  return decodeCsv(new Uint8Array(await res.arrayBuffer()));
}
