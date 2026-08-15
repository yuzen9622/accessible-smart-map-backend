import {
  fetchRailStationIndex,
  fetchRailOdTimetable,
  fetchRailStationTimetable,
} from "../../adapters/rail.adapter";
import { normalizeStationName } from "../../utils/station-name";
import {
  taipeiYmdDash,
  taipeiHHmm,
  addTaipeiDays,
} from "../../config/taipei-time";
import type {
  RailSystem,
  NormalizedTrain,
  NormalizedStationTrain,
} from "../../types/rail";
import type {
  TrainTimetableParams,
  StationTimetableParams,
  TrainTimetableResult,
  StationTimetableResult,
  TrainTimetableEntry,
  StationTimetableEntry,
} from "./train.types";

const MAX_TRAINS = 12;
const MAX_RANGE_DAYS = 60;
const TEMP_FAIL = "火車時刻查詢暫時失敗，請稍後再試";
const TIME_RE = /^(\d{1,2}):(\d{2})$/;

type Ok<T> = { ok: true; value: T };
type Err = { ok: false; error: string };
const ok = <T>(value: T): Ok<T> => ({ ok: true, value });
const err = (error: string): Err => ({ ok: false, error });

function validateRailSystem(raw: unknown): Ok<RailSystem> | Err {
  if (raw === undefined) return ok("TRA");
  if (raw === "TRA" || raw === "THSR") return ok(raw);
  return err("railSystem 只能是 TRA 或 THSR");
}

function validateStationArg(raw: unknown, message: string): Ok<string> | Err {
  if (typeof raw !== "string" || normalizeStationName(raw.trim()) === "") {
    return err(message);
  }
  return ok(raw.trim());
}

function validateDate(raw: unknown, now: Date): Ok<string> | Err {
  if (raw === undefined) return ok(taipeiYmdDash(now));
  if (typeof raw !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    return err("日期無效，格式須為 YYYY-MM-DD");
  }
  const parsed = new Date(`${raw}T00:00:00Z`);
  const reformatted = Number.isNaN(parsed.getTime())
    ? ""
    : `${parsed.getUTCFullYear()}-${String(parsed.getUTCMonth() + 1).padStart(2, "0")}-${String(
        parsed.getUTCDate(),
      ).padStart(2, "0")}`;
  if (reformatted !== raw) return err("日期無效，格式須為 YYYY-MM-DD");

  const today = taipeiYmdDash(now);
  const maxDate = taipeiYmdDash(addTaipeiDays(now, MAX_RANGE_DAYS));
  if (raw < today) return err("僅能查詢今天起的班次");
  if (raw > maxDate) return err(`僅能查詢 ${MAX_RANGE_DAYS} 天內的班次`);
  return ok(raw);
}

function validateTime(raw: unknown): Ok<string | undefined> | Err {
  if (raw === undefined) return ok(undefined);
  if (typeof raw !== "string") {
    return err("時間無效，格式須為 HH:mm（00:00–23:59）");
  }
  const m = TIME_RE.exec(raw);
  if (!m) return err("時間無效，格式須為 HH:mm（00:00–23:59）");
  const hh = Number(m[1]);
  const mm = Number(m[2]);
  if (hh < 0 || hh > 23 || mm < 0 || mm > 59) {
    return err("時間無效，格式須為 HH:mm（00:00–23:59）");
  }
  return ok(`${String(hh).padStart(2, "0")}:${m[2]}`);
}

function timeToMinutes(hhmm: string): number {
  const m = TIME_RE.exec(hhmm)!;
  return Number(m[1]) * 60 + Number(m[2]);
}

function systemLabel(system: RailSystem): string {
  return system === "THSR" ? "高鐵" : "台鐵";
}

