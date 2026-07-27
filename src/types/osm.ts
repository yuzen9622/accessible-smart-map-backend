export type OsmType = "node" | "way" | "relation";

export interface OsmAddress {
  road: string | null;
  district: string | null;
  city: string | null;
  postcode: string | null;
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
