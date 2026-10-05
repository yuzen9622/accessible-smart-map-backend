import { parseCsvLine } from "./csv";
import { normalizeStationName } from "./station-name";

/** One row of the Taipei Metro accessibility-facility anomaly announcement CSV. */
export interface MetroNoticeRow {
  postedAt: Date;
  line: string;
  station: string;
  description: string;
}

/** The latest still-active elevator anomaly announced for one station. */
export interface ActiveMetroNotice {
  station: string;
  line: string;
  postedAt: Date;
  keyword: string;
  description: string;
}

const RESOLVED_RE = /已完成|恢復|開放使用|已修復/;
const ACTIVE_RE = /維修|檢修|故障|暫停|停用/;
const NOTICE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Parse the compact `YYYYMMDDTHHmmss` timestamp the CSV uses, read as Taipei
 * local time.
 *
 * @param raw The raw timestamp field.
 * @returns The instant, or null when the field is malformed.
 */
export function parseNoticeTimestamp(raw: string): Date | null {
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})$/.exec(raw.trim());
  if (!m) return null;
  const [, y, mo, d, h, mi, s] = m;
  const date = new Date(`${y}-${mo}-${d}T${h}:${mi}:${s}+08:00`);
  return Number.isNaN(date.getTime()) ? null : date;
}

/**
 * Parse the decoded announcement CSV (header `項次,日期時間,路線,車站,說明`).
 * Rows with an unparseable timestamp or an empty station are dropped.
 *
 * @param text The CSV text, already decoded from Big5.
 * @returns The announcement rows in file order.
 */
export function parseMetroNoticeCsv(text: string): MetroNoticeRow[] {
  const lines = text.replace(/^\uFEFF/, "").split(/\r?\n/);
  const header = parseCsvLine(lines[0] ?? "").map((h) => h.trim());
  const col = (name: string) => header.indexOf(name);
  const iTime = col("日期時間");
  const iLine = col("路線");
  const iStation = col("車站");
  const iDesc = col("說明");
  if ([iTime, iStation, iDesc].some((i) => i < 0)) return [];

  const rows: MetroNoticeRow[] = [];
  for (const raw of lines.slice(1)) {
    if (!raw.trim()) continue;
    const fields = parseCsvLine(raw);
    const postedAt = parseNoticeTimestamp(fields[iTime] ?? "");
    const station = (fields[iStation] ?? "").trim();
    if (!postedAt || !station) continue;
    rows.push({
      postedAt,
      line: iLine >= 0 ? (fields[iLine] ?? "").trim() : "",
      station,
      description: (fields[iDesc] ?? "").trim(),
    });
  }
  return rows;
}

/**
 * Reduce the announcement log to the stations whose latest elevator notice is
 * still an active anomaly. A later 「已完成／開放使用」 notice for the same
 * station clears an earlier outage; notices that mention neither an outage nor
 * a resolution, or that are older than 30 days, are ignored.
 *
 * @param rows The parsed announcement rows.
 * @param now The reference time for the age cutoff.
 * @returns Active notices keyed by normalized station name.
 */
export function activeElevatorNotices(
  rows: readonly MetroNoticeRow[],
  now: Date = new Date(),
): Map<string, ActiveMetroNotice> {
  const latest = new Map<string, MetroNoticeRow>();
  for (const row of rows) {
    if (!/電梯/.test(row.description)) continue;
    const key = normalizeStationName(row.station);
    const prev = latest.get(key);
    if (!prev || row.postedAt.getTime() >= prev.postedAt.getTime()) {
      latest.set(key, row);
    }
  }

  const active = new Map<string, ActiveMetroNotice>();
  for (const [key, row] of latest) {
    if (now.getTime() - row.postedAt.getTime() > NOTICE_MAX_AGE_MS) continue;
    if (RESOLVED_RE.test(row.description)) continue;
    const keyword = row.description.match(ACTIVE_RE)?.[0];
    if (!keyword) continue;
    active.set(key, {
      station: key,
      line: row.line,
      postedAt: row.postedAt,
      keyword,
      description: row.description.slice(0, 120),
    });
  }
  return active;
}

/**
 * Station name of a Taipei Metro exit facility name such as
 * 「動物園站出口電梯1」 or 「台北車站 M8 出口電梯」.
 *
 * @param name The facility name.
 * @returns The normalized station name, or null when none can be read.
 */
export function stationOfMetroFacilityName(name: string): string | null {
  const m = /^(.+?)(車站|站)/.exec(name.trim());
  return m ? normalizeStationName(m[1]) : null;
}

/** The public shape of an active notice attached to a metro elevator facility. */
export interface MetroOutageNotice {
  description: string;
  postedAt: string;
}

/**
 * The active notice for a metro elevator facility, in its public shape.
 *
 * @param notices Active notices keyed by normalized station name.
 * @param name The facility name; only names mentioning 電梯 can match.
 * @returns The notice, or undefined when the station has none.
 */
export function outageNoticeForMetroFacility(
  notices: ReadonlyMap<string, ActiveMetroNotice>,
  name: string,
): MetroOutageNotice | undefined {
  if (!/電梯/.test(name)) return undefined;
  const station = stationOfMetroFacilityName(name);
  const notice = station ? notices.get(station) : undefined;
  return notice
    ? {
        description: notice.description,
        postedAt: notice.postedAt.toISOString(),
      }
    : undefined;
}
