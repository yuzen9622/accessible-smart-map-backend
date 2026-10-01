/**
 * 臺北市交通管制工程處「有聲號誌設置位置」(data.taipei / data.gov.tw 121423).
 * A CSV (項次,路口,行政區,號誌編號,WGS84經度座標,WGS84緯度座標) currently served as
 * Big5; decoded as UTF-8 when it is valid UTF-8, otherwise as Big5.
 */

const TAIPEI_APS_URL =
  "https://data.taipei/api/dataset/baf32b58-b194-448d-96a0-ba04013d164f/resource/1c18341c-9f6f-4b6b-b17f-8c66b94e39a0/download";
const TAIPEI_APS_TIMEOUT_MS = 30_000;

/**
 * Decode CSV bytes as UTF-8 when valid, otherwise as Big5.
 *
 * @param bytes The raw bytes.
 * @returns The decoded text.
 */
export function decodeCsv(bytes: Uint8Array): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return new TextDecoder("big5").decode(bytes);
  }
}

/**
 * Download the audible-signal CSV.
 *
 * @returns The CSV text.
 */
export async function fetchTaipeiApsCsv(): Promise<string> {
  const res = await fetch(TAIPEI_APS_URL, {
    signal: AbortSignal.timeout(TAIPEI_APS_TIMEOUT_MS),
  });
  if (!res.ok)
    throw new Error(`Taipei APS download failed: HTTP ${res.status}`);
  return decodeCsv(new Uint8Array(await res.arrayBuffer()));
}