async function resolveStationId(
  system: RailSystem,
  name: string,
): Promise<Ok<string> | Err> {
  const outcome = await fetchRailStationIndex(system);
  if (!outcome.ok) return err(TEMP_FAIL);
  const id = outcome.index.get(normalizeStationName(name));
  if (!id)
    return err(`找不到${systemLabel(system)}車站「${name}」，請確認站名`);
  return ok(id);
}

/**
 * Query the OD timetable between two stations for a date, filtered by an
 * optional departure-after / arrive-by window. Returns at most 12 trains.
 * All validation and upstream failures resolve to `{ ok:false, error }`.
 *
 * @param params The OD timetable query.
 * @param now Reference instant (defaults to now; injectable for tests).
 * @returns The timetable result.
 */
export async function getTrainTimetable(
  params: TrainTimetableParams,
  now: Date = new Date(),
): Promise<TrainTimetableResult> {
  const origin = validateStationArg(
    params.originStation,
    "請提供出發站與抵達站名稱",
  );
  if (!origin.ok) return origin;
  const destination = validateStationArg(
    params.destinationStation,
    "請提供出發站與抵達站名稱",
  );
  if (!destination.ok) return destination;
  const system = validateRailSystem(params.railSystem);
  if (!system.ok) return system;
  const date = validateDate(params.date, now);
  if (!date.ok) return date;
  const departAfter = validateTime(params.departAfter);
  if (!departAfter.ok) return departAfter;
  const arriveBy = validateTime(params.arriveBy);
  if (!arriveBy.ok) return arriveBy;

  if (
    normalizeStationName(origin.value) ===
    normalizeStationName(destination.value)
  ) {
    return { ok: false, error: "起訖站相同" };
  }

  const fromId = await resolveStationId(system.value, origin.value);
  if (!fromId.ok) return fromId;
  const toId = await resolveStationId(system.value, destination.value);
  if (!toId.ok) return toId;

  const outcome = await fetchRailOdTimetable(
    system.value,
    fromId.value,
    toId.value,
    date.value,
  );
  if (!outcome.ok) return { ok: false, error: TEMP_FAIL };

  const all = [...outcome.items].sort(
    (a, b) => a.departureMinutes - b.departureMinutes,
  );
  const totalCount = all.length;
  const firstTrain = all[0]?.departureTime ?? null;
  const lastTrain = all[all.length - 1]?.departureTime ?? null;

  const filtered = filterOd(all, departAfter.value, arriveBy.value);
  const matchedCount = filtered.length;
  const trains = truncate(filtered, departAfter.value, arriveBy.value).map(
    toOdEntry,
  );

  const result: TrainTimetableResult = {
    ok: true,
    railSystem: system.value,
    date: date.value,
    origin: { name: origin.value, stationID: fromId.value },
    destination: { name: destination.value, stationID: toId.value },
    totalCount,
    matchedCount,
    firstTrain,
    lastTrain,
    trains,
  };
  const note = odNote(totalCount, matchedCount, trains.length);
  if (note) result.note = note;
  return result;
}

/**
 * Query the departure board for a single station for a date, showing the next
 * departures after a time (defaulting to "now" when the date is today).
 * Returns at most 12 trains. Validation/upstream failures resolve to
 * `{ ok:false, error }`.
 *
 * @param params The station board query.
 * @param now Reference instant (defaults to now; injectable for tests).
 * @returns The station board result.
 */
