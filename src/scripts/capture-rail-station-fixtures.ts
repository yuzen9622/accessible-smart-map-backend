/**
 * Capture real TDX station daily-timetable payloads for TRA and THSR into a
 * single fixture used by rail.parse tests. This pins the station-timetable
 * contract to real data instead of an assumed shape.
 *
 * Run: `npm run capture:rail-fixtures`  (needs .env TDX credentials)
 *
 * Writes src/adapters/__fixtures__/rail-station-timetables.json atomically
 * (temp file + rename); on any failure it leaves the existing fixture intact
 * and exits non-zero. Only the JSON response body is written — never headers
 * or credentials. Train arrays are capped to keep the fixture small; the
 * wrapper shape and field names are preserved verbatim.
 */
import fs from "fs";
import path from "path";
import { tdxFetch } from "../config/fetch";
import { traUrl, thsrUrl } from "../config/transit";
import { fetchRailStationIndex } from "../adapters/rail.adapter";
import { parseStationBody } from "../adapters/rail.parse";
import { normalizeStationName } from "../utils/station-name";
import { taipeiYmdDash } from "../config/taipei-time";
import type { RailSystem } from "../types/rail";

const MAX_ROWS = 30;
const OUT_DIR = path.resolve(__dirname, "../adapters/__fixtures__");
const OUT_FILE = path.join(OUT_DIR, "rail-station-timetables.json");

function fail(message: string): never {
  console.error(`[capture-rail-fixtures] ${message}`);
  process.exit(1);
}

function capRows(body: unknown): unknown {
  if (Array.isArray(body)) {
    if (
      body.some(
        (el) =>
          el && typeof el === "object" && Array.isArray((el as any).TimeTables),
      )
    ) {
      return body.map((el) => ({
        ...(el as object),
        TimeTables: (el as any).TimeTables.slice(0, MAX_ROWS),
      }));
    }
    return body.slice(0, MAX_ROWS);
  }
  if (body && typeof body === "object") {
    const rec = body as Record<string, any>;
    for (const key of ["TimeTables", "StationTimetables"]) {
      if (Array.isArray(rec[key])) {
        return { ...rec, [key]: rec[key].slice(0, MAX_ROWS) };
      }
    }
  }
  return body;
}

async function capture(
  system: RailSystem,
  date: string,
): Promise<{ url: string; body: unknown }> {
  const idx = await fetchRailStationIndex(system);
  if (!idx.ok)
    fail(
      `${system} station index unavailable (${idx.errorCode}) — check TDX credentials`,
    );
  const stationId = idx.index.get(normalizeStationName("台北"));
  if (!stationId) fail(`${system} has no 臺北 station in index`);

  const urls = system === "THSR" ? thsrUrl : traUrl;
  const url = urls.dailyTimetableStationUrl(stationId, date);
  const resp = await tdxFetch(`${url}?$format=JSON`);
  if (!resp.ok) fail(`${system} station timetable HTTP ${resp.status}`);
  const body = await resp.json();

  const parsed = parseStationBody(body);
  if (!parsed.ok)
    fail(
      `${system} station payload not parseable (${parsed.errorCode}) — shape drift`,
    );
  if (parsed.items.length === 0)
    fail(`${system} station timetable empty for ${date}`);

  return { url, body: capRows(body) };
}

async function main(): Promise<void> {
  const date = taipeiYmdDash();
  const tra = await capture("TRA", date);
  const thsr = await capture("THSR", date);

  const fixture = {
    capturedAt: new Date().toISOString(),
    date,
    sourceTra: tra.url,
    sourceThsr: thsr.url,
    tra: tra.body,
    thsr: thsr.body,
  };

  fs.mkdirSync(OUT_DIR, { recursive: true });
  const tmp = `${OUT_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(fixture, null, 2));
  fs.renameSync(tmp, OUT_FILE);
  console.log(`[capture-rail-fixtures] wrote ${OUT_FILE} (date=${date})`);
  process.exit(0);
}

main().catch((err) => {
  console.error("[capture-rail-fixtures] failed:", err);
  process.exit(1);
});
