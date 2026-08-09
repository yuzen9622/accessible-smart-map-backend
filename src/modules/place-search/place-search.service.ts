import A11y from "../../model/a11y.model";
import BathroomModel from "../../model/bathroom.model";
import OsmA11y from "../../model/osm-a11y.model";
import DisabledParkingModel from "../../model/disabled-parking.model";
import * as campusService from "../campus/campus.service";
import {
  autocompletePlaces,
  getPlaceDetails,
  type GooglePlaceDetails,
} from "../../adapters/google.adapter";
import { searchOsmPlaces } from "../../adapters/photon.adapter";
import { lookupOsmPlace } from "../../adapters/nominatim.adapter";
import { normalizeOsmTags, type OsmPlace } from "../../types/osm";
import type { PlaceType as ReviewPlaceType } from "../../model/review.model";
import { redisGet, redisSet } from "../../config/redis";
import { haversineMeters } from "../../utils/geo";
import {
  buildGooglePlaceId,
  buildOsmPlaceId,
  facilityLabelOf,
  googleTypesToClassType,
  mapOsmAccessibilityTags,
  normalizeName,
  parsePlaceId,
  toReviewOsmId,
  typeLabelOf,
  type GeoPoint,
  type PlaceSource,
} from "./place-search.types";
import { DEFAULT_LANG, type SupportedLang } from "../../types/lang";

const AC_CACHE_PREFIX = "ps:ac:";
const AC_CACHE_TTL_SEC = 120;
const OSM_SEARCH_CACHE_PREFIX = "ps:osm:";
const OSM_SEARCH_CACHE_TTL_SEC = 300;
const OSM_DETAILS_CACHE_PREFIX = "ps:osmd:";
const OSM_DETAILS_CACHE_TTL_SEC = 600;
const A11Y_NEARBY_RADIUS_M = 50;
const NEARBY_LIST_RADIUS_M = 300;
const NEARBY_LIST_LIMIT = 4;
const DEFAULT_AUTOCOMPLETE_LIMIT = 8;
const PER_SOURCE_LIMIT = 5;
const GOOGLE_ATTRIBUTION = "Powered by Google";
const OSM_ATTRIBUTION = "© OpenStreetMap contributors";

export const ALL_SOURCES: PlaceSource[] = ["osm", "google"];

export interface AutocompleteItem {
  id: string;
  source: PlaceSource;
  primaryText: string;
  secondaryText: string | null;
  placeClass: string | null;
  placeType: string | null;
  typeLabel: string | null;
  location: GeoPoint | null;
  distanceMeters: number | null;
}

export interface PlaceAccessibility {
  status: "accessible" | "limited" | "unknown";
  wheelchair: "yes" | "limited" | "no" | null;
  wheelchairAccess: boolean | null;
  elevator: boolean | null;
  ramp: boolean | null;
  accessibleToilet: boolean | null;
  nearbyFacilityCount: number;
  source: "local-db" | "google" | "osm" | "none";
}

export interface NearbyFacilityBrief {
  id: string;
  name: string;
  address: string | null;
  category: string;
  typeLabel: string;
  distanceMeters: number;
}

export interface PlaceResult {
  id: string;
  source: PlaceSource;
  name: string;
  fullAddress: string | null;
  addressComponents: {
    road: string | null;
    district: string | null;
    city: string | null;
    postcode: string | null;
  };
  location: GeoPoint;
  placeClass: string | null;
  placeType: string | null;
  typeLabel: string | null;
  distanceMeters: number | null;
  rating: number | null;
  accessibility: PlaceAccessibility;
  nearbyFacilities: {
    toilets: NearbyFacilityBrief[];
    metro: NearbyFacilityBrief[];
  };
  reviewKey: { placeId: string; placeType: ReviewPlaceType };
  externalLinks: { osm: string | null; google: string | null };
  attribution: string | null;
}

function makeGeoQuery(lng: number, lat: number, radiusM: number) {
  return {
    $near: {
      $geometry: { type: "Point", coordinates: [lng, lat] },
      $maxDistance: radiusM,
    },
  };
}

/** Coarse coordinate bucket (~1km) so nearby queries share the same cache key. */
function roundCoarse(n?: number): string {
  return Number.isFinite(n) ? (n as number).toFixed(2) : "";
}

function toGeoPoint(latitude: number, longitude: number): GeoPoint {
  return { type: "Point", coordinates: [longitude, latitude] };
}

