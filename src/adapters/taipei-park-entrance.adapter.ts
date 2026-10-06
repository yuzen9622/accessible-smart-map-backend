/**
 * 臺北市政府工務局公園處「臺北市公園無障礙出入口點位」(data.taipei
 * 5a7258c2-5ded-4149-8664-ae10903fe372). A CSV
 * (ID,行政區,公園名稱,無障礙出入口名稱,TW97座標X,TW97座標Y,人行道寬度,坡度)
 * currently served as Big5.
 */

import { decodeCsv } from "./taipei-aps.adapter";

const TAIPEI_PARK_ENTRANCE_URL =
  "https://data.taipei/api/dataset/5a7258c2-5ded-4149-8664-ae10903fe372/resource/70defec1-fd51-471b-89fa-5c7636150e6a/download";
const TAIPEI_PARK_ENTRANCE_TIMEOUT_MS = 30_000;

/**
 * Download the park accessible-entrance CSV.
 *
 * @returns The CSV text.
 */
export async function fetchTaipeiParkEntranceCsv(): Promise<string> {
  const res = await fetch(TAIPEI_PARK_ENTRANCE_URL, {
    signal: AbortSignal.timeout(TAIPEI_PARK_ENTRANCE_TIMEOUT_MS),
  });
  if (!res.ok)
    throw new Error(`Taipei park entrance download failed: HTTP ${res.status}`);
  return decodeCsv(new Uint8Array(await res.arrayBuffer()));
}
