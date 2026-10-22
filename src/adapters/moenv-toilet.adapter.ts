/**
 * 環境部「全國公廁建檔資料」(data.moenv.gov.tw fac_p_07) — every registered
 * public toilet in Taiwan, paged at most 1000 rows per request. Only the
 * accessible ones are kept: typed 無障礙廁所, or another type whose name marks it
 * as an accessible stall (e.g. 「…男廁(無障礙廁所)」).
 */

const MOENV_TOILET_URL = "https://data.moenv.gov.tw/api/v2/fac_p_07";
const MOENV_PAGE_SIZE = 1000;
const MOENV_TOILET_TIMEOUT_MS = 60_000;

export const MOENV_TOILET_FIELDS = [
  "county",
  "areacode",
  "village",
  "number",
  "name",
  "address",
  "administration",
  "latitude",
  "longitude",
  "grade",
  "type2",
  "type",
  "exec",
  "diaper",
] as const;

export type MoenvToiletRow = Record<
  (typeof MOENV_TOILET_FIELDS)[number],
  string
>;

/** @returns Whether the toilet is an accessible one. */
export function isAccessibleToilet(row: MoenvToiletRow): boolean {
  return row.type === "無障礙廁所" || (row.name ?? "").includes("無障礙");
}

async function fetchPage(
  apiKey: string,
  offset: number,
): Promise<MoenvToiletRow[]> {
  const url = new URL(MOENV_TOILET_URL);
  url.search = new URLSearchParams({
    api_key: apiKey,
    format: "json",
    limit: String(MOENV_PAGE_SIZE),
    offset: String(offset),
  }).toString();
  const res = await fetch(url, {
    signal: AbortSignal.timeout(MOENV_TOILET_TIMEOUT_MS),
  });
  if (!res.ok)
    throw new Error(
      `MOENV toilet download failed at offset ${offset}: HTTP ${res.status}`,
    );
  const body: unknown = await res.json();
  if (!Array.isArray(body))
    throw new Error(
      `MOENV toilet download at offset ${offset} returned a non-array body`,
    );
  return body as MoenvToiletRow[];
}

/**
 * Download every page; a failed page aborts the whole download so a partial
 * list never replaces the stored snapshot.
 *
 * @param apiKey The MOENV open-data API key.
 * @returns The accessible toilets.
 */
export async function fetchAccessibleToilets(
  apiKey: string,
): Promise<MoenvToiletRow[]> {
  const rows: MoenvToiletRow[] = [];
  for (let offset = 0; ; offset += MOENV_PAGE_SIZE) {
    const page = await fetchPage(apiKey, offset);
    rows.push(...page);
    if (page.length < MOENV_PAGE_SIZE) break;
  }
  return rows.filter(isAccessibleToilet);
}