function distanceFrom(
  lat: number | undefined,
  lng: number | undefined,
  targetLat: number,
  targetLng: number,
): number | null {
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  return Math.round(haversineMeters(lat as number, lng as number, targetLat, targetLng));
}

/** Adds an empty tag map to pre-tags Redis entries while rejecting malformed values. */
function normalizeCachedOsmPlace(value: unknown): OsmPlace | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const place = value as Omit<OsmPlace, "tags"> & { tags?: unknown };
  return { ...place, tags: normalizeOsmTags(place.tags) };
}

/**
 * Nominatim results for a query, behind a longer-lived cache than the merged
 * autocomplete response — OSM data changes slowly and every cache hit is one
 * fewer request against the 1/sec budget the adapter has to respect. The
 * language is part of the key: the same query yields different names per
 * language, so sharing one entry would serve the wrong locale.
 */
async function cachedOsmSearch(
  q: string,
  lang: SupportedLang,
  lat?: number,
  lng?: number,
): Promise<OsmPlace[]> {
  const cacheKey = `${OSM_SEARCH_CACHE_PREFIX}${lang}:${q}:${roundCoarse(lat)}:${roundCoarse(lng)}`;
  const cached = await redisGet(cacheKey);
  if (cached) {
    try {
      const parsed: unknown = JSON.parse(cached);
      if (Array.isArray(parsed)) {
        const places = parsed.map(normalizeCachedOsmPlace);
        if (places.every((place): place is OsmPlace => place !== null)) return places;
      }
    } catch {
      /* treat malformed cache as a miss */
    }
  }
  const places = await searchOsmPlaces(q, {
    latitude: lat,
    longitude: lng,
    limit: PER_SOURCE_LIMIT,
    lang,
  });
  if (places.length > 0) {
    await redisSet(cacheKey, JSON.stringify(places), OSM_SEARCH_CACHE_TTL_SEC);
  }
  return places;
}

function osmToItem(
  place: OsmPlace,
  lang: SupportedLang,
  lat?: number,
  lng?: number,
): AutocompleteItem {
  return {
    id: buildOsmPlaceId(place.osmType, place.osmId),
    source: "osm",
    primaryText: place.name,
    secondaryText: place.displayName || null,
    placeClass: place.placeClass,
    placeType: place.placeType,
    typeLabel: typeLabelOf(place.placeType, lang),
    location: toGeoPoint(place.latitude, place.longitude),
    distanceMeters: distanceFrom(lat, lng, place.latitude, place.longitude),
  };
}

/**
 * Merges the two prediction lists into one ranked, de-duplicated list.
 *
 * Cross-source de-duplication can only compare normalized names: Google's
 * autocomplete carries no coordinates, so there is nothing else to match on.
 * Differently-worded names for one place therefore still yield two entries.
 * When names do collide the OSM entry wins — it has coordinates, a distance and
 * a permalink, and costs nothing.
 */
function mergeItems(
  osmItems: AutocompleteItem[],
  googleItems: AutocompleteItem[],
  q: string,
  limit: number,
): AutocompleteItem[] {
  const seen = new Set<string>();
  const merged: AutocompleteItem[] = [];
  for (const item of [...osmItems, ...googleItems]) {
    const key = normalizeName(item.primaryText);
    if (key === "" || seen.has(key)) continue;
    seen.add(key);
    merged.push(item);
  }

  const prefix = normalizeName(q);
  const rank = (item: AutocompleteItem) => {
    const isPrefix = normalizeName(item.primaryText).startsWith(prefix);
    const sourceRank = item.source === "osm" ? 0 : 1;
    return (isPrefix ? 0 : 2) + sourceRank * 0.5;
  };
  return merged
    .map((item, index) => ({ item, index }))
    .sort((a, b) => rank(a.item) - rank(b.item) || a.index - b.index)
    .slice(0, limit)
    .map((entry) => entry.item);
}

/**
 * Returns place-name predictions for a partial query, merged from OSM and
 * Google. Cheap by design: no coordinate resolution for Google and no
 * accessibility lookup for either source. Short-TTL Redis cache keyed on the
 * enabled sources plus language, query and coarse coordinates (session token is
 * intentionally excluded — predictions are token-independent). Each source
 * degrades independently, so one failing upstream never empties the response.
 *
 * @param params Query text, optional session token, bias coordinates, source filter, cap and language.
 * @returns The predicted places.
 */
