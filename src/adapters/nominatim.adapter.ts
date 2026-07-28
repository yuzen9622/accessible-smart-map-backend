import axios from "axios";
import {
  PREFIX_BY_OSM_TYPE,
  OSM_TYPE_BY_PREFIX,
  firstOsmValue,
  type OsmAddress,
  type OsmPlace,
  type OsmType,
} from "../types/osm";
import { DEFAULT_LANG, type SupportedLang } from "../types/lang";

const BASE_URL = () => process.env.NOMINATIM_BASE_URL ?? "https://nominatim.openstreetmap.org";
const USER_AGENT = () =>
  process.env.NOMINATIM_USER_AGENT ?? "taipei-accessible-backend (contact: unset)";

const MIN_INTERVAL_MS = 1000;
const MAX_QUEUE_WAIT_MS = 2000;
const REQUEST_TIMEOUT_MS = 2000;

let nextSlotAt = 0;

/**
 * Reserves the next slot in the global 1-request-per-second window Nominatim's
 * usage policy demands. Serving this call from the backend concentrates what
 * used to be per-user traffic onto one IP, so the throttle is what keeps us
 * compliant — the per-IP rate limiter protects a different thing entirely.
 *
 * @returns True once the slot is due, or false when the wait would exceed
 * MAX_QUEUE_WAIT_MS and the caller should give up instead of stalling a request.
 */
async function awaitSlot(): Promise<boolean> {
  const now = Date.now();
  const slot = Math.max(now, nextSlotAt);
  if (slot - now > MAX_QUEUE_WAIT_MS) return false;
  nextSlotAt = slot + MIN_INTERVAL_MS;
  const wait = slot - now;
  if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
  return true;
}

function toAddress(raw: Record<string, unknown> | undefined): OsmAddress {
  const a = raw ?? {};
  return {
    road: firstOsmValue(a.road, a.pedestrian, a.footway),
    district: firstOsmValue(a.suburb, a.neighbourhood, a.city_district, a.district),
    city: firstOsmValue(a.city, a.town, a.county, a.state),
    postcode: firstOsmValue(a.postcode),
  };
}

function toOsmPlace(raw: any): OsmPlace | null {
  const osmType = raw?.osm_type as OsmType | undefined;
  const osmId = raw?.osm_id;
  if (!osmType || !PREFIX_BY_OSM_TYPE[osmType] || osmId === undefined || osmId === null) return null;

  const latitude = Number(raw.lat);
  const longitude = Number(raw.lon);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;

  const displayName = typeof raw.display_name === "string" ? raw.display_name : "";
  const name =
    firstOsmValue(raw.name, raw.address?.[raw.type], displayName.split(",")[0]) ?? displayName;
  if (!name) return null;

  return {
    osmType,
    osmId: String(osmId),
    name,
    displayName,
    latitude,
    longitude,
    placeClass: firstOsmValue(raw.class, raw.category),
    placeType: firstOsmValue(raw.type),
    address: toAddress(raw.address),
  };
}

/**
 * Converts our internal `<type>/<id>` reference into the single-letter form
 * Nominatim's lookup endpoint expects (e.g. "node/123" → "N123").
 */
export function toOsmLookupId(osmType: OsmType, osmId: string): string {
  return `${PREFIX_BY_OSM_TYPE[osmType]}${osmId}`;
}

/** Parses a Nominatim lookup id such as "N123" back into its parts. */
export function parseOsmLookupId(value: string): { osmType: OsmType; osmId: string } | null {
  const osmType = OSM_TYPE_BY_PREFIX[value.charAt(0).toUpperCase()];
  const osmId = value.slice(1);
  if (!osmType || !/^\d+$/.test(osmId)) return null;
  return { osmType, osmId };
}

/**
 * Resolves a single OSM object to its full record. Nominatim owns this half of
 * the OSM integration — it returns the canonical display name and structured
 * address that Photon's search index only partially carries. Returns null on
 * any failure, so the caller can answer 404 rather than surface a transport
 * error.
 *
 * @param osmType The OSM object type.
 * @param osmId The numeric OSM id as a string.
 * @param opts Response language.
 * @returns The place, or null.
 */
export async function lookupOsmPlace(
  osmType: OsmType,
  osmId: string,
  opts: { lang?: SupportedLang } = {},
): Promise<OsmPlace | null> {
  if (!(await awaitSlot())) return null;

  try {
    const response = await axios.get(`${BASE_URL()}/lookup`, {
      params: {
        osm_ids: toOsmLookupId(osmType, osmId),
        format: "jsonv2",
        addressdetails: 1,
      },
      timeout: REQUEST_TIMEOUT_MS,
      headers: {
        "User-Agent": USER_AGENT(),
        "Accept-Language": opts.lang ?? DEFAULT_LANG,
      },
    });
    if (!Array.isArray(response.data) || response.data.length === 0) return null;
    return toOsmPlace(response.data[0]);
  } catch {
    return null;
  }
}
