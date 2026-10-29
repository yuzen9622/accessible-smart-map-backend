import CampusA11yModel from "../model/campus-a11y.model";
import type { ICampusA11y } from "../types";
import { fetchCampusMapLocations } from "../adapters/campus-map.adapter";
import { parseFacilityDetailHtml } from "./campus-a11y-parse";
import {
  parseFacilityLocation,
  type CampusFacilityLocation,
} from "../utils/campus-geo";

type CampusImportDocument = Omit<ICampusA11y, "_id">;

/** Updates complete campus lists without deleting failed or unvisited campuses. */
export async function syncCampusDocuments(
  docs: readonly CampusImportDocument[],
) {
  if (docs.length === 0) throw new Error("No complete campus data to write");
  const branches = new Set<number>();
  for (const doc of docs) {
    if (
      branches.has(doc.branchId) ||
      doc.facilities.length === 0 ||
      doc.facilityCount !== doc.facilities.length ||
      new Set(doc.facilities.map((f) => f.facUid)).size !==
        doc.facilities.length
    ) {
      throw new Error(`Incomplete or duplicate campus data: ${doc.branchId}`);
    }
    branches.add(doc.branchId);
  }
  const previous = await CampusA11yModel.find({
    branchId: { $in: [...branches] },
  }).lean();
  const previousByBranch = new Map(
    previous.map((campus) => [campus.branchId, campus]),
  );
  return CampusA11yModel.bulkWrite(
    docs.map((doc) => {
      const stored = new Map(
        (previousByBranch.get(doc.branchId)?.facilities ?? []).map((f) => [
          f.facUid,
          f,
        ]),
      );
      const facilities = doc.facilities.map((f) => {
        const old = stored.get(f.facUid);
        return {
          ...f,
          location:
            parseFacilityLocation(f.location) ??
            parseFacilityLocation(old?.location),
          specs: f.specs ?? old?.specs,
          detailFetchedAt: f.detailFetchedAt ?? old?.detailFetchedAt,
        };
      });
      return {
        updateOne: {
          filter: { branchId: doc.branchId },
          update: { $set: { ...doc, facilities } },
          upsert: true,
        },
      };
    }),
    { ordered: false },
  );
}

interface EnrichmentOptions {
  force?: boolean;
  limit?: number;
  loadMap?: (branchId: number) => Promise<Map<string, CampusFacilityLocation>>;
  loadDetail: (payload: Record<string, string>) => Promise<string>;
}

/** Backfills existing data from MapInfo; detail HTML is a fallback for missing points. */
export async function enrichCampusFacilities({
  force = false,
  limit = Infinity,
  loadMap = fetchCampusMapLocations,
  loadDetail,
}: EnrichmentOptions) {
  const campuses = (await CampusA11yModel.find({}).lean()).slice(0, limit);
  const stats = { located: 0, skipped: 0, missingCoordinates: 0, failed: 0 };
  for (const campus of campuses) {
    const pending = campus.facilities.filter(
      (f) => force || !parseFacilityLocation(f.location),
    );
    stats.skipped += campus.facilities.length - pending.length;
    if (pending.length === 0) continue;
    let locations: Map<string, CampusFacilityLocation>;
    try {
      locations = await loadMap(campus.branchId);
    } catch (error) {
      stats.failed++;
      console.error(`MapInfo failed for campus ${campus.branchId}:`, error);
      continue;
    }
    let changed = 0;
    for (const facility of pending) {
      const location = locations.get(facility.facUid);
      if (location) {
        facility.location = location;
        stats.located++;
        changed++;
        continue;
      }
      const floorId = facility.floorIds?.[0];
      if (!facility.buildingUid || !floorId) {
        stats.missingCoordinates++;
        continue;
      }
      try {
        const html = await loadDetail({
          INSTITUTION_ID: String(campus.schoolId),
          INSTITUTION_BRANCH_ID: String(campus.branchId),
          BUILDING_UID: facility.buildingUid,
          FACILITY_UID: facility.facUid,
          FLOOR_ID: floorId,
        });
        const detail = parseFacilityDetailHtml(html);
        if (!detail.geo) {
          stats.missingCoordinates++;
          continue;
        }
        facility.location = {
          type: "Point",
          coordinates: [detail.geo.lng, detail.geo.lat],
        };
        facility.specs = detail.specs;
        facility.detailFetchedAt = new Date();
        stats.located++;
        changed++;
      } catch (error) {
        stats.failed++;
        console.error(`Facility ${facility.facUid} failed:`, error);
      }
    }
    if (changed > 0) {
      await CampusA11yModel.updateOne(
        { _id: campus._id },
        { $set: { facilities: campus.facilities } },
      );
    }
  }
  return stats;
}
