export type OsmType = "node" | "way" | "relation";

export interface OsmAddress {
  road: string | null;
  district: string | null;
  city: string | null;
  postcode: string | null;
}

export type OsmTags = Record<string, string>;

/**
 * Keeps only the string-to-string entries an OSM tag map is allowed to carry.
 * Upstreams and legacy cache records can omit tags or hold an unexpected
 * shape, both of which normalize to an empty map rather than unsafe evidence.
 */
export function normalizeOsmTags(value: unknown): OsmTags {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value).filter(([, tagValue]) => typeof tagValue === "string"),
  ) as OsmTags;
}

/**
 * A place sourced from OpenStreetMap, normalized so callers never see which
 * upstream produced it. Two adapters emit this shape: Photon answers
 * type-ahead queries, Nominatim resolves a known object to its full record.
 */
export interface OsmPlace {
  osmType: OsmType;
  osmId: string;
  name: string;
  displayName: string;
  latitude: number;
  longitude: number;
  placeClass: string | null;
  placeType: string | null;
  address: OsmAddress;
  tags: OsmTags;
}

export const OSM_TYPE_BY_PREFIX: Record<string, OsmType> = {
  N: "node",
  W: "way",
  R: "relation",
};

export const PREFIX_BY_OSM_TYPE: Record<OsmType, string> = {
  node: "N",
  way: "W",
  relation: "R",
};

/** Picks the first non-empty string, normalizing missing/blank fields to null. */
export function firstOsmValue(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === "string" && value.trim() !== "") return value;
  }
  return null;
}
