/**
 * Realtime transit overlay.
 *
 * After route planning has produced the final top-3, this service overlays
 * live TDX data onto transit legs — schedule-built routes become realtime:
 *
 *  • BUS — the FIRST transit leg of each route gets its scheduled wait
 *    replaced by the TDX EstimatedTimeOfArrival for that stop (the rider is
 *    standing there NOW; later legs board in the future, where an ETA is
 *    meaningless and the timetable stays authoritative). departureTime /
 *    arrivalTime shift to now + ETA (scheduled ride duration preserved) so
 *    the leg never mixes schedule clock times with a realtime wait; without
 *    a live ETA the leg stays fully schedule-based. The endpoint is
 *    chosen by the TDX system code — GTFS legs carry it in the stop-id
 *    prefix ("TXG2646"), MaaS legs in cityCode (from agency_id): THB →
 *    intercity (公路客運), city codes (TPE/NWT/TXG/…) → per-city ETA.
 *    That same leg also carries the TDX plate number and the BusVehicle
 *    low-floor flags for it; when the first bus is confirmed high-floor, a
 *    later low-floor service is looked up (other ETA records for the stop
 *    first, then on-road vehicle positions) and reported as an alternative.
 *  • TRA — v3 TrainLiveBoard reports the delay of every currently-running
 *    train. MaaS legs have no train number (only a line name) — their real
 *    TrainNo is first recovered from the OD daily timetable (departure
 *    station + scheduled "HH:mm", both cached) and backfilled onto the leg.
 *    Delays follow the train, so they apply to EVERY TRA leg whose
 *    TrainNo is on the board: waitInfo gains the delay (source "realtime"),
 *    the leg and route get a「列車誤點」warning, and the route's totalMinutes
 *    absorbs the first delayed leg's delay (downstream legs ride the same
 *    shifted timetable). A train on the board with DelayTime 0 upgrades its
 *    legs to source "realtime" — the schedule is live-confirmed.
 *
 * Honest limits: TDX exposes no per-train realtime ETA/delay for metro or THSR
 * — metro headways (2–6 min) are already approximated by headway/2 and THSR is
 * near-punctual; disruptions there surface via the Alert overlay. OTP rail legs
 * can have their train number, type and real schedule recovered from the OD
 * daily timetable by recoverRailTrainNos — a separate schedule-based pass that
 * runs even outside the realtime window.
 *
 * Realtime only makes sense for "departing now": the overlay is skipped when
 * the route's absolute scheduled departure is more than 15 minutes after the
 * requested departureTime (or now when omitted). Entirely
 * fail-soft: responses are cached 30 s, every error is swallowed — a TDX
 * outage never degrades routing. Disable with USE_REALTIME_TRANSIT=false.
 */

import { tdxFetch } from "../../../config/fetch";
import { busUrl, trainUrl, traUrl, thsrUrl } from "../../../config/transit";
import { odataUrlLiteral } from "../../../utils/transit-text";
import { fetchRailLegGeometry } from "./otp-routing";
import { gtfsTimeToSeconds, secondsToHHmm } from "./gtfs-time";
import { taipeiSecondsOfDay, taipeiYmdDash } from "../../../config/taipei-time";
import { findVehiclesByPlate } from "../../transit/bus.repository";
import type { ITdxBusVehicle } from "../../../types";
import type {
  AccessibleRoute,
  BusLeg,
  LowFloorAlternative,
  TraLeg,
  ThsrLeg,
} from "../../../types/route";
import type {
  CacheEntry,
  TdxEtaRecord,
  TdxRealTimeByFrequencyRecord,
  TdxTrainLiveBoardItem,
  TdxTrainLiveBoardEnvelope,
  TdxTraStation,
  TdxTraOdItem,
  TdxThsrStation,
  TdxThsrOdItem,
  RailOdRow,
  RailMatch,
} from "./realtime-transit.types";

const CACHE_TTL_MS = 30 * 1000;
const MAX_DEPARTURE_SKEW_MS = 15 * 60 * 1000;

const CITY_BY_STOP_PREFIX: Record<string, string> = {
  TPE: "Taipei",
  NWT: "NewTaipei",
  TAO: "Taoyuan",
  TXG: "Taichung",
  TNN: "Tainan",
  KHH: "Kaohsiung",
  KEE: "Keelung",
  HSZ: "Hsinchu",
  HSQ: "HsinchuCounty",
  MIA: "MiaoliCounty",
  CHA: "ChanghuaCounty",
  NAN: "NantouCounty",
  YUN: "YunlinCounty",
  CYQ: "ChiayiCounty",
  CYI: "Chiayi",
  PIF: "PingtungCounty",
  ILA: "YilanCounty",
  HUA: "HualienCounty",
  TTT: "TaitungCounty",
  KIN: "KinmenCounty",
  PEN: "PenghuCounty",
  LIE: "LienchiangCounty",
};

const etaCache = new Map<string, CacheEntry<TdxEtaRecord[]>>();
const onRoadCache = new Map<
  string,
  CacheEntry<TdxRealTimeByFrequencyRecord[]>
