import axios from "axios";
import { DEFAULT_LANG, type SupportedLang } from "../types/lang";

const MAPS_KEY = () => process.env.GOOGLE_MAPS_API_KEY ?? "";

/**
 * Bounded LRU cache with expiry.
 *
 * Geocoding results are keyed by arbitrary client-supplied coordinates or
 * addresses, so an unbounded Map would grow forever (memory DoS). Both the
 * entry count and the lifetime are capped; eviction is LRU.
 */
class TtlLruCache<V> {
  private map = new Map<string, { value: V; expiresAt: number }>();

  constructor(
    private readonly maxSize: number,
    private readonly ttlMs: number,
  ) {}

  get(key: string): V | undefined {
    const entry = this.map.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt < Date.now()) {
      this.map.delete(key);
      return undefined;
    }
    // Refresh recency so frequently used entries survive eviction.
    this.map.delete(key);
    this.map.set(key, entry);
    return entry.value;
  }

  set(key: string, value: V): void {
    if (this.map.has(key)) this.map.delete(key);
    this.map.set(key, { value, expiresAt: Date.now() + this.ttlMs });
    if (this.map.size > this.maxSize) {
      const oldest = this.map.keys().next().value;
      if (oldest !== undefined) this.map.delete(oldest);
    }
  }
}

const GEOCODE_CACHE_MAX = 5000;
const GEOCODE_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

const cityCache = new TtlLruCache<string>(
  GEOCODE_CACHE_MAX,
  GEOCODE_CACHE_TTL_MS,
);
const cityZhCache = new TtlLruCache<string>(
  GEOCODE_CACHE_MAX,
  GEOCODE_CACHE_TTL_MS,
);
const coordsCache = new TtlLruCache<{
  latitude: number;
  longitude: number;
} | null>(GEOCODE_CACHE_MAX, GEOCODE_CACHE_TTL_MS);

/**
 * Returns the English-style administrative area name used by TDX
 * (e.g. "Taipei", "NewTaipei", "Taichung").
 *
 * @param lat Latitude
 * @param lng Longitude
 * @returns The TDX-style city name
 */
export async function getCity(lat: number, lng: number): Promise<string> {
  const key = `${lat.toFixed(4)},${lng.toFixed(4)}`;
  const hit = cityCache.get(key);
  if (hit) return hit;

  const geocode = await fetch(
    `https://maps.googleapis.com/maps/api/geocode/json?latlng=${lat},${lng}&key=${MAPS_KEY()}`,
  );
  const data = (await geocode.json()) as any;
  if (!data.results || data.results.length === 0) {
    throw new Error(`Geocoding failed: ${data.status ?? "NO_RESULTS"}`);
  }
  const result = data.results[0].address_components
    .find((c: any) => c.types.includes("administrative_area_level_1"))
    ?.long_name.replace("City", "")
    .replace(" ", "") as string;

  if (result) {
    cityCache.set(key, result);
  }
  return result;
}

/**
 * Returns the Chinese city name used by STA air-quality API
 * (e.g. "臺北市", "臺中市").
 *
 * @param lat Latitude
 * @param lng Longitude
 * @returns The Chinese city name
 */
export async function getCityZh(lat: number, lng: number): Promise<string> {
  const key = `${lat.toFixed(4)},${lng.toFixed(4)}`;
  const hit = cityZhCache.get(key);
  if (hit) return hit;

  const geocode = await fetch(
    `https://maps.googleapis.com/maps/api/geocode/json?latlng=${lat},${lng}&key=${MAPS_KEY()}&language=zh-TW`,
  );
  const data = (await geocode.json()) as any;
  let city = "臺北市";
  const cityComp = data?.results?.[0]?.address_components?.find((c: any) =>
    c.types.includes("administrative_area_level_1"),
  );
  if (cityComp) city = (cityComp.long_name as string).replace("台", "臺");

  cityZhCache.set(key, city);
  return city;
}

