import { tdxFetch } from "../../config/fetch";
import {
  congestionToLabel,
  congestionToSemanticLevel,
  TDX_CONGESTION_UNKNOWN,
  TRAFFIC_FETCH_TIMEOUT_MS,
  TRAFFIC_LIVE_TARGET_CITIES,
  TRAFFIC_TTL,
  trafficUrl,
} from "../../config/traffic";
import type {
  Bbox,
  CongestionLevel,
  LiveSection,
  TdxLiveTrafficRow,
  TrafficFlowCollection,
  TrafficFlowFeature,
  TrafficSectionGeometry,
} from "../../types/traffic";
import {
  getLiveTrafficsSwr,
  type LiveTrafficCacheState,
  setLiveTraffics,
  setLiveTrafficsFailure,
  SingleFlight,
} from "./traffic-cache.repository";
import { scheduleLiveRefresh } from "./traffic-live.worker";
import {
  findByCity,
  findSectionsInBbox,
  latestImportedAt,
} from "./traffic-section.repository";

export class TrafficSectionUnavailableError extends Error {
  constructor(message = "Traffic section geometries unavailable") {
    super(message);
    this.name = "TrafficSectionUnavailableError";
  }
}

const liveTrafficFlight = new SingleFlight<LiveSection[]>();

function normalizeCongestionLevel(raw?: string): CongestionLevel {
  if (!raw) return TDX_CONGESTION_UNKNOWN;
  const parsed = Number(raw);
  if (parsed === -1) return -1;
  if (parsed >= 1 && parsed <= 6) {
    return parsed as CongestionLevel;
  }
  return TDX_CONGESTION_UNKNOWN;
}

function getTrafficUrlForTarget(target: string): string {
  if (target === "Freeway") {
    return trafficUrl.freewayLiveTrafficUrl();
  }
  if (target === "Highway") {
    return trafficUrl.highwayLiveTrafficUrl();
  }
  return trafficUrl.liveTrafficUrl(target);
}

/**
 * Worker-only. Performs the actual TDX call; never invoked from a request path.
 */
export async function refreshCityLiveTraffics(
  city: string,
): Promise<LiveSection[]> {
  return liveTrafficFlight.do(city, async () => {
    try {
      const url = getTrafficUrlForTarget(city);
      const res = await tdxFetch(`${url}?$format=JSON`, {
        signal: AbortSignal.timeout(TRAFFIC_FETCH_TIMEOUT_MS),
      });

      if (!res.ok) {
        console.warn(
          `[traffic] Upstream TDX error for ${city} live traffic: HTTP ${res.status}`,
        );
        await setLiveTrafficsFailure(city);
        return [];
      }

      const payload = await res.json();
      const rows: TdxLiveTrafficRow[] = Array.isArray(payload)
        ? payload
        : payload &&
            typeof payload === "object" &&
            Array.isArray((payload as Record<string, unknown>).LiveTraffics)
          ? ((payload as Record<string, unknown>)
              .LiveTraffics as TdxLiveTrafficRow[])
          : [];

      const normalized: LiveSection[] = [];
      for (const r of rows) {
        if (!r.SectionID) continue;
        const travelTime =
          r.TravelTime === -99 || r.TravelTime == null
            ? undefined
            : r.TravelTime;
        const speed =
          r.TravelSpeed === -99 || r.TravelSpeed == null
            ? undefined
            : r.TravelSpeed;

        normalized.push({
          sectionId: r.SectionID,
          congestionLevel: normalizeCongestionLevel(r.CongestionLevel),
          travelTimeSec: travelTime,
          speedKmh: speed,
          updatedAt: r.DataCollectTime,
        });
      }

      await setLiveTraffics(city, normalized, TRAFFIC_TTL.liveHardSec);
      return normalized;
    } catch (err) {
      console.warn(`[traffic] Failed fetching live traffic for ${city}:`, err);
      await setLiveTrafficsFailure(city);
      return [];
    }
  });
}

/**
 * Cache-only reader for city live traffic. Does NOT call TDX.
 */
export async function getCityLiveTraffics(
  city: string,
): Promise<{ data: LiveSection[]; state: LiveTrafficCacheState }> {
  return getLiveTrafficsSwr(city);
}

/**
 * Retrieves live section traffic from the Redis cache for all configured targets.
 * Request-path safe: NEVER queries MongoDB or makes upstream TDX HTTP requests.
 * Triggers background refreshes asynchronously for stale or missing targets.
 *
 * @param _bbox Route bbox kept for API signature compatibility.
 */