>();
let liveBoardCache: CacheEntry<Map<string, number>> | null = null;

function cachedEntry<T>(
  cache: Map<string, CacheEntry<T>>,
  key: string,
): T | undefined {
  const entry = cache.get(key);
  if (!entry) return undefined;
  if (Date.now() > entry.expiresAt) {
    cache.delete(key);
    return undefined;
  }
  return entry.data;
}

const MAX_CACHE_ENTRIES = 5_000;

function cacheSet<T>(
  cache: Map<string, CacheEntry<T>>,
  key: string,
  entry: CacheEntry<T>,
): void {
  cache.delete(key);
  cache.set(key, entry);
  if (cache.size > MAX_CACHE_ENTRIES) {
    for (const oldest of cache.keys()) {
      cache.delete(oldest);
      if (cache.size <= MAX_CACHE_ENTRIES) break;
    }
  }
}

const inflight = new Map<string, Promise<unknown>>();
function dedup<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const current = inflight.get(key);
  if (current) return current as Promise<T>;
  const p = fn().finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
}

/**
 * Leading system code of a GTFS bus stop id — no separator ("TXG2646" → "TXG").
 *
 * @param id The GTFS bus stop id.
 * @returns The leading system code, or null.
 */
function stopPrefix(id: string | undefined): string | null {
  if (!id) return null;
  const m = id.match(/^[A-Z]+/);
  return m ? m[0] : null;
}

/**
 * TDX system code of a bus leg: GTFS legs carry it in the stop-id prefix,
 * TDX MaaS legs in cityCode (derived from agency_id — MaaS has no stop ids).
 *
 * @param leg The bus leg.
 * @returns The TDX system code, or null.
 */
function busSystemCode(leg: BusLeg): string | null {
  return stopPrefix(leg.departureStopId) ?? leg.cityCode ?? null;
}

/**
 * Set `leg.tdxCity` on every BUS leg lacking it — the TDX City path segment the
 * FRONTEND needs to poll RealTimeByFrequency on its own. GTFS/OTP legs derive it
 * from the stop-id prefix, MaaS legs from cityCode; intercity (公路客運, THB)
 * buses have no city path and are left undefined (frontend uses the InterCity
 * endpoint). Legacy-path legs come in with tdxCity already set from the request
 * city, so are skipped here. Pure + local (no TDX call): runs unconditionally in
 * finalizeRoutes.
 *
 * @param routes The routes whose BUS legs are annotated in place.
 */
export function annotateBusTdxCity(routes: AccessibleRoute[]): void {
  for (const route of routes) {
    for (const leg of route.legs) {
      if (leg.type !== "BUS" || leg.tdxCity) continue;
      const code = busSystemCode(leg);
      if (!code || code === "THB") continue;
      const city = CITY_BY_STOP_PREFIX[code];
      if (city) leg.tdxCity = city;
    }
  }
}

/**
 * ETA endpoint for a GTFS-built bus leg. Queries BOTH stops and BOTH directions:
 * GTFS direction_id does not reliably map onto TDX Direction (verified live: 860
 * at 三芝 — GTFS says 0, the bus actually heading there is TDX Direction 1), so
 * the direction is resolved from the data instead (board ETA < alight ETA for
 * the same run).
 *
 * @param leg The bus leg.
 * @returns The ETA endpoint URL, or null when it cannot be derived.
 */
function etaUrl(leg: BusLeg): string | null {
  const prefix = busSystemCode(leg);
  if (!prefix || !leg.routeName || !leg.departureStop || !leg.arrivalStop) {
    return null;
  }
  const query =
    `?$format=JSON&$filter=contains(StopName/Zh_tw,'${odataUrlLiteral(leg.departureStop)}')` +
    ` or contains(StopName/Zh_tw,'${odataUrlLiteral(leg.arrivalStop)}')`;
  if (prefix === "THB") {
    return `${busUrl.interCityEstimatedTimeOfArrivalUrl}/${encodeURIComponent(leg.routeName)}${query}`;
  }
  const city = CITY_BY_STOP_PREFIX[prefix];
  if (!city) return null;
  return `${busUrl.cityEstimatedTimeOfArrivalUrl}/${city}/${encodeURIComponent(leg.routeName)}${query}`;
}

async function fetchEtaRecords(url: string): Promise<TdxEtaRecord[]> {
  const hit = cachedEntry(etaCache, url);
  if (hit) return hit;
  return dedup(`eta|${url}`, async () => {
    let records: TdxEtaRecord[] = [];
    try {
      const resp = await tdxFetch(url);
      if (resp.ok) {
        const data = (await resp.json()) as TdxEtaRecord[];
        if (Array.isArray(data)) records = data;
      }
    } catch {
      // Fail-soft: TDX network/parse failure falls back to empty ETA records.
    }
    cacheSet(etaCache, url, {
      data: records,
      expiresAt: Date.now() + CACHE_TTL_MS,
    });
    return records;
  });
}