/**
 * Resolves a free-text query to coordinates via Google Places Text Search.
 * Returns null when the query matches no places or the API key is missing.
 *
 * @param query Free-text place query
 * @param latitude Optional bias latitude
 * @param longitude Optional bias longitude
 * @returns The matched coordinates, or null
 */
export async function getCoordinates(
  query: string,
  latitude?: number,
  longitude?: number,
): Promise<{ latitude: number; longitude: number } | null> {
  const trimmed = query.trim().toLowerCase();
  const cacheKey =
    latitude && longitude
      ? `${trimmed}|${latitude.toFixed(3)},${longitude.toFixed(3)}`
      : trimmed;

  const hit = coordsCache.get(cacheKey);
  if (hit !== undefined) {
    return hit;
  }

  if (!MAPS_KEY()) return null;

  const body: Record<string, unknown> = {
    textQuery: query,
    maxResultCount: 1,
    regionCode: "TW",
  };
  if (latitude && longitude) {
    body.locationBias = {
      circle: { center: { latitude, longitude }, radius: 50000.0 },
    };
  }

  try {
    const response = await axios.post(
      "https://places.googleapis.com/v1/places:searchText",
      body,
      {
        headers: {
          "Content-Type": "application/json",
          "X-Goog-Api-Key": MAPS_KEY(),
          "X-Goog-FieldMask": "places.location",
        },
      },
    );
    const result = response.data.places?.[0]?.location ?? null;
    coordsCache.set(cacheKey, result);
    return result;
  } catch {
    coordsCache.set(cacheKey, null);
    return null;
  }
}

export interface GooglePlace {
  name: string;
  place_id: string;
  formatted_address: string;
  rating?: number;
  location: { latitude: number; longitude: number };
  distanceMeters?: number;
}

function haversineDistanceMeters(
  from: { latitude: number; longitude: number },
  to: { latitude: number; longitude: number },
): number {
  const earthRadiusM = 6_371_000;
  const toRadians = (degrees: number): number => (degrees * Math.PI) / 180;
  const deltaLat = toRadians(to.latitude - from.latitude);
  const deltaLng = toRadians(to.longitude - from.longitude);
  const fromLat = toRadians(from.latitude);
  const toLat = toRadians(to.latitude);
  const a =
    Math.sin(deltaLat / 2) ** 2 +
    Math.cos(fromLat) * Math.cos(toLat) * Math.sin(deltaLng / 2) ** 2;
  return 2 * earthRadiusM * Math.asin(Math.sqrt(Math.min(1, Math.max(0, a))));
}

function hasValidLocation(place: GooglePlace): place is GooglePlace & {
  location: { latitude: number; longitude: number };
} {
  const { latitude, longitude } = place.location ?? {};
  return (
    typeof latitude === "number" &&
    Number.isFinite(latitude) &&
    latitude >= -90 &&
    latitude <= 90 &&
    typeof longitude === "number" &&
    Number.isFinite(longitude) &&
    longitude >= -180 &&
    longitude <= 180
  );
}

/**
 * Searches for up to `maxResults` places matching the query, optionally biased
 * toward the given coordinates.
 *
 * @param query Free-text place query
 * @param opts Optional bias coordinates and result limit
 * @returns The matched places
 */
