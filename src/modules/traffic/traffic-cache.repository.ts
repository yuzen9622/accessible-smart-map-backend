import { redisClient, redisReady } from "../../config/redis";
import { TRAFFIC_TTL } from "../../config/traffic";
import type { LiveSection, RawRoadIncident } from "../../types/traffic";

const LIVE_PREFIX = "traffic:flow:live:";
const INCIDENT_PREFIX = "traffic:incident:";
const CONGESTION_DEF_PREFIX = "traffic:flow:congestion-def:";
export const CACHE_FAILED = "__FAILED__" as const;
export type CacheLookupResult<T> = T | typeof CACHE_FAILED | null;

export interface LiveTrafficEnvelope {
  v: 2;
  fetchedAtMs: number;
  data: LiveSection[];
}

export type LiveTrafficCacheState = "fresh" | "stale" | "failed" | "miss";

export interface LiveTrafficCacheHit {
  state: LiveTrafficCacheState;
  data: LiveSection[];
  ageMs: number;
}

/**
 * In-memory per-key single-flight executor to deduplicate concurrent requests.
 */
export class SingleFlight<T> {
  private inFlight = new Map<string, Promise<T>>();

  async do(key: string, fn: () => Promise<T>): Promise<T> {
    const existing = this.inFlight.get(key);
    if (existing) {
      return existing;
    }
    const promise = fn().finally(() => {
      this.inFlight.delete(key);
    });
    this.inFlight.set(key, promise);
    return promise;
  }

  clear(): void {
    this.inFlight.clear();
  }
}

async function strictClient() {
  await redisReady();
  if (!redisClient || redisClient.status !== "ready") {
    throw new Error("Redis unavailable");
  }
  return redisClient;
}

export async function getLiveTraffics(
  city: string,
): Promise<CacheLookupResult<LiveSection[]>> {
  try {
    const client = await strictClient();
    const raw = await client.get(`${LIVE_PREFIX}${city}`);
    if (!raw) return null;
    if (raw === CACHE_FAILED) {
      return CACHE_FAILED;
    }
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      return parsed as LiveSection[];
    }
    if (
      parsed &&
      typeof parsed === "object" &&
      parsed.v === 2 &&
      Array.isArray(parsed.data)
    ) {
      return parsed.data as LiveSection[];
    }
    return null;
  } catch {
    return null;
  }
}

export async function getLiveTrafficsSwr(
  city: string,
): Promise<LiveTrafficCacheHit> {
  try {
    const client = await strictClient();
    const raw = await client.get(`${LIVE_PREFIX}${city}`);
    if (!raw) {
      return { state: "miss", data: [], ageMs: 0 };
    }
    if (raw === CACHE_FAILED) {
      return { state: "failed", data: [], ageMs: 0 };
    }
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      return {
        state: "stale",
        data: parsed as LiveSection[],
        ageMs: Number.MAX_SAFE_INTEGER,
      };
    }
    if (
      parsed &&
      typeof parsed === "object" &&
      parsed.v === 2 &&
      Array.isArray(parsed.data)
    ) {
      const fetchedAtMs =
        typeof parsed.fetchedAtMs === "number" ? parsed.fetchedAtMs : 0;
      const ageMs = Math.max(0, Date.now() - fetchedAtMs);
      const state: LiveTrafficCacheState =
        ageMs <= TRAFFIC_TTL.liveSoftSec * 1000 ? "fresh" : "stale";
      return {
        state,
        data: parsed.data as LiveSection[],
        ageMs,
      };
    }
    return { state: "miss", data: [], ageMs: 0 };
  } catch {
    return { state: "miss", data: [], ageMs: 0 };
  }
}

export async function setLiveTraffics(
  city: string,
  data: LiveSection[],
  ttlSec: number = TRAFFIC_TTL.liveHardSec,
): Promise<boolean> {
  try {
    const client = await strictClient();
    const envelope: LiveTrafficEnvelope = {
      v: 2,
      fetchedAtMs: Date.now(),
      data,
    };
    await client.set(
      `${LIVE_PREFIX}${city}`,
      JSON.stringify(envelope),
      "EX",
      ttlSec,
    );
    return true;
  } catch {
    return false;
  }
}

export async function setLiveTrafficsFailure(
  city: string,
  ttlSec: number = TRAFFIC_TTL.liveErrSec,
): Promise<boolean> {
  try {
    const client = await strictClient();
    await client.set(`${LIVE_PREFIX}${city}`, CACHE_FAILED, "EX", ttlSec);
    return true;
  } catch {
    return false;
  }
}

export const getLiveSections = getLiveTraffics;
export const getLiveSectionsSwr = getLiveTrafficsSwr;
export const setLiveSections = setLiveTraffics;
export const setLiveSectionsFailure = setLiveTrafficsFailure;

export async function getLiveEvents(
  city: string,
): Promise<CacheLookupResult<RawRoadIncident[]>> {
  try {
    const client = await strictClient();
    const raw = await client.get(`${INCIDENT_PREFIX}${city}`);
    if (!raw) return null;
    if (raw === CACHE_FAILED) {
      return CACHE_FAILED;
    }
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as RawRoadIncident[]) : null;
  } catch {
    return null;
  }
}

export async function setLiveEvents(
  city: string,
  data: RawRoadIncident[],
  ttlSec: number = TRAFFIC_TTL.incidentSec,
): Promise<boolean> {
  try {
    const client = await strictClient();
    await client.set(
      `${INCIDENT_PREFIX}${city}`,
      JSON.stringify(data),
      "EX",
      ttlSec,
    );
    return true;
  } catch {
    return false;
  }
}

export async function setLiveEventsFailure(
  city: string,
  ttlSec: number = TRAFFIC_TTL.incidentErrSec,
): Promise<boolean> {
  try {
    const client = await strictClient();
    await client.set(`${INCIDENT_PREFIX}${city}`, CACHE_FAILED, "EX", ttlSec);
    return true;
  } catch {
    return false;
  }
}

export const getIncidents = getLiveEvents;
export const setIncidents = setLiveEvents;
export const setIncidentsFailure = setLiveEventsFailure;

export async function getCongestionDefinitions<T = unknown>(
  city: string,
): Promise<T | null> {
  try {
    const client = await strictClient();
    const raw = await client.get(`${CONGESTION_DEF_PREFIX}${city}`);
    if (!raw) return null;
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

export async function setCongestionDefinitions(
  city: string,
  data: unknown,
  ttlSec: number = TRAFFIC_TTL.congestionDefSec,
): Promise<boolean> {
  try {
    const client = await strictClient();
    await client.set(
      `${CONGESTION_DEF_PREFIX}${city}`,
      JSON.stringify(data),
      "EX",
      ttlSec,
    );
    return true;
  } catch {
    return false;
  }
}