function pushUnique(arr: string[], text: string): void {
  if (!arr.includes(text)) arr.push(text);
}

/**
 * First non-WALK leg — the only boarding that happens "now".
 *
 * @param route The route to scan.
 * @returns The first transit leg, or undefined.
 */
function firstTransitLeg(route: AccessibleRoute) {
  return route.legs.find((l) => l.type !== "WALK");
}

/**
 * Record for `name`, preferring an exact StopName match over contains().
 *
 * @param records The ETA records to search.
 * @param name The stop name to match.
 * @param direction The TDX direction to filter on.
 * @returns The matching ETA record, or undefined.
 */
function recordForStop(
  records: TdxEtaRecord[],
  name: string,
  direction: number,
): TdxEtaRecord | undefined {
  const inDir = records.filter((r) => r.Direction === direction);
  return (
    inDir.find((r) => r.StopName?.Zh_tw === name) ??
    inDir.find((r) => r.StopName?.Zh_tw?.includes(name))
  );
}

/**
 * Wait seconds an ETA record implies: EstimateTime first, then a future
 * NextBusTime difference.
 *
 * @param record The ETA record to read.
 * @returns The wait in seconds, or null when the record carries neither.
 */
function estimateSeconds(record: TdxEtaRecord): number | null {
  if (record.EstimateTime != null && record.EstimateTime >= 0) {
    return record.EstimateTime;
  }
  if (record.NextBusTime) {
    const parsedMs = Date.parse(record.NextBusTime);
    if (!Number.isNaN(parsedMs)) {
      const diffMs = parsedMs - Date.now();
      if (diffMs > 0) return Math.round(diffMs / 1000);
    }
  }
  return null;
}

/**
 * Once the wait is live, the scheduled clock times no longer describe the bus
 * the rider will actually board — shift departure to now + ETA and preserve
 * the scheduled ride duration, so a leg is either fully schedule-based or
 * fully realtime, never a mix of both.
 *
 * @param leg The bus leg to shift in place.
 * @param etaSec The live ETA in seconds.
 */
function shiftLegToLiveEta(leg: BusLeg, etaSec: number): void {
  if (!leg.departureTime || !leg.arrivalTime) return;
  const depSec = gtfsTimeToSeconds(leg.departureTime);
  const arrSec = gtfsTimeToSeconds(leg.arrivalTime);
  if (isNaN(depSec) || isNaN(arrSec)) return;
  const rideSec = arrSec >= depSec ? arrSec - depSec : arrSec + 86400 - depSec;
  const nowSec = taipeiSecondsOfDay();
  leg.departureTime = secondsToHHmm(nowSec + etaSec);
  leg.arrivalTime = secondsToHHmm(nowSec + etaSec + rideSec);
}

async function overlayBusEta(route: AccessibleRoute): Promise<void> {
  const leg = firstTransitLeg(route);
  if (!leg || leg.type !== "BUS") return;
  if (leg.waitInfo.source === "realtime") return;
  const url = etaUrl(leg);
  if (!url) return;

  const records = await fetchEtaRecords(url);
  if (!records.length) return;

  const candidates: {
    est: number;
    dir: number;
    live: boolean;
    board: TdxEtaRecord;
  }[] = [];
  const boards: TdxEtaRecord[] = [];
  for (const dir of [0, 1]) {
    const board = recordForStop(records, leg.departureStop, dir);
    if (!board) continue;
    boards.push(board);

    const estSeconds = estimateSeconds(board);
    const live =
      board.EstimateTime != null &&
      board.EstimateTime >= 0 &&
      (board.StopStatus ?? 0) === 0;
    if (estSeconds == null) continue;

    const alight = recordForStop(records, leg.arrivalStop, dir);
    if (alight) {
      if (alight.StopSequence != null && board.StopSequence != null) {
        if (alight.StopSequence <= board.StopSequence) {
          continue;
        }
      } else if (
        alight.EstimateTime != null &&
        alight.EstimateTime <= (board.EstimateTime ?? estSeconds)
      ) {
        continue;
      }
    }
    candidates.push({ est: estSeconds, dir, live, board });
  }

  if (candidates.length) {
    const pick =
      candidates.find((c) => c.dir === leg.direction) ?? candidates[0];
    const prevWait = leg.estimatedWaitMinutes ?? 0;
    const minutes = Math.round(pick.est / 60);
    leg.waitInfo = pick.live
      ? { time: minutes, source: "realtime" }
      : {
          time: secondsToHHmm(taipeiSecondsOfDay() + pick.est),
          source: "schedule",
        };
    leg.estimatedWaitMinutes = minutes;
    shiftLegToLiveEta(leg, pick.est);
    if (route.transferCount === 0) {
      route.totalMinutes = Math.max(1, route.totalMinutes - prevWait + minutes);
    }
    await annotateBusVehicle(route, leg, records, pick.dir, pick.board).catch(
      () => undefined,
    );
    return;
  }

  if (
    boards.length &&
    boards.every((b) => b.StopStatus === 3 || b.StopStatus === 4)
  ) {
    leg.waitInfo = { time: null, source: "unavailable" };
    leg.estimatedWaitMinutes = 0;
    pushUnique(
      route.accessibilityHighlights,
      `⚠️ 公車「${leg.routeName}」即時資訊顯示${
        boards[0].StopStatus === 3 ? "末班車已過" : "今日未營運"
      }，請確認時刻表`,
    );
  }
}