export async function searchPlaces(
  query: string,
  opts: {
    latitude?: number;
    longitude?: number;
    maxResults?: number;
    sortByDistance?: boolean;
  } = {},
): Promise<GooglePlace[]> {
  const key = MAPS_KEY();
  if (!key) return [];

  const body: Record<string, unknown> = {
    textQuery: query,
    languageCode: "zh-TW",
    maxResultCount: opts.sortByDistance ? 10 : (opts.maxResults ?? 3),
  };
  if (opts.latitude !== undefined && opts.longitude !== undefined) {
    body.locationBias = {
      circle: {
        center: { latitude: opts.latitude, longitude: opts.longitude },
        radius: 1000.0,
      },
    };
  }

  try {
    const response = await axios.post(
      "https://places.googleapis.com/v1/places:searchText",
      body,
      {
        headers: {
          "Content-Type": "application/json",
          "X-Goog-Api-Key": key,
          "X-Goog-FieldMask":
            "places.id,places.displayName,places.formattedAddress,places.rating,places.location",
        },
      },
    );
    const { places } = response.data;
    if (!places?.length) return [];
    const mapped: GooglePlace[] = places.map((p: any) => ({
      name: p.displayName?.text ?? "未知名稱",
      place_id: p.id,
      formatted_address: p.formattedAddress,
      rating: p.rating,
      location: p.location,
    }));
    if (
      opts.sortByDistance &&
      opts.latitude !== undefined &&
      opts.longitude !== undefined
    ) {
      const origin = { latitude: opts.latitude, longitude: opts.longitude };
      return mapped
        .filter(hasValidLocation)
        .map((place) => ({
          ...place,
          distanceMeters: Math.round(
            haversineDistanceMeters(origin, place.location),
          ),
        }))
        .sort(
          (a, b) =>
            (a.distanceMeters ?? Infinity) - (b.distanceMeters ?? Infinity),
        )
        .slice(0, opts.maxResults ?? 3);
    }
    return mapped;
  } catch {
    return [];
  }
}

export interface AutocompleteSuggestion {
  placeId: string;
  primaryText: string;
  secondaryText: string | null;
}

/**
 * Fetches Places Autocomplete predictions for a partial query, bound to a
 * client session token for combined-session billing. Returns an empty array on
 * any failure or when the API key is missing.
 *
 * @param input Partial free-text query typed by the user.
 * @param opts Session token, optional bias coordinates and response language.
 * @returns The predicted places (place predictions only; query predictions dropped).
 */
export async function autocompletePlaces(
  input: string,
  opts: {
    sessionToken?: string;
    latitude?: number;
    longitude?: number;
    lang?: SupportedLang;
  } = {},
): Promise<AutocompleteSuggestion[]> {
  const key = MAPS_KEY();
  if (!key) return [];

  const body: Record<string, unknown> = {
    input,
    languageCode: opts.lang ?? DEFAULT_LANG,
    regionCode: "TW",
  };
  if (opts.sessionToken) body.sessionToken = opts.sessionToken;
  if (Number.isFinite(opts.latitude) && Number.isFinite(opts.longitude)) {
    const center = { latitude: opts.latitude, longitude: opts.longitude };
    body.locationBias = { circle: { center, radius: 30000.0 } };
    body.origin = center;
  }

  try {
    const response = await axios.post(
      "https://places.googleapis.com/v1/places:autocomplete",
      body,
      {
        headers: { "Content-Type": "application/json", "X-Goog-Api-Key": key },
      },
    );
    const suggestions = response.data?.suggestions;
    if (!Array.isArray(suggestions)) return [];
    return suggestions
      .map((s: any) => s?.placePrediction)
      .filter((p: any) => p?.placeId)
      .map((p: any) => ({
        placeId: p.placeId as string,
        primaryText: (p.structuredFormat?.mainText?.text ??
          p.text?.text ??
          "") as string,
        secondaryText: (p.structuredFormat?.secondaryText?.text ?? null) as
          string | null,
      }));
  } catch {
    return [];
  }
}

export interface GoogleAddressComponents {
  road: string | null;
  district: string | null;
  city: string | null;
  postcode: string | null;
}

export interface GooglePlaceDetails {
  id: string;
  name: string;
  formattedAddress: string | null;
  location: { latitude: number; longitude: number } | null;
  rating: number | null;
  wheelchair: "yes" | "no" | null;
  wheelchairPartial: boolean;
  wheelchairAccessibleEntrance: boolean | null;
  wheelchairAccessibleRestroom: boolean | null;
  types: string[];
  addressComponents: GoogleAddressComponents;
}

