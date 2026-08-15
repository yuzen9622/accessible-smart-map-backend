import { normalizeStationName } from "../utils/station-name";
import type {
  NormalizedTrain,
  NormalizedStationTrain,
  OdFetchOutcome,
  StationFetchOutcome,
  StationIndexOutcome,
} from "../types/rail";

const CLOCK_RE = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/;

/**
 * Validate a TDX wall-clock string, accepting both "HH:mm" and "HH:mm:ss".
 *
 * @param value The candidate time string.
 * @returns True when it is a real 00:00:00–23:59:59 time.
 */
export function clockValid(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const m = CLOCK_RE.exec(value);
  if (!m) return false;
  const hh = Number(m[1]);
  const mm = Number(m[2]);
  const ss = m[3] === undefined ? 0 : Number(m[3]);
  return hh >= 0 && hh <= 23 && mm >= 0 && mm <= 59 && ss >= 0 && ss <= 59;
}

/**
 * Convert a validated "HH:mm" / "HH:mm:ss" string to minutes since midnight;
 * seconds are truncated. Returns null when the value is not a valid clock time.
 *
 * @param value The time string.
 * @returns Minutes since midnight (0–1439), or null.
 */
export function hhmmToMinutes(value: unknown): number | null {
  if (!clockValid(value)) return null;
  const m = CLOCK_RE.exec(value)!;
  return Number(m[1]) * 60 + Number(m[2]);
}

function normalizeClock(value: string): string {
  const m = CLOCK_RE.exec(value)!;
  return `${m[1].padStart(2, "0")}:${m[2]}`;
}

function asRecord(value: unknown): Record<string, any> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, any>)
    : null;
}

/**
 * Parse a TDX Rail OD daily-timetable body (top-level array) into normalized
 * trains. A non-array body, or a non-empty array with zero valid rows, is
 * reported as BAD_PAYLOAD; an empty array is a successful empty timetable.
 *
 * @param body The raw JSON body from the OD endpoint.
 * @returns The normalized trains, or a BAD_PAYLOAD outcome.
 */
export function parseOdBody(body: unknown): OdFetchOutcome {
  if (!Array.isArray(body)) return { ok: false, errorCode: "BAD_PAYLOAD" };
  if (body.length === 0) return { ok: true, items: [] };

  const items: NormalizedTrain[] = [];
  for (const raw of body) {
    const row = asRecord(raw);
    if (!row) continue;
    const info = asRecord(row.DailyTrainInfo);
    const trainNo = info?.TrainNo;
    const dep = asRecord(row.OriginStopTime)?.DepartureTime;
    const arr = asRecord(row.DestinationStopTime)?.ArrivalTime;
    if (typeof trainNo !== "string" || !trainNo) continue;
    const depMin = hhmmToMinutes(dep);
    const arrMinRaw = hhmmToMinutes(arr);
    if (depMin === null || arrMinRaw === null) continue;

    const crossesMidnight = arrMinRaw < depMin;
    const arrMin = crossesMidnight ? arrMinRaw + 1440 : arrMinRaw;
    const train: NormalizedTrain = {
      trainNo,
      departureTime: normalizeClock(dep as string),
      arrivalTime: normalizeClock(arr as string),
      departureMinutes: depMin,
      arrivalMinutes: arrMin,
      durationMinutes: arrMin - depMin,
    };
    const trainType = asRecord(info?.TrainTypeName)?.Zh_tw;
    if (typeof trainType === "string" && trainType) train.trainType = trainType;
    if (crossesMidnight) train.arrivesNextDay = true;
    items.push(train);
  }

  if (items.length === 0) return { ok: false, errorCode: "BAD_PAYLOAD" };
  return { ok: true, items };
}

function locateStationRows(body: unknown): any[] | null {
  if (Array.isArray(body)) {
    const nested: any[] = [];
    let sawWrapper = false;
    for (const el of body) {
      const rec = asRecord(el);
      const tt = rec?.TimeTables ?? rec?.StationTimetables;
      if (Array.isArray(tt)) {
        sawWrapper = true;
        nested.push(...tt);
      }
    }
    if (sawWrapper) return nested;
    return body;
  }
  const rec = asRecord(body);
  if (!rec) return null;
  const tt = rec.TimeTables ?? rec.StationTimetables;
  return Array.isArray(tt) ? tt : null;
}

/**
 * Parse a TDX Rail station daily-timetable body into normalized departures.
 * The train array is located defensively (top-level array, or a `TimeTables` /
 * `StationTimetables` wrapper) so a payload whose shape drifts is reported as
 * BAD_PAYLOAD rather than silently emitting nothing. Rows that are arrivals
 * only (no departure) are dropped — the board lists boardable departures.
 *
 * @param body The raw JSON body from the station endpoint.
 * @returns The normalized departures, or a BAD_PAYLOAD outcome.
 */
export function parseStationBody(body: unknown): StationFetchOutcome {
  const rows = locateStationRows(body);
  if (rows === null) return { ok: false, errorCode: "BAD_PAYLOAD" };
  if (rows.length === 0) return { ok: true, items: [] };

  const items: NormalizedStationTrain[] = [];
  for (const raw of rows) {
    const row = asRecord(raw);
    if (!row) continue;
    const info = asRecord(row.DailyTrainInfo) ?? row;
    const trainNo = info.TrainNo ?? row.TrainNo;
    const dep =
      row.DepartureTime ?? asRecord(row.OriginStopTime)?.DepartureTime;
    if (typeof trainNo !== "string" || !trainNo) continue;
    const depMin = hhmmToMinutes(dep);
    if (depMin === null) continue;

    const train: NormalizedStationTrain = {
      trainNo,
      departureTime: normalizeClock(dep as string),
      departureMinutes: depMin,
    };
    const trainType =
      asRecord(row.TrainTypeName)?.Zh_tw ?? asRecord(info.TrainTypeName)?.Zh_tw;
    if (typeof trainType === "string" && trainType) train.trainType = trainType;
    const direction = row.Direction ?? info.Direction;
    if (typeof direction === "number") train.direction = direction;
    const destination =
      asRecord(row.EndingStationName)?.Zh_tw ??
      asRecord(info.EndingStationName)?.Zh_tw;
    if (typeof destination === "string" && destination)
      train.destination = destination;
    const arr =
      row.ArrivalTime ?? asRecord(row.DestinationStopTime)?.ArrivalTime;
    if (clockValid(arr)) train.arrivalTime = normalizeClock(arr as string);
    items.push(train);
  }

  if (items.length === 0) return { ok: false, errorCode: "BAD_PAYLOAD" };
  return { ok: true, items };
}

/**
 * Parse a TDX Rail station-list body into a normalized-name → StationID map.
 * Station names are normalized (台→臺, drop 「車站」/「站」 suffix, trim) so a
 * lookup can match user input. A non-array body, or an array with zero usable
 * stations, is reported as BAD_PAYLOAD.
 *
 * @param body The raw JSON body from the Station endpoint.
 * @returns The station index, or a BAD_PAYLOAD outcome.
 */
export function parseStationList(body: unknown): StationIndexOutcome {
  if (!Array.isArray(body)) return { ok: false, errorCode: "BAD_PAYLOAD" };
  const index = new Map<string, string>();
  for (const raw of body) {
    const row = asRecord(raw);
    const id = row?.StationID;
    const name = asRecord(row?.StationName)?.Zh_tw;
    if (typeof id === "string" && id && typeof name === "string" && name) {
      index.set(normalizeStationName(name), id);
    }
  }
  if (index.size === 0) return { ok: false, errorCode: "BAD_PAYLOAD" };
  return { ok: true, index };
}
