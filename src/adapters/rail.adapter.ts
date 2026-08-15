import { tdxFetch } from "../config/fetch";
import { traUrl, thsrUrl } from "../config/transit";
import { parseOdBody, parseStationBody, parseStationList } from "./rail.parse";
import type {
  RailSystem,
  OdFetchOutcome,
  StationFetchOutcome,
  StationIndexOutcome,
} from "../types/rail";

const STATION_INDEX_TTL_MS = 12 * 60 * 60 * 1000;
const TIMETABLE_TTL_MS = 10 * 60 * 1000;
const SHORT_TTL_MS = 60 * 1000;
const OD_CACHE_MAX = 200;
const RAIL_INFLIGHT_MAX = 4;

type AnyOutcome =
  | { ok: true; items?: unknown[]; index?: Map<string, string> }
  | { ok: false; errorCode: string };

interface CacheEntry {
  outcome: AnyOutcome;
  expiresAt: number;
}

const cache = new Map<string, CacheEntry>();
const inflight = new Map<string, Promise<AnyOutcome>>();

function ttlForOutcome(outcome: AnyOutcome): number {
  if (!outcome.ok) return SHORT_TTL_MS;
  if (outcome.index) return STATION_INDEX_TTL_MS;
  return outcome.items && outcome.items.length > 0
    ? TIMETABLE_TTL_MS
    : SHORT_TTL_MS;
}

function evictExpired(now: number): void {
  for (const [key, entry] of cache) {
    if (entry.expiresAt <= now) cache.delete(key);
  }
}

function writeCache(key: string, outcome: AnyOutcome, now: number): void {
  evictExpired(now);
  cache.set(key, { outcome, expiresAt: now + ttlForOutcome(outcome) });
  while (cache.size > OD_CACHE_MAX) {
    const oldest = cache.keys().next().value as string | undefined;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
}

async function runCached(
  key: string,
  producer: () => Promise<AnyOutcome>,
): Promise<AnyOutcome> {
  const now = Date.now();
  const hit = cache.get(key);
  if (hit && hit.expiresAt > now) {
    cache.delete(key);
    cache.set(key, hit);
    return hit.outcome;
  }
  if (hit) cache.delete(key);

  const pending = inflight.get(key);
  if (pending) return pending;

  if (inflight.size >= RAIL_INFLIGHT_MAX) {
    return { ok: false, errorCode: "BUSY" };
  }

  const promise = (async () => {
    const outcome = await producer();
    writeCache(key, outcome, Date.now());
    return outcome;
  })().finally(() => {
    inflight.delete(key);
  });
  inflight.set(key, promise);
  return promise;
}

type FetchResult =
  | { ok: true; body: unknown }
  | { ok: false; errorCode: "HTTP_ERROR" | "NETWORK" };

async function fetchJson(url: string, extraQuery = ""): Promise<FetchResult> {
  try {
    const resp = await tdxFetch(`${url}?$format=JSON${extraQuery}`);
    if (!resp.ok) return { ok: false, errorCode: "HTTP_ERROR" };
    const body = await resp.json();
    return { ok: true, body };
  } catch {
    return { ok: false, errorCode: "NETWORK" };
  }
}

function railUrls(system: RailSystem) {
  return system === "THSR" ? thsrUrl : traUrl;
}

/**
 * Fetch and cache the station-name → StationID index for a rail system.
 * Upstream failures (non-2xx, malformed payload, network error) are reported
 * as `ok:false` so callers never mistake an outage for an unknown station.
 *
 * @param system The rail system (TRA or THSR).
 * @returns The station index outcome.
 */
export async function fetchRailStationIndex(
  system: RailSystem,
): Promise<StationIndexOutcome> {
  const outcome = await runCached(`idx|${system}`, async () => {
    const fetched = await fetchJson(
      railUrls(system).stationUrl,
      "&$select=StationID,StationName",
    );
    if (!fetched.ok) return fetched;
    return parseStationList(fetched.body);
  });
  return outcome as StationIndexOutcome;
}

/**
 * Fetch and cache the OD daily timetable between two stations on a date.
 *
 * @param system The rail system (TRA or THSR).
 * @param fromId Origin StationID.
 * @param toId Destination StationID.
 * @param date Departure date, "YYYY-MM-DD".
 * @returns The normalized OD timetable outcome.
 */
export async function fetchRailOdTimetable(
  system: RailSystem,
  fromId: string,
  toId: string,
  date: string,
): Promise<OdFetchOutcome> {
  const url = railUrls(system).dailyTimetableOdUrl(fromId, toId, date);
  const outcome = await runCached(
    `od|${system}|${fromId}|${toId}|${date}`,
    async () => {
      const fetched = await fetchJson(url);
      if (!fetched.ok) return fetched;
      return parseOdBody(fetched.body);
    },
  );
  return outcome as OdFetchOutcome;
}

/**
 * Fetch and cache the station daily timetable (departure board) for a date.
 *
 * @param system The rail system (TRA or THSR).
 * @param stationId The StationID.
 * @param date The date, "YYYY-MM-DD".
 * @returns The normalized station timetable outcome.
 */
export async function fetchRailStationTimetable(
  system: RailSystem,
  stationId: string,
  date: string,
): Promise<StationFetchOutcome> {
  const url = railUrls(system).dailyTimetableStationUrl(stationId, date);
  const outcome = await runCached(
    `station|${system}|${stationId}|${date}`,
    async () => {
      const fetched = await fetchJson(url);
      if (!fetched.ok) return fetched;
      return parseStationBody(fetched.body);
    },
  );
  return outcome as StationFetchOutcome;
}

/**
 * Clear all rail adapter caches and in-flight state. Test-only.
 */
export function __resetRailAdapterForTest(): void {
  cache.clear();
  inflight.clear();
}
