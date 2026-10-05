/**
 * Taipei road-work permits in progress today (臺北市道路挖掘管理中心「今日施工
 * 資訊」, data.taipei). The same cases reach TDX LiveEvent as a single point each;
 * this feed only adds what TDX lacks: whether the case closes the road, its
 * planned end date, and points sampled along the work area. Contractor names
 * and phone numbers in the feed are never read. Cached in-process for 10 minutes and fail-soft: a failed download keeps
 * no expired index. Failed refreshes are retried after the same cache interval.
 */

import { sampleTwd97Lines } from "../utils/twd97";

const TODAYWORK_URL =
  "https://tpnco.blob.core.windows.net/blobfs/Todaywork.json";
const TODAYWORK_TIMEOUT_MS = 15_000;
const TODAYWORK_CACHE_TTL_MS = 10 * 60 * 1000;
const EXTENT_SAMPLE_SPACING_M = 20;
const EXTENT_MAX_POINTS = 200;

/** What the permit feed adds to one TDX construction event. */
export interface TaipeiPermitInfo {
  roadClosed: boolean;
  /** Planned completion date, YYYY-MM-DD (Taipei). */
  endDate?: string;
  /** WGS84 points sampled along the work area outline or line. */
  points?: { lat: number; lng: number }[];
}

interface TodayworkFeature {
  properties?: {
    Ac_no?: string;
    IsBlock?: string;
    Ce_Da?: string;
    Positions_type?: string;
    Positions?: unknown;
  };
}

type Tm2Line = [number, number][];

/**
 * The TM2 polylines of one feature: each line of a MultiLineString, each ring
 * of a MultiPolygon. Anything else yields none.
 *
 * @param type The `Positions_type` value.
 * @param positions The `Positions` value.
 * @returns The polylines.
 */
export function todayworkLines(
  type: string | undefined,
  positions: unknown,
): Tm2Line[] {
  const isPoint = (v: unknown): v is [number, number] =>
    Array.isArray(v) &&
    v.length >= 2 &&
    typeof v[0] === "number" &&
    typeof v[1] === "number";
  const asLine = (v: unknown): Tm2Line | null =>
    Array.isArray(v) && v.length && v.every(isPoint)
      ? v.map((p) => [p[0], p[1]] as [number, number])
      : null;
  if (!Array.isArray(positions)) return [];
  const lines: Tm2Line[] = [];
  if (type === "MultiLineString") {
    for (const line of positions) {
      const l = asLine(line);
      if (l) lines.push(l);
    }
  } else if (type === "MultiPolygon") {
    for (const polygon of positions) {
      if (!Array.isArray(polygon)) continue;
      for (const ring of polygon) {
        const l = asLine(ring);
        if (l) lines.push(l);
      }
    }
  }
  return lines;
}

let cache: { index: Map<string, TaipeiPermitInfo>; expiresAt: number } | null =
  null;
let inflight: Promise<Map<string, TaipeiPermitInfo>> | null = null;

/**
 * Convert a ROC calendar date such as 「115/12/31」 to 「2026-12-31」.
 *
 * @param raw The ROC date.
 * @returns The Gregorian date, or undefined when malformed.
 */
export function rocDateToIso(raw: string | undefined): string | undefined {
  const m = /^(\d{2,3})\/(\d{1,2})\/(\d{1,2})$/.exec(raw?.trim() ?? "");
  if (!m) return undefined;
  const year = Number(m[1]) + 1911;
  return `${year}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}`;
}

/**
 * The permit case number shared by the feed's `Ac_no` (「11500946-3」) and the
 * third segment of a TDX EventID (「379530000H_001-01-11500946-3」).
 *
 * @param caseNo The raw case number.
 * @returns The base case number without its sub-case suffix.
 */
export function permitCaseKey(caseNo: string): string {
  return caseNo.split("-")[0].trim();
}

/**
 * Index the permit features by base case number. A case is a closure when any
 * of its features is; its end date is the latest one.
 *
 * @param features The GeoJSON features.
 * @returns Permit info keyed by base case number.
 */
export function indexTodaywork(
  features: readonly TodayworkFeature[],
): Map<string, TaipeiPermitInfo> {
  const index = new Map<string, TaipeiPermitInfo>();
  const linesByCase = new Map<string, Tm2Line[]>();
  for (const feature of features) {
    const props = feature.properties;
    if (!props?.Ac_no) continue;
    const key = permitCaseKey(props.Ac_no);
    const prev = index.get(key);
    const endDate = rocDateToIso(props.Ce_Da);
    index.set(key, {
      roadClosed: (prev?.roadClosed ?? false) || props.IsBlock === "是",
      endDate:
        prev?.endDate && endDate
          ? prev.endDate > endDate
            ? prev.endDate
            : endDate
          : (prev?.endDate ?? endDate),
    });
    const lines = todayworkLines(props.Positions_type, props.Positions);
    if (lines.length) {
      linesByCase.set(key, [...(linesByCase.get(key) ?? []), ...lines]);
    }
  }
  for (const [key, lines] of linesByCase) {
    const points = sampleTwd97Lines(
      lines,
      EXTENT_SAMPLE_SPACING_M,
      EXTENT_MAX_POINTS,
    );
    const info = index.get(key);
    if (info && points.length) info.points = points;
  }
  return index;
}

async function download(): Promise<Map<string, TaipeiPermitInfo>> {
  const res = await fetch(TODAYWORK_URL, {
    signal: AbortSignal.timeout(TODAYWORK_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const text = (await res.text()).replace(/^\uFEFF/, "");
  const json = JSON.parse(text) as { features?: TodayworkFeature[] };
  return indexTodaywork(json.features ?? []);
}

/**
 * Current Taipei permit info keyed by base case number.
 *
 * @returns The fresh index, or an empty one when a refresh fails. A failure
 * never renews an expired permit snapshot and its old road-closure flags.
 */
export async function fetchTaipeiPermitIndex(): Promise<
  Map<string, TaipeiPermitInfo>
> {
  if (cache && Date.now() < cache.expiresAt) return cache.index;
  if (inflight) return inflight;
  inflight = download()
    .then((index) => {
      cache = { index, expiresAt: Date.now() + TODAYWORK_CACHE_TTL_MS };
      return index;
    })
    .catch((err) => {
      console.warn("[taipei-construction] fetch failed", err);
      const index = new Map<string, TaipeiPermitInfo>();
      cache = { index, expiresAt: Date.now() + TODAYWORK_CACHE_TTL_MS };
      return index;
    })
    .finally(() => {
      inflight = null;
    });
  return inflight;
}