/**
 * Reduces Google's addressComponents array to the four parts the UI renders.
 * Taiwanese addresses put the city at administrative_area_level_1 and the
 * district at level_3, but coverage varies, so each slot falls back through the
 * neighbouring component types rather than assuming one shape.
 */
function toAddressComponents(raw: unknown): GoogleAddressComponents {
  const components = Array.isArray(raw) ? raw : [];
  const pick = (...wanted: string[]): string | null => {
    for (const type of wanted) {
      const hit = components.find(
        (c: any) => Array.isArray(c?.types) && c.types.includes(type),
      );
      const text = hit?.longText ?? hit?.shortText;
      if (typeof text === "string" && text.trim() !== "") return text;
    }
    return null;
  };
  return {
    road: pick("route", "street_address"),
    district: pick(
      "administrative_area_level_3",
      "administrative_area_level_2",
      "sublocality_level_1",
      "sublocality",
    ),
    city: pick("administrative_area_level_1", "locality"),
    postcode: pick("postal_code"),
  };
}

/**
 * Fetches Place Details for a place id, closing the autocomplete session when a
 * session token is supplied. Returns null on any failure, missing key, or when
 * the place has no usable coordinates.
 *
 * @param placeId The Google place id to resolve.
 * @param opts Session token to bind billing to the preceding autocomplete calls, and response language.
 * @returns The place details, or null.
 */
export async function getPlaceDetails(
  placeId: string,
  opts: { sessionToken?: string; lang?: SupportedLang } = {},
): Promise<GooglePlaceDetails | null> {
  const key = MAPS_KEY();
  if (!key) return null;

  const params: Record<string, string> = {
    languageCode: opts.lang ?? DEFAULT_LANG,
  };
  if (opts.sessionToken) params.sessionToken = opts.sessionToken;

  try {
    const response = await axios.get(
      `https://places.googleapis.com/v1/places/${encodeURIComponent(placeId)}`,
      {
        params,
        headers: {
          "X-Goog-Api-Key": key,
          "X-Goog-FieldMask":
            "id,displayName,formattedAddress,location,rating,accessibilityOptions,types,addressComponents",
        },
      },
    );
    const p = response.data;
    if (!p?.id) return null;

    const rawLocation = p.location;
    const location =
      Number.isFinite(rawLocation?.latitude) &&
      Number.isFinite(rawLocation?.longitude)
        ? {
            latitude: rawLocation.latitude as number,
            longitude: rawLocation.longitude as number,
          }
        : null;

    const rawAccessibilityOptions = p.accessibilityOptions;
    const a11y =
      rawAccessibilityOptions && typeof rawAccessibilityOptions === "object"
        ? (rawAccessibilityOptions as Record<string, unknown>)
        : {};
    const wheelchairAccessibleEntrance =
      typeof a11y.wheelchairAccessibleEntrance === "boolean"
        ? a11y.wheelchairAccessibleEntrance
        : null;
    const wheelchairAccessibleRestroom =
      typeof a11y.wheelchairAccessibleRestroom === "boolean"
        ? a11y.wheelchairAccessibleRestroom
        : null;
    const wheelchair =
      wheelchairAccessibleEntrance === true
        ? "yes"
        : wheelchairAccessibleEntrance === false
          ? "no"
          : null;
    const wheelchairPartial =
      wheelchairAccessibleEntrance !== true &&
      (a11y.wheelchairAccessibleParking === true ||
        wheelchairAccessibleRestroom === true ||
        a11y.wheelchairAccessibleSeating === true);

    return {
      id: p.id as string,
      name: (p.displayName?.text ?? "未知名稱") as string,
      formattedAddress: (p.formattedAddress ?? null) as string | null,
      location,
      rating: typeof p.rating === "number" ? p.rating : null,
      wheelchair,
      wheelchairPartial,
      wheelchairAccessibleEntrance,
      wheelchairAccessibleRestroom,
      types: Array.isArray(p.types) ? (p.types as string[]) : [],
      addressComponents: toAddressComponents(p.addressComponents),
    };
  } catch {
    return null;
  }
}
