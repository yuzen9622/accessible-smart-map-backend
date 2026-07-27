import type { OsmType } from "../../types/osm";

export type PlaceSource = "osm" | "google";

export type GeoPoint = { type: "Point"; coordinates: [number, number] };

export type ParsedPlaceId =
  | { source: "google"; googlePlaceId: string }
  | { source: "osm"; osmType: OsmType; osmId: string };

const OSM_TYPES: OsmType[] = ["node", "way", "relation"];

/** Builds the public id for a Google place: `google:<placeId>`. */
export function buildGooglePlaceId(googlePlaceId: string): string {
  return `google:${googlePlaceId}`;
}

/** Builds the public id for an OSM place: `osm:<type>:<id>`. */
export function buildOsmPlaceId(osmType: OsmType, osmId: string): string {
  return `osm:${osmType}:${osmId}`;
}

/**
 * Parses a public place id back into its source and native identifier.
 *
 * OSM ids use colons rather than Nominatim's own `node/123` form because a
 * slash would truncate the `:id` route parameter. The slash form is restored
 * only where it is required — the review key, which predates this module.
 *
 * @param value The prefixed public id.
 * @returns The parsed id, or null when the prefix or payload is unusable.
 */
export function parsePlaceId(value: string): ParsedPlaceId | null {
  if (value.startsWith("google:")) {
    const googlePlaceId = value.slice("google:".length);
    return googlePlaceId ? { source: "google", googlePlaceId } : null;
  }
  if (value.startsWith("osm:")) {
    const [osmType, osmId, ...rest] = value.slice("osm:".length).split(":");
    if (rest.length > 0) return null;
    if (!OSM_TYPES.includes(osmType as OsmType)) return null;
    if (!/^\d+$/.test(osmId ?? "")) return null;
    return { source: "osm", osmType: osmType as OsmType, osmId };
  }
  return null;
}

/** The `<type>/<id>` form the review module has stored for OSM places all along. */
export function toReviewOsmId(osmType: OsmType, osmId: string): string {
  return `${osmType}/${osmId}`;
}

export { normalizePlaceName as normalizeName } from "../../utils/place-name";

interface ClassType {
  placeClass: string | null;
  placeType: string | null;
}

const GOOGLE_TYPE_MAP: Record<string, ClassType> = {
  subway_station: { placeClass: "railway", placeType: "station" },
  train_station: { placeClass: "railway", placeType: "station" },
  light_rail_station: { placeClass: "railway", placeType: "station" },
  transit_station: { placeClass: "railway", placeType: "station" },
  bus_station: { placeClass: "highway", placeType: "bus_stop" },
  bus_stop: { placeClass: "highway", placeType: "bus_stop" },
  restaurant: { placeClass: "amenity", placeType: "restaurant" },
  food: { placeClass: "amenity", placeType: "restaurant" },
  cafe: { placeClass: "amenity", placeType: "cafe" },
  bakery: { placeClass: "shop", placeType: "bakery" },
  hospital: { placeClass: "amenity", placeType: "hospital" },
  doctor: { placeClass: "amenity", placeType: "clinic" },
  pharmacy: { placeClass: "amenity", placeType: "pharmacy" },
  school: { placeClass: "amenity", placeType: "school" },
  university: { placeClass: "amenity", placeType: "university" },
  library: { placeClass: "amenity", placeType: "library" },
  bank: { placeClass: "amenity", placeType: "bank" },
  atm: { placeClass: "amenity", placeType: "atm" },
  post_office: { placeClass: "amenity", placeType: "post_office" },
  police: { placeClass: "amenity", placeType: "police" },
  parking: { placeClass: "amenity", placeType: "parking" },
  lodging: { placeClass: "tourism", placeType: "hotel" },
  hotel: { placeClass: "tourism", placeType: "hotel" },
  museum: { placeClass: "tourism", placeType: "museum" },
  tourist_attraction: { placeClass: "tourism", placeType: "attraction" },
  park: { placeClass: "leisure", placeType: "park" },
  shopping_mall: { placeClass: "shop", placeType: "mall" },
  department_store: { placeClass: "shop", placeType: "department_store" },
  supermarket: { placeClass: "shop", placeType: "supermarket" },
  convenience_store: { placeClass: "shop", placeType: "convenience" },
  store: { placeClass: "shop", placeType: "yes" },
};

/**
 * Maps Google's `types[]` onto the OSM class/type vocabulary the frontend icon
 * picker already understands, so one icon table serves both sources.
 *
 * @param types The Google place types, most specific first.
 * @returns The OSM-style class/type, with the raw Google type kept when unmapped.
 */
export function googleTypesToClassType(types: string[]): ClassType {
  for (const type of types) {
    const hit = GOOGLE_TYPE_MAP[type];
    if (hit) return hit;
  }
  const first = types.find((t) => t !== "point_of_interest" && t !== "establishment");
  return { placeClass: null, placeType: first ?? null };
}

const TYPE_LABELS: Record<string, string> = {
  station: "車站",
  subway_entrance: "捷運出入口",
  halt: "車站",
  bus_stop: "公車站",
  bus_station: "轉運站",
  restaurant: "餐廳",
  fast_food: "速食店",
  cafe: "咖啡廳",
  bakery: "麵包店",
  bar: "酒吧",
  hospital: "醫院",
  clinic: "診所",
  dentist: "牙醫",
  pharmacy: "藥局",
  school: "學校",
  kindergarten: "幼兒園",
  college: "專科學校",
  university: "大學",
  library: "圖書館",
  bank: "銀行",
  atm: "提款機",
  post_office: "郵局",
  police: "警察局",
  fire_station: "消防局",
  townhall: "公所",
  parking: "停車場",
  fuel: "加油站",
  toilets: "廁所",
  hotel: "旅館",
  hostel: "青年旅館",
  museum: "博物館",
  attraction: "景點",
  viewpoint: "觀景點",
  park: "公園",
  garden: "花園",
  playground: "遊樂場",
  sports_centre: "運動中心",
  swimming_pool: "游泳池",
  mall: "購物中心",
  department_store: "百貨公司",
  supermarket: "超級市場",
  convenience: "便利商店",
  marketplace: "市場",
  place_of_worship: "宗教場所",
  temple: "廟宇",
  theatre: "劇院",
  cinema: "電影院",
  residential: "住宅",
  house: "住宅",
  apartments: "公寓",
  suburb: "行政區",
  neighbourhood: "鄰里",
  city: "城市",
  town: "鄉鎮",
  village: "村里",
  yes: "地點",
};

/**
 * Resolves the human-readable Chinese label for a place type. The frontend can
 * render this directly instead of maintaining its own type→label table.
 *
 * @param placeType The OSM-style place type.
 * @returns The label, or null when the type has no known translation.
 */
export function typeLabelOf(placeType: string | null): string | null {
  if (!placeType) return null;
  return TYPE_LABELS[placeType] ?? null;
}
