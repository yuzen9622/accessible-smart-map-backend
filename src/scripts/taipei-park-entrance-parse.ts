import type { IParkEntrance } from "../types";
import { parseCsvLine } from "../utils/csv";
import { tm2ToWgs84 } from "./taipei-ramps-parse";

/** Taipei City in WGS84 `[west, south, east, north]`; rejects mistyped TWD97 digits. */
export const TAIPEI_CITY_BBOX = [121.45, 24.96, 121.67, 25.21] as const;

export type ParkEntranceDoc = Omit<IParkEntrance, "_id" | "importedAt">;

export interface ParkEntranceParseResult {
  entrances: ParkEntranceDoc[];
  /** Rows missing an id, park/entrance name or numeric coordinates. */
  malformed: number;
  /** Rows whose converted coordinates fall outside {@link TAIPEI_CITY_BBOX}. */
  outOfBounds: number;
  /** Rows repeating an already-accepted `ID`. */
  duplicateIds: number;
}

const COLUMNS = {
  id: "ID",
  district: "行政區",
  parkName: "公園名稱",
  entranceName: "無障礙出入口名稱",
  x: "TW97座標X",
  y: "TW97座標Y",
  width: "人行道寬度",
  slope: "坡度",
} as const;

function clean(value: string | undefined): string {
  return (value ?? "").replace(/\s+/g, " ").trim();
}

function measurement(value: string | undefined): number | null {
  const text = clean(value);
  if (!text) return null;
  const n = Number(text);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

/**
 * Parse the park accessible-entrance CSV.
 *
 * Columns are located by header name, so a reordered release still parses; an
 * unexpected header yields no rows rather than misreading positions. TWD97
 * coordinates are converted to WGS84 and rows outside Taipei City are dropped
 * — the source has hand-typed coordinates with missing or extra digits.
 * Width (the published minimum clear width, metres) and slope (percent) are
 * kept as-is; an unparseable value becomes null rather than dropping the
 * entrance, whose location is still useful.
 *
 * @param text The decoded CSV text.
 * @returns Accepted entrances plus a count for every rejection reason.
 */
export function parseParkEntranceCsv(text: string): ParkEntranceParseResult {
  const result: ParkEntranceParseResult = {
    entrances: [],
    malformed: 0,
    outOfBounds: 0,
    duplicateIds: 0,
  };
  const lines = text.replace(/^\uFEFF/, "").split(/\r?\n/);
  const header = parseCsvLine(lines[0] ?? "").map((h) => h.trim());
  const index = Object.fromEntries(
    Object.entries(COLUMNS).map(([key, name]) => [key, header.indexOf(name)]),
  ) as Record<keyof typeof COLUMNS, number>;
  if (Object.values(index).some((i) => i < 0)) return result;

  const [west, south, east, north] = TAIPEI_CITY_BBOX;
  const seen = new Set<string>();
  for (const raw of lines.slice(1)) {
    if (!raw.trim()) continue;
    const f = parseCsvLine(raw);
    const sourceId = clean(f[index.id]);
    const parkName = clean(f[index.parkName]);
    const entranceName = clean(f[index.entranceName]);
    const x = Number(clean(f[index.x]));
    const y = Number(clean(f[index.y]));
    if (
      !sourceId ||
      !parkName ||
      !entranceName ||
      !Number.isFinite(x) ||
      !Number.isFinite(y)
    ) {
      result.malformed += 1;
      continue;
    }
    if (seen.has(sourceId)) {
      result.duplicateIds += 1;
      continue;
    }

    const [lng, lat] = tm2ToWgs84(x, y);
    if (!(lng >= west && lng <= east && lat >= south && lat <= north)) {
      result.outOfBounds += 1;
      continue;
    }

    seen.add(sourceId);
    result.entrances.push({
      sourceId,
      district: clean(f[index.district]) || null,
      parkName,
      entranceName,
      location: { type: "Point", coordinates: [lng, lat] },
      minClearWidthM: measurement(f[index.width]),
      slopePercent: measurement(f[index.slope]),
    });
  }
  return result;
}
