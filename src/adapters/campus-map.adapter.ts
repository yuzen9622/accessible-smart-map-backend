import { z } from "zod";
import {
  parseGeoPoint,
  type CampusFacilityLocation,
} from "../utils/campus-geo";

const mapInfoSchema = z.object({
  MAP_FACINFO: z.array(
    z.object({
      UID: z.string().min(1),
      INSTITUTION_BRANCH_ID: z.number().int(),
      GEO: z.string().nullish(),
    }),
  ),
});

/** Parses the same per-facility geometries used by MOE QuickSearch/SpatialSearch. */
export function parseCampusMapLocations(
  value: unknown,
  branchId: number,
): Map<string, CampusFacilityLocation> {
  const response = mapInfoSchema.parse(value);
  const locations = new Map<string, CampusFacilityLocation>();
  const seen = new Set<string>();
  for (const row of response.MAP_FACINFO) {
    if (row.INSTITUTION_BRANCH_ID !== branchId) {
      throw new Error("MOE MapInfo returned a different campus");
    }
    if (seen.has(row.UID))
      throw new Error("MOE MapInfo returned a duplicate facility UID");
    seen.add(row.UID);
    const geo = row.GEO ? parseGeoPoint(row.GEO) : null;
    if (geo)
      locations.set(row.UID, {
        type: "Point",
        coordinates: [geo.lng, geo.lat],
      });
  }
  return locations;
}

/** The branch filter returns the whole campus; no paging or session is required. */
export async function fetchCampusMapLocations(
  branchId: number,
): Promise<Map<string, CampusFacilityLocation>> {
  const url = new URL("https://cam.moe.gov.tw/api/Map/MapInfo");
  url.searchParams.set("INSTITUTION_BRANCH_ID", String(branchId));
  const response = await fetch(url, {
    headers: { "User-Agent": "AccessibleSmartMap/1.0" },
    signal: AbortSignal.timeout(60_000),
  });
  if (!response.ok) throw new Error(`GET MapInfo HTTP ${response.status}`);
  return parseCampusMapLocations(await response.json(), branchId);
}