export async function getStationTimetable(
  params: StationTimetableParams,
  now: Date = new Date(),
): Promise<StationTimetableResult> {
  const station = validateStationArg(params.station, "請提供車站名稱");
  if (!station.ok) return station;
  const system = validateRailSystem(params.railSystem);
  if (!system.ok) return system;
  const date = validateDate(params.date, now);
  if (!date.ok) return date;
  const departAfterValid = validateTime(params.departAfter);
  if (!departAfterValid.ok) return departAfterValid;

  const isToday = date.value === taipeiYmdDash(now);
  const departAfter =
    departAfterValid.value ?? (isToday ? taipeiHHmm(now) : "00:00");

  const stationId = await resolveStationId(system.value, station.value);
  if (!stationId.ok) return stationId;

  const outcome = await fetchRailStationTimetable(
    system.value,
    stationId.value,
    date.value,
  );
  if (!outcome.ok) return { ok: false, error: TEMP_FAIL };

  const all = [...outcome.items].sort(
    (a, b) => a.departureMinutes - b.departureMinutes,
  );
  const totalCount = all.length;
  const firstTrain = all[0]?.departureTime ?? null;
  const lastTrain = all[all.length - 1]?.departureTime ?? null;

  const afterMin = timeToMinutes(departAfter);
  const filtered = all.filter((t) => t.departureMinutes >= afterMin);
  const matchedCount = filtered.length;
  const trains = filtered.slice(0, MAX_TRAINS).map(toStationEntry);

  const result: StationTimetableResult = {
    ok: true,
    railSystem: system.value,
    date: date.value,
    station: { name: station.value, stationID: stationId.value },
    departAfter,
    totalCount,
    matchedCount,
    firstTrain,
    lastTrain,
    trains,
  };
  const note = stationNote(totalCount, matchedCount, trains.length, lastTrain);
  if (note) result.note = note;
  return result;
}

function filterOd(
  trains: NormalizedTrain[],
  departAfter: string | undefined,
  arriveBy: string | undefined,
): NormalizedTrain[] {
  let list = trains;
  if (departAfter !== undefined) {
    const min = timeToMinutes(departAfter);
    list = list.filter((t) => t.departureMinutes >= min);
  }
  if (arriveBy !== undefined) {
    const min = timeToMinutes(arriveBy);
    list = list.filter((t) => t.arrivalMinutes <= min);
  }
  return list;
}

function truncate(
  trains: NormalizedTrain[],
  departAfter: string | undefined,
  arriveBy: string | undefined,
): NormalizedTrain[] {
  if (arriveBy !== undefined) return trains.slice(-MAX_TRAINS);
  void departAfter;
  return trains.slice(0, MAX_TRAINS);
}

function toOdEntry(t: NormalizedTrain): TrainTimetableEntry {
  const entry: TrainTimetableEntry = {
    trainNo: t.trainNo,
    departureTime: t.departureTime,
    arrivalTime: t.arrivalTime,
    durationMinutes: t.durationMinutes,
  };
  if (t.trainType) entry.trainType = t.trainType;
  if (t.arrivesNextDay) entry.arrivesNextDay = true;
  return entry;
}

function toStationEntry(t: NormalizedStationTrain): StationTimetableEntry {
  const entry: StationTimetableEntry = {
    trainNo: t.trainNo,
    departureTime: t.departureTime,
  };
  if (t.trainType) entry.trainType = t.trainType;
  if (t.direction !== undefined) entry.direction = t.direction;
  if (t.destination) entry.destination = t.destination;
  if (t.arrivalTime) entry.arrivalTime = t.arrivalTime;
  return entry;
}

function odNote(
  total: number,
  matched: number,
  shown: number,
): string | undefined {
  if (total === 0) {
    return "該日查無班次，可能日期超出可查範圍或該區間無直達車；需要轉乘可改用路線規劃。";
  }
  if (matched === 0) return "此時間條件下查無班次，可調整時間或日期再試。";
  if (shown < matched) return `符合條件共 ${matched} 班，僅顯示 ${shown} 班。`;
  return undefined;
}

function stationNote(
  total: number,
  matched: number,
  shown: number,
  lastTrain: string | null,
): string | undefined {
  if (total === 0) return "該日該站查無班次，可能日期超出可查範圍。";
  if (matched === 0) {
    return lastTrain
      ? `該時間後已無班次，今日最後一班於 ${lastTrain} 發車。`
      : "該時間後已無班次。";
  }
  if (shown < matched) return `符合條件共 ${matched} 班，僅顯示 ${shown} 班。`;
  return undefined;
}
