import axios from "axios";
import {
  OSM_TYPE_BY_PREFIX,
  firstOsmValue,
  type OsmAddress,
  type OsmPlace,
} from "../types/osm";
import { normalizePlaceName } from "../utils/place-name";

const BASE_URL = () => process.env.PHOTON_BASE_URL ?? "https://photon.komoot.io";
const REQUEST_TIMEOUT_MS = 2000;
const DEFAULT_LIMIT = 5;
const COUNTRY_CODE = "TW";
const OVERFETCH_FACTOR = 3;

/**
 * Assembles a Taiwanese-order address line from Photon's separate fields.
 * Photon has no `display_name` equivalent, and the local convention runs
 * largest unit first: 臺北市信義區信義路五段7號.
 */
function toDisplayName(p: Record<string, unknown>, name: string): string {
  const city = firstOsmValue(p.city, p.county, p.state);
  const district = firstOsmValue(p.district, p.locality);
  const street = firstOsmValue(p.street);
  const housenumber = firstOsmValue(p.housenumber);
  const streetLine = street && housenumber ? `${street}${housenumber}號` : street;
  const line = [city, district, streetLine].filter(Boolean).join("");
  return line || name;
}

function toAddress(p: Record<string, unknown>): OsmAddress {
  return {
    road: firstOsmValue(p.street),
    district: firstOsmValue(p.district, p.locality),
    city: firstOsmValue(p.city, p.county, p.state),
    postcode: firstOsmValue(p.postcode),
  };
}

function toOsmPlace(feature: any): OsmPlace | null {
  const p = feature?.properties;
  if (!p) return null;

  const osmType = OSM_TYPE_BY_PREFIX[String(p.osm_type ?? "").toUpperCase()];
  if (!osmType || p.osm_id === undefined || p.osm_id === null) return null;

  const coordinates = feature?.geometry?.coordinates;
  const longitude = Number(coordinates?.[0]);
  const latitude = Number(coordinates?.[1]);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;

  const name = firstOsmValue(p.name, p.street, p.district, p.city);
  if (!name) return null;

  return {
    osmType,
    osmId: String(p.osm_id),
    name,
    displayName: toDisplayName(p, name),
    latitude,
    longitude,
    placeClass: firstOsmValue(p.osm_key),
    placeType: firstOsmValue(p.osm_value),
    address: toAddress(p),
  };
}

/**
 * Type-ahead place search over OpenStreetMap data.
 *
 * Photon rather than Nominatim because Nominatim's /search matches whole tokens
 * only — "台北1" never reaches "台北101" there, which is exactly the state a
 * search box spends most of its time in. Photon indexes the same OSM objects
 * for prefix matching and returns the same osm_type/osm_id, so ids stay
 * interchangeable with the Nominatim lookup used for details.
 *
 * Unlike Nominatim there is no published hard request rate, so no global
 * throttle is applied here; the per-IP limiter and the Redis cache in the
 * calling service are the controls. Returns an empty array on any failure —
 * this source is always a supplement, never the reason a search fails.
 *
 * Photon's index is global and its public API has no country parameter, so
 * results are filtered on the countrycode each feature carries — without it
 * "市政府站" returns a bus stop in Xiamen and "台北101" two places in Japan.
 * The request over-fetches to keep the caller's limit reachable after filtering,
 * and collapses name repeats — one landmark routinely appears three or four
 * times in the index (the building, the station, the mall) and would otherwise
 * consume the whole result slot. Repeats are matched on the same normalized key
 * the caller de-duplicates with, so no slot is spent on a near-duplicate that
 * would be dropped downstream anyway.
 *
 * @param query Partial free-text query typed by the user.
 * @param opts Result cap and optional bias coordinates.
 * @returns The matching OSM places within Taiwan.
 */
export async function searchOsmPlaces(
  query: string,
  opts: { latitude?: number; longitude?: number; limit?: number } = {},
): Promise<OsmPlace[]> {
  const limit = Math.max(0, Math.trunc(opts.limit ?? DEFAULT_LIMIT));
  if (limit === 0) return [];

  const params: Record<string, string | number> = {
    q: query,
    limit: limit * OVERFETCH_FACTOR,
    lang: "default",
  };
  if (Number.isFinite(opts.latitude) && Number.isFinite(opts.longitude)) {
    params.lat = opts.latitude as number;
    params.lon = opts.longitude as number;
  }

  try {
    const response = await axios.get(`${BASE_URL()}/api/`, {
      params,
      timeout: REQUEST_TIMEOUT_MS,
    });
    const features = response.data?.features;
    if (!Array.isArray(features)) return [];

    const places = features
      .filter((f: any) => f?.properties?.countrycode === COUNTRY_CODE)
      .map(toOsmPlace)
      .filter((place): place is OsmPlace => place !== null);

    const seen = new Set<string>();
    const distinct: OsmPlace[] = [];
    for (const place of places) {
      const key = normalizePlaceName(place.name);
      if (seen.has(key)) continue;
      seen.add(key);
      distinct.push(place);
      if (distinct.length >= limit) break;
    }
    return distinct;
  } catch {
    return [];
  }
}
