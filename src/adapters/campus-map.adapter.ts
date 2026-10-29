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

/** Keeps all source UIDs, even when a source row has no usable point. */
export function parseCampusMapData(value: unknown, branchId: number) {
  const response = mapInfoSchema.parse(value);
  const locations = new Map<string, CampusFacilityLocation>();
  const facilityUids = new Set<string>();
  for (const row of response.MAP_FACINFO) {
    if (row.INSTITUTION_BRANCH_ID !== branchId) {
      throw new Error("MOE MapInfo returned a different campus");
    }
    if (facilityUids.has(row.UID))
      throw new Error("MOE MapInfo returned a duplicate facility UID");
    facilityUids.add(row.UID);
    const geo = row.GEO ? parseGeoPoint(row.GEO) : null;
    if (geo)
      locations.set(row.UID, {
        type: "Point",
        coordinates: [geo.lng, geo.lat],
      });
  }
  return { locations, facilityUids };
}

export function parseCampusMapLocations(value: unknown, branchId: number) {
  return parseCampusMapData(value, branchId).locations;
}

/** Same public endpoint as QuickSearch/SpatialSearch: all types, without paging. */
export async function fetchCampusMapData(branchId: number) {
  const url = new URL("https://cam.moe.gov.tw/api/Map/MapInfo");
  url.searchParams.set("INSTITUTION_BRANCH_ID", String(branchId));
  const response = await fetch(url, {
    headers: { "User-Agent": "AccessibleSmartMap/1.0" },
    signal: AbortSignal.timeout(60_000),
  });
  if (!response.ok) throw new Error(`GET MapInfo HTTP ${response.status}`);
  return parseCampusMapData(await response.json(), branchId);
}

export async function fetchCampusMapLocations(branchId: number) {
  return (await fetchCampusMapData(branchId)).locations;
}