export async function getLiveSectionsForBbox(
  _bbox: Bbox,
): Promise<Map<string, LiveSection>> {
  try {
    const targets = Array.from(
      new Set([...TRAFFIC_LIVE_TARGET_CITIES, "Freeway", "Highway"]),
    );
    const hits = await Promise.all(
      targets.map(async (target) => {
        const hit = await getLiveTrafficsSwr(target);
        if (
          hit.state === "stale" ||
          hit.state === "miss" ||
          hit.state === "failed"
        ) {
          scheduleLiveRefresh(target);
        }
        return hit;
      }),
    );

    const map = new Map<string, LiveSection>();
    for (const hit of hits) {
      for (const item of hit.data) {
        map.set(item.sectionId, item);
      }
    }
    return map;
  } catch (err) {
    console.warn("[traffic] Error reading live sections cache for bbox:", err);
    return new Map();
  }
}

export interface TrafficFlowOptions {
  bbox?: Bbox;
  city?: string;
  minLevel?: number;
}

export async function getTrafficSectionsForBbox(
  bbox: Bbox,
): Promise<TrafficSectionGeometry[]> {
  try {
    return await findSectionsInBbox(bbox);
  } catch (err) {
    console.warn(
      "[traffic] Failed fetching traffic section geometries for bbox:",
      err,
    );
    return [];
  }
}

export async function getTrafficFlowCollection(
  opts: TrafficFlowOptions,
): Promise<TrafficFlowCollection> {
  const { minLevel = 0 } = opts;
  let sections: TrafficSectionGeometry[] = [];
  let effectiveBbox: Bbox;

  if (opts.bbox) {
    effectiveBbox = opts.bbox;
    sections = await findSectionsInBbox(opts.bbox);
  } else if (opts.city) {
    sections = await findByCity(opts.city);
    if (sections.length > 0) {
      let minLng = Infinity;
      let minLat = Infinity;
      let maxLng = -Infinity;
      let maxLat = -Infinity;
      for (const s of sections) {
        const coords =
          s.geometry.type === "LineString"
            ? s.geometry.coordinates
            : s.geometry.coordinates.flat();
        for (const [lng, lat] of coords) {
          if (lng < minLng) minLng = lng;
          if (lng > maxLng) maxLng = lng;
          if (lat < minLat) minLat = lat;
          if (lat > maxLat) maxLat = lat;
        }
      }
      effectiveBbox = [minLng, minLat, maxLng, maxLat];
    } else {
      effectiveBbox = [0, 0, 0, 0];
    }
  } else {
    throw new TrafficSectionUnavailableError(
      "Either bbox or city must be provided",
    );
  }

  if (sections.length === 0) {
    throw new TrafficSectionUnavailableError(
      "No traffic section geometries found for the requested bounding box",
    );
  }

  const cities = Array.from(new Set(sections.map((s) => s.city)));
  const cityTraffics = await Promise.all(
    cities.map((city) => getCityLiveTraffics(city)),
  );

  const liveMap = new Map<string, LiveSection>();
  let latestLiveUpdate: string | null = null;
  let hasAnyLiveData = false;

  for (const result of cityTraffics) {
    if (result.data.length > 0) hasAnyLiveData = true;
    for (const item of result.data) {
      liveMap.set(item.sectionId, item);
      if (item.updatedAt) {
        if (!latestLiveUpdate || item.updatedAt > latestLiveUpdate) {
          latestLiveUpdate = item.updatedAt;
        }
      }
    }
  }

  const levelCounts: Record<string, number> = {
    "-99": 0,
    "-1": 0,
    "1": 0,
    "2": 0,
    "3": 0,
    "4": 0,
    "5": 0,
    "6": 0,
  };

  const features: TrafficFlowFeature[] = [];

  for (const sec of sections) {
    const live = liveMap.get(sec.sectionId);
    const level: CongestionLevel =
      live?.congestionLevel ?? TDX_CONGESTION_UNKNOWN;

    levelCounts[String(level)] = (levelCounts[String(level)] ?? 0) + 1;

    if (minLevel > 0) {
      if (level < minLevel || level === -99 || level === -1) {
        continue;
      }
    }

    const semanticLevel = congestionToSemanticLevel(level);
    const congestionLabel = congestionToLabel(level);

    features.push({
      type: "Feature",
      geometry: sec.geometry,
      properties: {
        sectionId: sec.sectionId,
        roadName: sec.roadName,
        city: sec.city,
        trafficLevel: semanticLevel,
        congestionLevel: level,
        congestionLabel,
        speedKmh: live?.speedKmh,
        travelTimeSec: live?.travelTimeSec,
      },
    });
  }

  const importedAtDate = await latestImportedAt();

  return {
    type: "FeatureCollection",
    features,
    meta: {
      cities,
      bbox: effectiveBbox,
      count: features.length,
      levelCounts,
      liveUpdatedAt: hasAnyLiveData ? latestLiveUpdate : null,
      geometryImportedAt: importedAtDate ? importedAtDate.toISOString() : null,
    },
  };
}

export async function getTrafficFlowByBbox(
  bbox: Bbox,
  minLevel = 0,
): Promise<TrafficFlowCollection> {
  return getTrafficFlowCollection({ bbox, minLevel });
}