export async function autocomplete(params: {
  q: string;
  sessionToken?: string;
  lat?: number;
  lng?: number;
  sources?: PlaceSource[];
  limit?: number;
  lang?: SupportedLang;
}): Promise<AutocompleteItem[]> {
  const { q, sessionToken, lat, lng } = params;
  const sources = params.sources?.length ? params.sources : ALL_SOURCES;
  const limit = params.limit ?? DEFAULT_AUTOCOMPLETE_LIMIT;
  const lang = params.lang ?? DEFAULT_LANG;
  const cacheKey = `${AC_CACHE_PREFIX}${lang}:${[...sources].sort().join(",")}:${limit}:${q}:${roundCoarse(lat)}:${roundCoarse(lng)}`;

  const cached = await redisGet(cacheKey);
  if (cached) {
    try {
      return JSON.parse(cached) as AutocompleteItem[];
    } catch {
      /* treat malformed cache as a miss */
    }
  }

  const [osmResult, googleResult] = await Promise.allSettled([
    sources.includes("osm") ? cachedOsmSearch(q, lang, lat, lng) : Promise.resolve([]),
    sources.includes("google")
      ? autocompletePlaces(q, { sessionToken, latitude: lat, longitude: lng, lang })
      : Promise.resolve([]),
  ]);

  const osmItems =
    osmResult.status === "fulfilled"
      ? osmResult.value.map((p) => osmToItem(p, lang, lat, lng))
      : [];
  const googleItems: AutocompleteItem[] =
    googleResult.status === "fulfilled"
      ? googleResult.value.slice(0, PER_SOURCE_LIMIT).map((s) => ({
          id: buildGooglePlaceId(s.placeId),
          source: "google" as const,
          primaryText: s.primaryText,
          secondaryText: s.secondaryText,
          placeClass: null,
          placeType: null,
          typeLabel: null,
          location: null,
          distanceMeters: null,
        }))
      : [];

  const items = mergeItems(osmItems, googleItems, q, limit);
  await redisSet(cacheKey, JSON.stringify(items), AC_CACHE_TTL_SEC);
  return items;
}

/** Counts local accessibility facilities within the given radius of a point. */
async function countNearbyFacilities(lat: number, lng: number): Promise<number> {
  const geoQuery = makeGeoQuery(lng, lat, A11Y_NEARBY_RADIUS_M);
  const [metro, osm, bathroom, parking, campus] = await Promise.all([
    A11y.find({ location: geoQuery }).lean().catch(() => []),
    OsmA11y.find({ location: geoQuery }).lean().catch(() => []),
    BathroomModel.find({ type: "無障礙廁所", location: geoQuery }).lean().catch(() => []),
    DisabledParkingModel.find({ location: geoQuery }).lean().catch(() => []),
    campusService.findFacilitiesNearby(lat, lng, A11Y_NEARBY_RADIUS_M).catch(() => []),
  ]);
  return metro.length + osm.length + bathroom.length + parking.length + campus.length;
}

/** Classifies a metro facility name the way the a11y module does. */
function metroCategory(name: string): string {
  if (name.includes("電梯")) return "elevator";
  if (name.includes("坡道")) return "ramp";
  return "other";
}

function coordsOf(doc: { location?: { coordinates?: number[] } }): [number, number] | null {
  const coordinates = doc.location?.coordinates;
  if (!coordinates || coordinates.length < 2) return null;
  const [lng, lat] = coordinates;
  return Number.isFinite(lat) && Number.isFinite(lng) ? [lat, lng] : null;
}

/**
 * The nearby accessible toilets and metro entrance facilities a place detail
 * card renders. `a11y.service` has no reusable equivalent — its `findNearby*`
 * helpers cap toilets at five and blend three sources into their metro bucket —
 * so these are dedicated queries returning exactly the shape the card needs.
 *
 * Only the category labels follow the requested language — the `name` and
 * `address` fields come from local datasets that exist in Chinese only.
 */
