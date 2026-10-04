/**
 * Taipei Metro accessibility-facility anomaly announcements (data.taipei,
 * 臺北捷運車站無障礙設施異常公告). The resource is a Big5 CSV; it is decoded
 * here and parsed into rows. Cached in-process for 5 minutes, deduplicated
 * across concurrent callers, and fail-soft: a failed refresh returns no rows
 * rather than renewing an expired snapshot of elevator outages.
 */
import {
  parseMetroNoticeCsv,
  type MetroNoticeRow,
} from "../utils/metro-notice";

const NOTICE_URL =
  "https://data.taipei/api/frontstage/tpeod/dataset/resource.download?rid=649c44eb-60b5-4746-a353-cbdc6651fc09";
const NOTICE_TIMEOUT_MS = 10_000;
const NOTICE_CACHE_TTL_MS = 5 * 60 * 1000;

let cache: { rows: MetroNoticeRow[]; expiresAt: number } | null = null;
let inflight: Promise<MetroNoticeRow[]> | null = null;

async function download(): Promise<MetroNoticeRow[]> {
  const res = await fetch(NOTICE_URL, {
    signal: AbortSignal.timeout(NOTICE_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const text = new TextDecoder("big5").decode(await res.arrayBuffer());
  return parseMetroNoticeCsv(text);
}

/**
 * Fetch the current announcement rows.
 *
 * @returns The fresh parsed rows, or an empty list on refresh failure.
 */
export async function fetchTaipeiMetroNotices(): Promise<MetroNoticeRow[]> {
  if (cache && Date.now() < cache.expiresAt) return cache.rows;
  if (inflight) return inflight;
  inflight = download()
    .then((rows) => {
      cache = { rows, expiresAt: Date.now() + NOTICE_CACHE_TTL_MS };
      return rows;
    })
    .catch((err) => {
      console.warn("[metro-notice] fetch failed", err);
      const rows: MetroNoticeRow[] = [];
      cache = { rows, expiresAt: Date.now() + NOTICE_CACHE_TTL_MS };
      return rows;
    })
    .finally(() => {
      inflight = null;
    });
  return inflight;
}
