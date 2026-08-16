/**
 * CWA open-data HTTP I/O for weather. Performs the two-stage nearest-point
 * lookup (089 county feed → township feed) and returns the raw nearest `Location`
 * payload; field normalization is the parser's job. All failures are thrown via
 * `withResilience`; raw datastore responses are cached per resource id.
 */
import { haversineMeters } from "../utils/geo";
import { redisGet, redisSet } from "../config/redis";
import {
  UpstreamBadPayloadError,
  UpstreamHttpError,
  withResilience,
} from "../config/resilience";
import {
  CWA_COUNTY_RESOURCE_ID,
  CWA_DATASTORE_BASE_URL,
  CWA_OBSERVATION_RESOURCE_ID,
  CWA_WEATHER_ELEMENTS,
  ENV_CACHE_TTL_SEC,
  cwaRawCacheKey,
} from "../constants/environment";
import { CWA_COUNTY_RESOURCE_IDS } from "../constants/cwa-county-codes";
import type {
  CwaLocation,
  CwaObservationResponse,
  CwaObservationStation,
} from "../modules/environment/environment.types";

const CIRCUIT_KEY = "cwa";

interface CwaDatastoreResponse {
  records?: { Locations?: Array<{ Location?: CwaLocation[] }> };
}

function nearest(
  locations: CwaLocation[],
  lat: number,
  lng: number,
): CwaLocation {
  let best = locations[0];
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const loc of locations) {
    const distance = haversineMeters(
      lat,
      lng,
      Number(loc.Latitude),
      Number(loc.Longitude),
    );
    if (distance < bestDistance) {
      bestDistance = distance;
      best = loc;
    }
  }
  return best;
}

function safeJsonParse<T>(raw: string): T | null {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

async function fetchDatastore(resourceId: string): Promise<CwaLocation[]> {
  const cacheKey = cwaRawCacheKey(resourceId);
  const cached = await redisGet(cacheKey);
  if (cached) {
    const parsed = safeJsonParse<CwaLocation[]>(cached);
    if (parsed) return parsed;
  }

  const key = process.env.CWA_API_KEY ?? "";
  const elements = encodeURIComponent(CWA_WEATHER_ELEMENTS.join(","));
  const url =
    `${CWA_DATASTORE_BASE_URL}/${resourceId}` +
    `?Authorization=${key}&format=JSON&ElementName=${elements}`;

  const locations = await withResilience(CIRCUIT_KEY, async (signal) => {
    const res = await fetch(url, { signal });
    if (!res.ok) throw new UpstreamHttpError(res.status);

    const data = (await res.json()) as CwaDatastoreResponse;
    const list = data.records?.Locations?.[0]?.Location;
    if (!Array.isArray(list) || list.length === 0) {
      throw new UpstreamBadPayloadError(
        `CWA datastore ${resourceId} returned no locations`,
      );
    }
    return list;
  });

  await redisSet(
    cacheKey,
    JSON.stringify(locations),
    ENV_CACHE_TTL_SEC.WEATHER,
  );
  return locations;
}

/**
 * Resolves the weather observation `Location` closest to a coordinate using the
 * two-stage scheme: pick the nearest of the 22 county points, then the nearest
 * township within that county's feed.
 *
 * @param lat Query latitude.
 * @param lng Query longitude.
 * @returns The raw nearest township `Location` (with its `WeatherElement` array).
 * @throws ResilienceError on upstream failure, or when the county has no known feed.
 */
export async function fetchNearestWeather(
  lat: number,
  lng: number,
): Promise<CwaLocation> {
  const counties = await fetchDatastore(CWA_COUNTY_RESOURCE_ID);
  const county = nearest(counties, lat, lng).LocationName;

  const resourceId = CWA_COUNTY_RESOURCE_IDS[county];
  if (!resourceId) {
    throw new UpstreamBadPayloadError(
      `No CWA township feed mapped for county ${county}`,
    );
  }

  const districts = await fetchDatastore(resourceId);
  return nearest(districts, lat, lng);
}

function getObservationCoords(
  station: CwaObservationStation,
): { lat: number; lng: number } | null {
  const coords = station.GeoInfo?.Coordinates;
  if (!Array.isArray(coords) || coords.length === 0) return null;
  const wgs84 = coords.find((c) => c.CoordinateName === "WGS84") ?? coords[0];
  if (!wgs84) return null;
  const lat = Number(wgs84.StationLatitude);
  const lng = Number(wgs84.StationLongitude);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  return { lat, lng };
}

export function nearestObservation(
  stations: CwaObservationStation[],
  lat: number,
  lng: number,
): CwaObservationStation {
  let best: CwaObservationStation | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const station of stations) {
    const coords = getObservationCoords(station);
    if (!coords) continue;
    const distance = haversineMeters(lat, lng, coords.lat, coords.lng);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = station;
    }
  }
  if (!best) {
    throw new UpstreamBadPayloadError(
      `CWA datastore ${CWA_OBSERVATION_RESOURCE_ID} contained no stations with valid coordinates`,
    );
  }
  return best;
}

async function fetchObservationDatastore(): Promise<CwaObservationStation[]> {
  const cacheKey = cwaRawCacheKey(CWA_OBSERVATION_RESOURCE_ID);
  const cached = await redisGet(cacheKey);
  if (cached) {
    const parsed = safeJsonParse<CwaObservationStation[]>(cached);
    if (parsed) return parsed;
  }

  const key = process.env.CWA_API_KEY ?? "";
  const url = `${CWA_DATASTORE_BASE_URL}/${CWA_OBSERVATION_RESOURCE_ID}?Authorization=${key}&format=JSON`;

  const stations = await withResilience(CIRCUIT_KEY, async (signal) => {
    const res = await fetch(url, { signal });
    if (!res.ok) throw new UpstreamHttpError(res.status);

    const data = (await res.json()) as CwaObservationResponse;
    const list = data.records?.Station;
    if (!Array.isArray(list) || list.length === 0) {
      throw new UpstreamBadPayloadError(
        `CWA datastore ${CWA_OBSERVATION_RESOURCE_ID} returned no stations`,
      );
    }
    return list;
  });

  await redisSet(cacheKey, JSON.stringify(stations), ENV_CACHE_TTL_SEC.WEATHER);
  return stations;
}

/**
 * Resolves the real-time weather observation `Station` closest to a coordinate
 * from the automatic weather stations dataset (O-A0001-001).
 *
 * @param lat Query latitude.
 * @param lng Query longitude.
 * @returns The raw nearest automatic weather station payload.
 * @throws ResilienceError on upstream failure.
 */
export async function fetchNearestObservation(
  lat: number,
  lng: number,
): Promise<CwaObservationStation> {
  const stations = await fetchObservationDatastore();
  return nearestObservation(stations, lat, lng);
}
