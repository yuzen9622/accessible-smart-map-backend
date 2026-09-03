import { tdxFetch } from "../../config/fetch";
import {
  TRAFFIC_FETCH_TIMEOUT_MS,
  TRAFFIC_INCIDENT_HARD_EXCLUDE_KEYWORDS,
  TRAFFIC_TARGET_CITIES,
  trafficUrl,
} from "../../config/traffic";
import type {
  Bbox,
  RawRoadIncident,
  RoadIncident,
  RoadIncidentSeverity,
  TdxLiveEventRow,
} from "../../types/traffic";
import { wktToGeoJson } from "../../utils/wkt";
import {
  CACHE_FAILED,
  getLiveEvents,
  setLiveEvents,
  setLiveEventsFailure,
  SingleFlight,
} from "./traffic-cache.repository";
import { findCitiesIntersecting } from "./traffic-section.repository";

export function classifyIncident(incident: {
  title: string;
  description?: string;
}): RoadIncidentSeverity {
  const text = `${incident.title} ${incident.description ?? ""}`;
  const isClosure = TRAFFIC_INCIDENT_HARD_EXCLUDE_KEYWORDS.some((kw) =>
    text.includes(kw),
  );
  return isClosure ? "closure" : "advisory";
}

function parseIncidentLocation(
  row: TdxLiveEventRow,
): { lat: number; lng: number } | null {
  if (row.Positions) {
    const geo = wktToGeoJson(row.Positions);
    if (geo && geo.type === "Point") {
      const [lng, lat] = geo.coordinates;
      if (Number.isFinite(lng) && Number.isFinite(lat)) {
        return { lat, lng };
      }
    }
  }

  const rawRow = row as Record<string, unknown>;
  const rawLat = rawRow.PositionLat ?? rawRow.lat ?? rawRow.Latitude;
  const rawLng =
    rawRow.PositionLon ??
    rawRow.PositionLng ??
    rawRow.lng ??
    rawRow.lon ??
    rawRow.Longitude;

  const lat = Number(rawLat);
  const lng = Number(rawLng);

  if (Number.isFinite(lat) && Number.isFinite(lng) && lat !== 0 && lng !== 0) {
    return { lat, lng };
  }

  return null;
}

const roadIncidentsFlight = new SingleFlight<RawRoadIncident[]>();

export async function getCityRoadIncidents(
  city: string,
): Promise<RawRoadIncident[]> {
  return roadIncidentsFlight.do(city, async () => {
    const cached = await getLiveEvents(city);
    if (cached === CACHE_FAILED) {
      return [];
    }
    if (cached !== null) {
      return cached;
    }

    try {
      const res = await tdxFetch(
        `${trafficUrl.liveEventUrl(city)}?$format=JSON`,
        {
          signal: AbortSignal.timeout(TRAFFIC_FETCH_TIMEOUT_MS),
        },
      );

      if (!res.ok) {
        console.warn(
          `[traffic] Upstream TDX error for ${city} road events: HTTP ${res.status}`,
        );
        await setLiveEventsFailure(city);
        return [];
      }

      const payload = await res.json();
      const rows: TdxLiveEventRow[] = Array.isArray(payload)
        ? payload
        : payload &&
            typeof payload === "object" &&
            Array.isArray((payload as Record<string, unknown>).LiveEvents)
          ? ((payload as Record<string, unknown>)
              .LiveEvents as TdxLiveEventRow[])
          : [];

      const normalized: RawRoadIncident[] = [];
      for (const r of rows) {
        const loc = parseIncidentLocation(r);
        if (!loc) continue;

        normalized.push({
          incidentId:
            r.EventID || `incident-${Math.random().toString(36).slice(2, 9)}`,
          title: r.EventTitle || "即時路況事件",
          description: r.Description,
          roadName: r.Location?.RoadName,
          location: loc,
          startTime: r.EffectiveTime,
          endTime: r.ExpireTime,
        });
      }

      await setLiveEvents(city, normalized);
      return normalized;
    } catch (err) {
      console.warn(`[traffic] Failed fetching road events for ${city}:`, err);
      await setLiveEventsFailure(city);
      return [];
    }
  });
}

export interface ActiveIncidentsOptions {
  bbox?: Bbox;
  city?: string;
  cities?: string[];
}

export async function getActiveRoadIncidents(
  options: ActiveIncidentsOptions = {},
): Promise<RoadIncident[]> {
  const { bbox, city } = options;
  let targetCities = options.cities ?? (city ? [city] : undefined);

  if (!targetCities || targetCities.length === 0) {
    if (bbox) {
      const intersecting = await findCitiesIntersecting(bbox).catch(() => []);
      targetCities =
        intersecting.length > 0 ? intersecting : [...TRAFFIC_TARGET_CITIES];
    } else {
      targetCities = [...TRAFFIC_TARGET_CITIES];
    }
  }

  const rawArrays = await Promise.all(
    targetCities.map((c) => getCityRoadIncidents(c)),
  );

  const allRaw = rawArrays.flat();
  const now = Date.now();
  const active: RoadIncident[] = [];

  for (const raw of allRaw) {
    if (raw.startTime) {
      const startMs = Date.parse(raw.startTime);
      if (Number.isFinite(startMs) && startMs > now) {
        continue;
      }
    }

    if (raw.endTime) {
      const endMs = Date.parse(raw.endTime);
      if (Number.isFinite(endMs) && endMs < now) {
        continue;
      }
    }

    if (bbox) {
      const [minLng, minLat, maxLng, maxLat] = bbox;
      const { lat, lng } = raw.location;
      if (lng < minLng || lng > maxLng || lat < minLat || lat > maxLat) {
        continue;
      }
    }

    const severity = classifyIncident(raw);

    active.push({
      ...raw,
      severity,
    });
  }

  return active;
}

export const getRoadIncidents = getActiveRoadIncidents;