async function findNearbyFacilities(
  lat: number,
  lng: number,
  lang: SupportedLang,
): Promise<{ toilets: NearbyFacilityBrief[]; metro: NearbyFacilityBrief[] }> {
  const geoQuery = makeGeoQuery(lng, lat, NEARBY_LIST_RADIUS_M);
  const [bathrooms, osmToilets, metro] = await Promise.all([
    BathroomModel.find({ type: "無障礙廁所", location: geoQuery })
      .limit(NEARBY_LIST_LIMIT)
      .lean()
      .catch(() => []),
    OsmA11y.find({ category: "toilet", location: geoQuery })
      .limit(NEARBY_LIST_LIMIT)
      .lean()
      .catch(() => []),
    A11y.find({ location: geoQuery })
      .limit(NEARBY_LIST_LIMIT)
      .lean()
      .catch(() => []),
  ]);

  const toBrief = (
    id: string,
    name: string,
    address: string | null,
    category: string,
    typeLabel: string,
    doc: { location?: { coordinates?: number[] } },
  ): NearbyFacilityBrief | null => {
    const coords = coordsOf(doc);
    if (!coords) return null;
    return {
      id,
      name,
      address,
      category,
      typeLabel,
      distanceMeters: Math.round(haversineMeters(lat, lng, coords[0], coords[1])),
    };
  };

  const toiletLabel = facilityLabelOf("toilet", lang);
  const toilets = [
    ...bathrooms.map((doc: any) =>
      toBrief(String(doc._id), doc.name, doc.address ?? null, "toilet", toiletLabel, doc),
    ),
    ...osmToilets.map((doc: any) =>
      toBrief(String(doc._id), doc.name ?? toiletLabel, null, "toilet", toiletLabel, doc),
    ),
  ]
    .filter((brief): brief is NearbyFacilityBrief => brief !== null)
    .sort((a, b) => a.distanceMeters - b.distanceMeters)
    .slice(0, NEARBY_LIST_LIMIT);

  const metroBriefs = metro
    .map((doc: any) => {
      const rawName = doc["出入口電梯/無障礙坡道名稱"];
      const name = rawName ?? facilityLabelOf("metro", lang);
      const category = metroCategory(rawName ?? "");
      return toBrief(String(doc._id), name, null, category, facilityLabelOf(category, lang), doc);
    })
    .filter((brief): brief is NearbyFacilityBrief => brief !== null)
    .sort((a, b) => a.distanceMeters - b.distanceMeters)
    .slice(0, NEARBY_LIST_LIMIT);

  return { toilets, metro: metroBriefs };
}

interface PlaceAccessibilitySignals {
  source: "google" | "osm";
  wheelchair: PlaceAccessibility["wheelchair"];
  wheelchairAccess: boolean | null;
  elevator: boolean | null;
  ramp: boolean | null;
  accessibleToilet: boolean | null;
  wheelchairPartial: boolean;
}

/**
 * Derives the badge only from evidence explicitly attached to this place.
 * Nearby records remain useful for display, but are never evidence that the
 * place itself is accessible.
 */
async function computeAccessibility(
  lat: number,
  lng: number,
  signals: PlaceAccessibilitySignals,
): Promise<PlaceAccessibility> {
  const nearbyFacilityCount = await countNearbyFacilities(lat, lng);
  const hasOwnSignal =
    signals.wheelchairPartial ||
    [
      signals.wheelchairAccess,
      signals.elevator,
      signals.ramp,
      signals.accessibleToilet,
    ].some((value) => value !== null);
  const status =
    signals.wheelchairAccess === true
      ? "accessible"
      : signals.wheelchairPartial
        ? "limited"
        : "unknown";
  const wheelchair =
    signals.wheelchairAccess === true
      ? "yes"
      : signals.wheelchairPartial
        ? "limited"
        : signals.wheelchair;

  return {
    status,
    wheelchair,
    wheelchairAccess: signals.wheelchairAccess,
    elevator: signals.elevator,
    ramp: signals.ramp,
    accessibleToilet: signals.accessibleToilet,
    nearbyFacilityCount,
    source: hasOwnSignal ? signals.source : "none",
  };
}

type ResolvedPlace = Omit<PlaceResult, "accessibility" | "nearbyFacilities" | "distanceMeters">;

function googleToResolved(
  id: string,
  d: GooglePlaceDetails & { location: { latitude: number; longitude: number } },
  lang: SupportedLang,
): ResolvedPlace {
  const { placeClass, placeType } = googleTypesToClassType(d.types);
  return {
    id,
    source: "google",
    name: d.name,
    fullAddress: d.formattedAddress,
    addressComponents: d.addressComponents,
    location: toGeoPoint(d.location.latitude, d.location.longitude),
    placeClass,
    placeType,
    typeLabel: typeLabelOf(placeType, lang),
    rating: d.rating,
    reviewKey: { placeId: d.id, placeType: "google" },
    externalLinks: {
      osm: null,
      google: `https://www.google.com/maps/place/?q=place_id:${encodeURIComponent(d.id)}`,
    },
    attribution: GOOGLE_ATTRIBUTION,
  };
}