/**
 * TDX 0/1 flag to boolean. Anything else stays undefined (unknown) — it must
 * never collapse into false.
 *
 * @param code The raw TDX flag.
 * @returns true, false, or undefined for unknown.
 */
function tdxFlag(code: number | undefined): boolean | undefined {
  if (code === 1) return true;
  if (code === 0) return false;
  return undefined;
}

/**
 * Plate to vehicle record lookup. Fail-soft: an empty Map on any failure.
 *
 * @param plates Candidate plate numbers (may contain blanks/duplicates).
 * @returns Vehicle records keyed by plate.
 */
async function vehiclesByPlate(
  plates: (string | undefined)[],
): Promise<Map<string, ITdxBusVehicle>> {
  const uniq = [
    ...new Set(plates.filter((p): p is string => !!p && p !== "-1")),
  ];
  if (!uniq.length) return new Map();
  try {
    const docs = await findVehiclesByPlate(uniq);
    return new Map(docs.map((d): [string, ITdxBusVehicle] => [d.plateNumb, d]));
  } catch {
    return new Map();
  }
}

/**
 * Every ETA record for one stop and direction, soonest first (unknown last).
 *
 * @param records The ETA records to search.
 * @param name The stop name to match.
 * @param direction The TDX direction to filter on.
 * @returns The matching records, sorted by wait.
 */
function recordsForStop(
  records: TdxEtaRecord[],
  name: string,
  direction: number,
): TdxEtaRecord[] {
  const inDir = records.filter((r) => r.Direction === direction);
  const exact = inDir.filter((r) => r.StopName?.Zh_tw === name);
  const matched = exact.length
    ? exact
    : inDir.filter((r) => r.StopName?.Zh_tw?.includes(name));
  return [...matched].sort(
    (a, b) =>
      (estimateSeconds(a) ?? Infinity) - (estimateSeconds(b) ?? Infinity),
  );
}

/**
 * RealTimeNearStop endpoint for a bus leg's route and direction.
 * TDX RealTimeNearStop (A2) reports each on-road vehicle's current StopSequence,
 * which allows finding low-floor buses positioned upstream of the boarding stop.
 *
 * @param leg The bus leg.
 * @param direction The TDX direction.
 * @returns The endpoint URL, or null when it cannot be derived.
 */
function onRoadUrl(leg: BusLeg, direction: number): string | null {
  const prefix = busSystemCode(leg);
  if (!prefix || !leg.routeName) return null;
  if (prefix === "THB") {
    return (
      `${busUrl.interCityRealtimeNearStopUrl}?$format=JSON&$filter=` +
      `RouteName/Zh_tw eq '${odataUrlLiteral(leg.routeName)}' and Direction eq ${direction}`
    );
  }
  const city = CITY_BY_STOP_PREFIX[prefix];
  if (!city) return null;
  return (
    `${busUrl.cityRealtimeNearStopUrl}/${city}/${encodeURIComponent(leg.routeName)}` +
    `?$format=JSON&$filter=Direction eq ${direction}`
  );
}

async function fetchOnRoadRecords(
  url: string,
): Promise<TdxRealTimeByFrequencyRecord[]> {
  const hit = cachedEntry(onRoadCache, url);
  if (hit) return hit;
  return dedup(`onroad|${url}`, async () => {
    let records: TdxRealTimeByFrequencyRecord[] = [];
    try {
      const resp = await tdxFetch(url);
      if (resp.ok) {
        const data = (await resp.json()) as TdxRealTimeByFrequencyRecord[];
        if (Array.isArray(data)) records = data;
      }
    } catch {
      // Fail-soft: on-road frequency fetch failure falls back to empty records.
      records = [];
    }
    cacheSet(onRoadCache, url, {
      data: records,
      expiresAt: Date.now() + CACHE_TTL_MS,
    });
    return records;
  });
}

/**
 * Tier 2 alternative: the closest low-floor vehicle still upstream of the
 * boarding stop. Only the stop gap is known — no ETA is inferred from it.
 *
 * @param leg The bus leg being boarded.
 * @param direction The TDX direction.
 * @param boardSeq Stop sequence of the boarding stop.
 * @returns The alternative, or null when none is found.
 */
async function onRoadLowFloorAlternative(
  leg: BusLeg,
  direction: number,
  boardSeq: number | undefined,
): Promise<LowFloorAlternative | null> {
  if (boardSeq == null) return null;
  const url = onRoadUrl(leg, direction);
  if (!url) return null;
  const records = await fetchOnRoadRecords(url);
  const upstream = records
    .filter(
      (r) =>
        r.Direction === direction &&
        typeof r.StopSequence === "number" &&
        r.StopSequence < boardSeq &&
        !!r.PlateNumb,
    )
    .sort((a, b) => (b.StopSequence as number) - (a.StopSequence as number));
  if (!upstream.length) return null;
  const vehicles = await vehiclesByPlate(upstream.map((r) => r.PlateNumb));
  for (const r of upstream) {
    if (tdxFlag(vehicles.get(r.PlateNumb as string)?.isLowFloor) === true) {
      return {
        plateNumb: r.PlateNumb as string,
        etaMinutes: null,
        stopsAway: boardSeq - (r.StopSequence as number),
      };
    }
  }
  return null;
}

/**
 * Attach the boarding vehicle's plate and measured low-floor flags to the leg,
 * plus a later low-floor service when the first bus is confirmed high-floor.
 * Fail-soft throughout: missing data drops a field, it never alters the ETA.
 *
 * @param route The route owning the leg (for highlights).
 * @param leg The first bus leg, boarded now.
 * @param records The ETA records the overlay already fetched.
 * @param direction The TDX direction that was picked.
 * @param board The ETA record the live wait came from.
 */
async function annotateBusVehicle(
  route: AccessibleRoute,
  leg: BusLeg,
  records: TdxEtaRecord[],
  direction: number,
  board: TdxEtaRecord,
): Promise<void> {
  const sameStop = recordsForStop(records, leg.departureStop, direction);
  const vehicles = await vehiclesByPlate([
    board.PlateNumb,
    ...sameStop.map((r) => r.PlateNumb),
  ]);

  if (board.PlateNumb) leg.plateNumb = board.PlateNumb;
  const veh = board.PlateNumb ? vehicles.get(board.PlateNumb) : undefined;
  const lowFloor = tdxFlag(veh?.isLowFloor);
  if (lowFloor !== undefined) leg.isLowFloor = lowFloor;
  const liftOrRamp = tdxFlag(veh?.hasLiftOrRamp);
  if (liftOrRamp !== undefined) leg.hasLiftOrRamp = liftOrRamp;

  if (lowFloor !== false) return;

  for (const r of sameStop) {
    if (!r.PlateNumb || r.PlateNumb === board.PlateNumb) continue;
    if (tdxFlag(vehicles.get(r.PlateNumb)?.isLowFloor) !== true) continue;
    const sec = estimateSeconds(r);
    leg.lowFloorAlternative = {
      plateNumb: r.PlateNumb,
      etaMinutes: sec == null ? null : Math.round(sec / 60),
      stopsAway: null,
    };
    break;
  }

  if (!leg.lowFloorAlternative) {
    const found = await onRoadLowFloorAlternative(
      leg,
      direction,
      board.StopSequence,
    );
    if (found) leg.lowFloorAlternative = found;
  }

  const alt = leg.lowFloorAlternative;
  pushUnique(
    route.accessibilityHighlights,
    alt
      ? `⚠️ 首班公車「${leg.routeName}」為高底盤車；後續 ${alt.plateNumb} 為低地板車${
          alt.etaMinutes != null
            ? `（約 ${alt.etaMinutes} 分後到站）`
            : alt.stopsAway != null
              ? `（尚差 ${alt.stopsAway} 站）`
              : ""
        }`
      : `⚠️ 首班公車「${leg.routeName}」為高底盤車，未查到後續低地板班次`,
  );
}

const STATION_CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const OD_CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const FAILURE_CACHE_TTL_MS = 60 * 1000;

let traStationCache: CacheEntry<Map<string, string>> | null = null;
const odCache = new Map<string, CacheEntry<TdxTraOdItem[]>>();

/**
 * "台中" and "臺中" must hit the same index entry.
 *
 * @param name The station name to normalise.
 * @returns The normalised station name.
 */
function normStation(name: string): string {
  return name.replace(/台/g, "臺").trim();
}

/**
 * TRA station name → StationID (245 stations, one cached call).
 *
 * @returns A map of normalised station name to StationID.
 */
async function traStationIndex(): Promise<Map<string, string>> {
  if (traStationCache && Date.now() < traStationCache.expiresAt) {
    return traStationCache.data;
  }
  return dedup("tra-stations", async () => {
    const index = new Map<string, string>();
    try {
      const resp = await tdxFetch(
        `${traUrl.stationUrl}?$format=JSON&$select=StationID,StationName`,
      );
      if (resp.ok) {
        const items = (await resp.json()) as TdxTraStation[];
        if (Array.isArray(items)) {
          for (const s of items) {
            if (s.StationName?.Zh_tw) {
              index.set(normStation(s.StationName.Zh_tw), s.StationID);
            }
          }
        }
      }
    } catch {
      // Fail-soft: TRA station index fetch failure falls back to empty index.
    }
    traStationCache = {
      data: index,
      expiresAt:
        Date.now() + (index.size ? STATION_CACHE_TTL_MS : FAILURE_CACHE_TTL_MS),
    };
    return index;
  });
}