function osmToResolved(id: string, p: OsmPlace, lang: SupportedLang): ResolvedPlace {
  return {
    id,
    source: "osm",
    name: p.name,
    fullAddress: p.displayName || null,
    addressComponents: p.address,
    location: toGeoPoint(p.latitude, p.longitude),
    placeClass: p.placeClass,
    placeType: p.placeType,
    typeLabel: typeLabelOf(p.placeType, lang),
    rating: null,
    reviewKey: { placeId: toReviewOsmId(p.osmType, p.osmId), placeType: "osm" },
    externalLinks: {
      osm: `https://www.openstreetmap.org/${p.osmType}/${p.osmId}`,
      google: null,
    },
    attribution: OSM_ATTRIBUTION,
  };
}

/** OSM place lookups are cacheable — unlike Google's, their terms permit it. */
async function cachedOsmLookup(
  osmType: OsmPlace["osmType"],
  osmId: string,
  lang: SupportedLang,
): Promise<OsmPlace | null> {
  const cacheKey = `${OSM_DETAILS_CACHE_PREFIX}${lang}:${osmType}:${osmId}`;
  const cached = await redisGet(cacheKey);
  if (cached) {
    try {
      const place = normalizeCachedOsmPlace(JSON.parse(cached) as unknown);
      if (place) return place;
    } catch {
      /* treat malformed cache as a miss */
    }
  }
  const place = await lookupOsmPlace(osmType, osmId, { lang });
  if (place) await redisSet(cacheKey, JSON.stringify(place), OSM_DETAILS_CACHE_TTL_SEC);
  return place;
}

/**
 * Resolves a selected place id to a full PlaceResult: coordinates, distance from
 * the user, the accessibility badge and the nearby-facility lists. Dispatches on
 * the id prefix, so an OSM place never touches Google and never consumes the
 * autocomplete session token. Returns null when the place is unresolvable or has
 * no usable coordinates (controller → 404).
 *
 * Google results are deliberately not cached — their terms disallow persisting
 * anything but the place id.
 *
 * @param params Prefixed place id, optional session token, optional user coordinates and language.
 * @returns The resolved place, or null.
 */
export async function details(params: {
  id: string;
  sessionToken?: string;
  lat?: number;
  lng?: number;
  lang?: SupportedLang;
}): Promise<PlaceResult | null> {
  const { id, sessionToken, lat, lng } = params;
  const lang = params.lang ?? DEFAULT_LANG;
  const parsed = parsePlaceId(id);
  if (!parsed) return null;

  let resolved: ResolvedPlace;
  let accessibilitySignals: PlaceAccessibilitySignals;

  if (parsed.source === "google") {
    const d = await getPlaceDetails(parsed.googlePlaceId, { sessionToken, lang });
    if (!d || !d.location) return null;
    resolved = googleToResolved(
      id,
      d as GooglePlaceDetails & { location: { latitude: number; longitude: number } },
      lang,
    );
    const wheelchairAccess = d.wheelchairAccessibleEntrance ?? null;
    const accessibleToilet = d.wheelchairAccessibleRestroom ?? null;
    accessibilitySignals = {
      source: "google",
      wheelchair: d.wheelchair,
      wheelchairAccess,
      elevator: null,
      ramp: null,
      accessibleToilet,
      wheelchairPartial: d.wheelchairPartial,
    };
  } else {
    const p = await cachedOsmLookup(parsed.osmType, parsed.osmId, lang);
    if (!p) return null;
    resolved = osmToResolved(id, p, lang);
    const osmAccessibility = mapOsmAccessibilityTags(p.tags, p.placeClass, p.placeType);
    accessibilitySignals = {
      source: "osm",
      ...osmAccessibility,
      wheelchairPartial: osmAccessibility.wheelchair === "limited",
    };
  }

  const [placeLng, placeLat] = resolved.location.coordinates;
  const [accessibility, nearbyFacilities] = await Promise.all([
    computeAccessibility(placeLat, placeLng, accessibilitySignals),
    findNearbyFacilities(placeLat, placeLng, lang),
  ]);

  return {
    ...resolved,
    distanceMeters: distanceFrom(lat, lng, placeLat, placeLng),
    accessibility,
    nearbyFacilities,
  };
}