async function fetchOdTimetable(
  from: string,
  to: string,
  date: string,
): Promise<TdxTraOdItem[]> {
  const key = `${from}|${to}|${date}`;
  const hit = cachedEntry(odCache, key);
  if (hit) return hit;
  return dedup(`od|${key}`, async () => {
    let items: TdxTraOdItem[] = [];
    try {
      const resp = await tdxFetch(
        `${traUrl.dailyTimetableOdUrl(from, to, date)}?$format=JSON`,
      );
      if (resp.ok) {
        const data = (await resp.json()) as TdxTraOdItem[];
        if (Array.isArray(data)) items = data;
      }
    } catch {
      // Fail-soft: TRA OD timetable fetch failure falls back to empty timetable.
    }
    cacheSet(odCache, key, {
      data: items,
      expiresAt:
        Date.now() + (items.length ? OD_CACHE_TTL_MS : FAILURE_CACHE_TTL_MS),
    });
    return items;
  });
}

/**
 * Real TrainNo of a TRA leg: GTFS legs already carry it (numeric); MaaS legs
 * are recovered via the OD timetable (departure station + "HH:mm").
 *
 * @param leg The TRA leg.
 * @returns The real TrainNo, or null when unresolvable (the leg then keeps its schedule untouched).
 */
async function resolveTraTrainNo(leg: TraLeg): Promise<string | null> {
  if (/^\d+$/.test(leg.trainNo)) return leg.trainNo;
  if (!leg.departureStation || !leg.arrivalStation || !leg.departureTime) {
    return null;
  }
  const index = await traStationIndex();
  const from = index.get(normStation(leg.departureStation));
  const to = index.get(normStation(leg.arrivalStation));
  if (!from || !to) return null;
  const timetable = await fetchOdTimetable(from, to, taipeiYmdDash());
  const match = timetable.find(
    (t) => t.OriginStopTime?.DepartureTime === leg.departureTime,
  );
  return match?.DailyTrainInfo?.TrainNo ?? null;
}

/**
 * TrainNo → DelayTime (minutes) for every currently-running TRA train.
 *
 * @returns A map of TrainNo to delay in minutes.
 */
async function fetchTrainDelays(): Promise<Map<string, number>> {
  if (liveBoardCache && Date.now() < liveBoardCache.expiresAt) {
    return liveBoardCache.data;
  }
  return dedup("tra-live-board", async () => {
    const delays = new Map<string, number>();
    try {
      const resp = await tdxFetch(`${trainUrl.trainLiveBoardUrl}?$format=JSON`);
      if (resp.ok) {
        const data = (await resp.json()) as
          TdxTrainLiveBoardEnvelope | TdxTrainLiveBoardItem[];
        const items = Array.isArray(data)
          ? data
          : (data?.TrainLiveBoards ?? []);
        for (const item of items) {
          if (item?.TrainNo) delays.set(item.TrainNo, item.DelayTime ?? 0);
        }
      }
    } catch {
      // Fail-soft: TRA live board fetch failure falls back to empty delays.
    }
    liveBoardCache = { data: delays, expiresAt: Date.now() + CACHE_TTL_MS };
    return delays;
  });
}

async function applyTraDelays(
  route: AccessibleRoute,
  delays: Map<string, number>,
): Promise<void> {
  let totalAdjusted = false;
  for (const leg of route.legs) {
    if (leg.type !== "TRA") continue;
    const trainNo = await resolveTraTrainNo(leg).catch(() => null);
    if (!trainNo) continue;
    leg.trainNo = trainNo;
    const delay = delays.get(trainNo);
    if (delay === undefined) continue;

    if (delay > 0) {
      const minutes = (leg.estimatedWaitMinutes ?? 0) + delay;
      leg.waitInfo = { time: minutes, source: "realtime" };
      leg.estimatedWaitMinutes = minutes;
      const note = `⚠️ 列車 ${leg.trainNo} 誤點約 ${delay} 分`;
      pushUnique(leg.facilityHighlights, note);
      pushUnique(route.accessibilityHighlights, note);
      if (!totalAdjusted) {
        route.totalMinutes += delay;
        totalAdjusted = true;
      }
    } else {
      leg.waitInfo = {
        time: leg.estimatedWaitMinutes ?? 0,
        source: "realtime",
      };
    }
  }
}

let thsrStationCache: CacheEntry<Map<string, string>> | null = null;
const thsrOdCache = new Map<string, CacheEntry<TdxThsrOdItem[]>>();

/**
 * THSR station name → StationID (12 stations, one cached call).
 *
 * @returns A map of normalised station name to StationID.
 */
async function thsrStationIndex(): Promise<Map<string, string>> {
  if (thsrStationCache && Date.now() < thsrStationCache.expiresAt) {
    return thsrStationCache.data;
  }
  return dedup("thsr-stations", async () => {
    const index = new Map<string, string>();
    try {
      const resp = await tdxFetch(
        `${thsrUrl.stationUrl}?$format=JSON&$select=StationID,StationName`,
      );
      if (resp.ok) {
        const items = (await resp.json()) as TdxThsrStation[];
        if (Array.isArray(items)) {
          for (const s of items) {
            if (s.StationName?.Zh_tw) {
              index.set(normStation(s.StationName.Zh_tw), s.StationID);
            }
          }
        }
      }
    } catch {
      // Fail-soft: THSR station index fetch failure falls back to empty index.
    }
    thsrStationCache = {
      data: index,
      expiresAt:
        Date.now() + (index.size ? STATION_CACHE_TTL_MS : FAILURE_CACHE_TTL_MS),
    };
    return index;
  });
}

async function fetchThsrOdTimetable(
  from: string,
  to: string,
  date: string,
): Promise<TdxThsrOdItem[]> {
  const key = `${from}|${to}|${date}`;
  const hit = cachedEntry(thsrOdCache, key);
  if (hit) return hit;
  return dedup(`thsr-od|${key}`, async () => {
    let items: TdxThsrOdItem[] = [];
    try {
      const resp = await tdxFetch(
        `${thsrUrl.dailyTimetableOdUrl(from, to, date)}?$format=JSON`,
      );
      if (resp.ok) {
        const data = (await resp.json()) as TdxThsrOdItem[];
        if (Array.isArray(data)) items = data;
      }
    } catch {
      // Fail-soft: THSR OD timetable fetch failure falls back to empty timetable.
    }
    cacheSet(thsrOdCache, key, {
      data: items,
      expiresAt:
        Date.now() + (items.length ? OD_CACHE_TTL_MS : FAILURE_CACHE_TTL_MS),
    });
    return items;
  });
}

const RAIL_DRIFT_WINDOW_MIN = 10;

/**
 * Minutes-of-day of an "HH:mm" clock (NaN-safe via gtfsTimeToSeconds).
 *
 * @param hhmm The "HH:mm" clock string.
 * @returns The minutes-of-day.
 */
function clockMinutes(hhmm: string): number {
  return Math.round(gtfsTimeToSeconds(hhmm) / 60);
}

const railGeometryCache = new Map<string, CacheEntry<[number, number][]>>();

async function railGeometry(
  system: "TRA" | "THSR",
  fromId: string,
  toId: string,
  straight: [number, number][],
  date: string,
): Promise<[number, number][]> {
  const key = `${system}|${fromId}|${toId}`;
  const hit = cachedEntry(railGeometryCache, key);
  if (hit) return hit;
  return dedup(`railgeom|${key}`, async () => {
    const a = straight[0];
    const b = straight[straight.length - 1];
    const geo =
      (await fetchRailLegGeometry(
        { lat: a[1], lng: a[0] },
        { lat: b[1], lng: b[0] },
        date,
        "12:00",
      ).catch(() => null)) ?? [];
    cacheSet(railGeometryCache, key, {
      data: geo,
      expiresAt:
        Date.now() + (geo.length >= 2 ? OD_CACHE_TTL_MS : FAILURE_CACHE_TTL_MS),
    });
    return geo;
  });
}

/**
 * Pick the train for a (possibly drifted) MaaS departure clock: an exact minute
 * match always wins; otherwise the nearest train within ±RAIL_DRIFT_WINDOW_MIN,
 * preferring a BOARDABLE one (departing at/after the wanted clock) over an
 * already-departed one. We never attribute an arbitrary far-off train (no fuzzy
 * match), so the leg then keeps its schedule untouched.
 *
 * @param rows The OD timetable rows to search.
 * @param wantHHmm The wanted departure clock in "HH:mm" form.
 * @returns The matched train, or null when nothing is within the window.
 */
function snapToTrain(rows: RailOdRow[], wantHHmm: string): RailMatch | null {
  const want = clockMinutes(wantHHmm);
  let best: { row: RailOdRow; diff: number } | null = null;
  for (const row of rows) {
    const dep = (row.OriginStopTime?.DepartureTime ?? "").slice(0, 5);
    if (!/^\d\d:\d\d$/.test(dep) || !row.DailyTrainInfo?.TrainNo) continue;
    const diff = clockMinutes(dep) - want;
    if (diff === 0) {
      best = { row, diff };
      break;
    }
    if (Math.abs(diff) > RAIL_DRIFT_WINDOW_MIN) continue;
    const better =
      !best ||
      (diff >= 0 && best.diff < 0) ||
      (Math.sign(diff) === Math.sign(best.diff) &&
        Math.abs(diff) < Math.abs(best.diff));
    if (better) best = { row, diff };
  }
  if (!best) return null;
  const { DailyTrainInfo, OriginStopTime, DestinationStopTime } = best.row;
  const trainNo = DailyTrainInfo?.TrainNo;
  if (!trainNo) return null;
  return {
    trainNo,
    trainType: DailyTrainInfo?.TrainTypeName?.Zh_tw,
    dep: (OriginStopTime?.DepartureTime ?? "").slice(0, 5),
    arr: (DestinationStopTime?.ArrivalTime ?? "").slice(0, 5),
  };
}

/**
 * Recover one MaaS rail leg in place: fix the station UIDs, then snap trainNo /
 * trainType / times to a real train. Fail-soft — an unresolvable leg is left
 * exactly as it was.
 *
 * @param leg The rail leg to recover in place.
 * @param date The service date in YYYY-MM-DD form.
 * @param index The station name → StationID index.
 * @param fetchOd Fetcher for the OD timetable rows.
 */
async function recoverRailLeg(
  leg: TraLeg | ThsrLeg,
  date: string,
  index: Map<string, string>,
  fetchOd: (from: string, to: string, date: string) => Promise<RailOdRow[]>,
): Promise<void> {
  if (/^\d+$/.test(leg.trainNo)) return;
  if (!leg.departureStation || !leg.arrivalStation || !leg.departureTime)
    return;
  const from = index.get(normStation(leg.departureStation));
  const to = index.get(normStation(leg.arrivalStation));
  if (!from || !to) return;
  leg.departureStationUID = from;
  leg.arrivalStationUID = to;

  if (leg.polyline.length >= 2) {
    const geo = await railGeometry(leg.type, from, to, leg.polyline, date);
    if (geo.length >= 2) leg.polyline = geo;
  }

  const match = snapToTrain(await fetchOd(from, to, date), leg.departureTime);
  if (!match) return;
  leg.trainNo = match.trainNo;
  if (leg.type === "TRA" && match.trainType)
    leg.trainTypeName = match.trainType;

  if (match.dep && match.dep !== leg.departureTime) {
    pushUnique(
      leg.facilityHighlights,
      `🕒 已對應實際班次 ${match.trainNo}（表訂 ${leg.departureTime} → 實際 ${match.dep}）`,
    );
    leg.departureTime = match.dep;
    if (match.arr) {
      leg.arrivalTime = match.arr;
      leg.rideMinutes = Math.max(
        1,
        clockMinutes(match.arr) - clockMinutes(match.dep),
      );
    }
    if (leg.waitInfo.source === "schedule") {
      leg.waitInfo = { time: match.dep, source: "schedule" };
    }
  }
}

/**
 * Recover real TRA + THSR train numbers / times / station UIDs on the final
 * routes, in place. Schedule-based (not realtime), so — unlike
 * overlayRealtimeTransit — it runs regardless of how far the departure is from
 * now and for next-day routes (departureDate → that day's OD timetable).
 * Fail-soft; skipped entirely when USE_REALTIME_TRANSIT=false (it hits TDX).
 *
 * @param routes The routes whose rail legs are recovered in place.
 */
export async function recoverRailTrainNos(
  routes: AccessibleRoute[],
): Promise<void> {
  if (process.env.USE_REALTIME_TRANSIT === "false") return;
  const hasTra = routes.some((r) => r.legs.some((l) => l.type === "TRA"));
  const hasThsr = routes.some((r) => r.legs.some((l) => l.type === "THSR"));
  if (!hasTra && !hasThsr) return;
  const [traIdx, thsrIdx] = await Promise.all([
    hasTra ? traStationIndex() : Promise.resolve(null),
    hasThsr ? thsrStationIndex() : Promise.resolve(null),
  ]);
  await Promise.all(
    routes.flatMap((r) => {
      const date =
        typeof r._scheduledDepartureTime === "number"
          ? taipeiYmdDash(new Date(r._scheduledDepartureTime))
          : (r.departureDate ?? taipeiYmdDash());
      return r.legs.map((leg) => {
        if (leg.type === "TRA" && traIdx) {
          return recoverRailLeg(leg, date, traIdx, fetchOdTimetable).catch(
            () => undefined,
          );
        }
        if (leg.type === "THSR" && thsrIdx) {
          return recoverRailLeg(leg, date, thsrIdx, fetchThsrOdTimetable).catch(
            () => undefined,
          );
        }
        return Promise.resolve();
      });
    }),
  );
}

/**
 * Overlay realtime TDX transit data onto the final routes (top-3), in place.
 * Runs in finalizeRoutes() after the facility overlay and before slimming.
 *
 * @param routes The routes to overlay in place.
 * @param opts Overlay options (departure time).
 */
export async function overlayRealtimeTransit(
  routes: AccessibleRoute[],
  opts: { departureTime?: Date } = {},
): Promise<void> {
  if (process.env.USE_REALTIME_TRANSIT === "false") return;

  const referenceTime = opts.departureTime?.getTime() ?? Date.now();
  const live = routes.filter(
    (route) =>
      typeof route._scheduledDepartureTime !== "number" ||
      route._scheduledDepartureTime <= referenceTime + MAX_DEPARTURE_SKEW_MS,
  );
  if (!live.length) return;

  const needsTra = live.some((r) => r.legs.some((l) => l.type === "TRA"));
  const [delays] = await Promise.all([
    needsTra ? fetchTrainDelays() : Promise.resolve(null),
    ...live.map((r) => overlayBusEta(r).catch(() => undefined)),
  ]);
  if (delays?.size) {
    await Promise.all(
      live.map((route) => applyTraDelays(route, delays).catch(() => undefined)),
    );
  }
}
