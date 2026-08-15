import {
  aggregateSchoolPage,
  findCampusByBranchId,
  findCampusPage,
  findCampusesNearby,
  findCampusesNearbyWithFacilities,
  findCampusesWithLocatedFacilities,
} from "./campus.repository";
import type { ICampusA11y, ICampusFacility } from "../../types";
import type { CampusSort } from "./campus.types";
import { resolveFacType } from "./campus.fac-type";
import { toPublicId, toRawId } from "./campus.util";

export interface FacTypeCount {
  code: string;
  label: string;
  count: number;
}

export interface CampusSummary {
  campusId: number;
  schoolId: number;
  schoolName: string;
  branchName: string;
  city?: string;
  address?: string;
  phone?: string;
  location?: { type: "Point"; coordinates: [number, number] };
  buildingCount: number;
  facilityCount: number;
  facTypeSummary: FacTypeCount[];
}

export interface CampusFacilityOut {
  facUid: string;
  facTypeId?: number;
  type?: string;
  facType?: string;
  name?: string;
  building?: string;
  buildingUid?: string;
  floors: string[];
  floorIds: string[];
  location?: { type: "Point"; coordinates: [number, number] };
  specs?: { label: string; value: string }[];
}

export interface CampusDetail {
  _id: string;
  campusId: number;
  schoolId: number;
  schoolName: string;
  branchName: string;
  city?: string;
  address?: string;
  phone?: string;
  buildingCount: number;
  facilityCount: number;
  facilities: CampusFacilityOut[];
  facTypeSummary: FacTypeCount[];
  location?: { type: "Point"; coordinates: [number, number] };
  importedAt: Date | string;
}

export interface CampusSchool {
  schoolId: number;
  schoolName: string;
  city?: string;
  branchCount: number;
  facilityCount: number;
}

export type { CampusSort } from "./campus.types";

export interface CampusListFilter {
  city?: string;
  type?: string;
  keyword?: string;
  schoolId?: number;
  sort?: CampusSort;
  page: number;
  limit: number;
}

export interface CampusListResult {
  items: CampusSummary[];
  totalCount: number;
  page: number;
  totalPages: number;
}

export interface CampusSchoolFilter {
  city?: string;
  keyword?: string;
  page: number;
  limit: number;
}

export interface CampusSchoolListResult {
  items: CampusSchool[];
  totalCount: number;
  page: number;
  totalPages: number;
}

/** Aggregates per-type facility counts, keyed by canonical code and ordered by SEQ. */
function facTypeSummaryOf(
  facilities: Pick<ICampusFacility, "facTypeId" | "facType">[],
): FacTypeCount[] {
  const byId = new Map<
    number,
    { code: string; label: string; seq: number; count: number }
  >();
  for (const f of facilities ?? []) {
    const t = resolveFacType(f.facTypeId, f.facType);
    if (!t) continue;
    const cur = byId.get(t.id) ?? {
      code: t.code,
      label: t.label,
      seq: t.seq,
      count: 0,
    };
    cur.count += 1;
    byId.set(t.id, cur);
  }
  return [...byId.values()]
    .sort((a, b) => a.seq - b.seq)
    .map(({ code, label, count }) => ({ code, label, count }));
}

function toSummary(
  doc: Pick<
    ICampusA11y,
    | "schoolId"
    | "branchId"
    | "schoolName"
    | "branchName"
    | "city"
    | "address"
    | "phone"
    | "location"
    | "buildingCount"
    | "facilityCount"
    | "facilities"
  >,
): CampusSummary {
  return {
    campusId: toPublicId(doc.branchId),
    schoolId: toPublicId(doc.schoolId),
    schoolName: doc.schoolName,
    branchName: doc.branchName,
    city: doc.city,
    address: doc.address,
    phone: doc.phone,
    location: doc.location,
    buildingCount: doc.buildingCount,
    facilityCount: doc.facilityCount,
    facTypeSummary: facTypeSummaryOf(doc.facilities ?? []),
  };
}

function toDetail(doc: ICampusA11y): CampusDetail {
  return {
    _id: String(doc._id),
    campusId: toPublicId(doc.branchId),
    schoolId: toPublicId(doc.schoolId),
    schoolName: doc.schoolName,
    branchName: doc.branchName,
    city: doc.city,
    address: doc.address,
    phone: doc.phone,
    buildingCount: doc.buildingCount,
    facilityCount: doc.facilityCount,
    facilities: (doc.facilities ?? []).map((f) => ({
      facUid: f.facUid,
      facTypeId: f.facTypeId,
      type: resolveFacType(f.facTypeId, f.facType)?.code,
      facType: f.facType,
      name: f.name,
      building: f.building,
      buildingUid: f.buildingUid,
      floors: f.floors,
      floorIds: f.floorIds,
      location: f.location,
      specs: f.specs,
    })),
    facTypeSummary: facTypeSummaryOf(doc.facilities ?? []),
    location: doc.location,
    importedAt: doc.importedAt,
  };
}

/**
 * Campus summaries within `radiusM` of the point. When `type` is given, only
 * campuses that own at least one facility of that type are returned.
 *
 * @param lat Latitude of the search centre.
 * @param lng Longitude of the search centre.
 * @param radiusM Search radius in metres.
 * @param type Optional facility-type code to filter by.
 * @returns Campus summaries (no full `facilities` array).
 */
export async function findNearby(
  lat: number,
  lng: number,
  radiusM = 1000,
  type?: string,
): Promise<CampusSummary[]> {
  const docs = await findCampusesNearby(lat, lng, radiusM, type);
  return docs.map(toSummary);
}

/**
 * A single campus accessibility facility flattened out of its parent campus
 * document, carrying enough campus context to render standalone on a map. Only
 * facilities that have their own coordinates are emitted.
 */
export interface CampusFacilityPlace {
  campusId: number;
  schoolId: number;
  schoolName: string;
  branchName: string;
  facUid: string;
  facTypeId?: number;
  type?: string;
  facType?: string;
  name?: string;
  building?: string;
  floors: string[];
  location: { type: "Point"; coordinates: [number, number] };
}

/** Extra radius (metres) added when pre-selecting campuses whose centroid is
 * indexed, before filtering individual facilities to the real radius. */
const CAMPUS_QUERY_BUFFER_M = 800;

/** Great-circle distance in metres between two [lng, lat] points. */
function haversineMeters(a: [number, number], b: [number, number]): number {
  const R = 6371000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const [lng1, lat1] = a;
  const [lng2, lat2] = b;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

/** True when a facility carries a usable [lng, lat] coordinate pair. */
function hasCoordinates(f: ICampusFacility): boolean {
  return (f.location?.coordinates?.length ?? 0) === 2;
}

/** Flattens one campus facility (known to have coordinates) into a standalone place. */
function toFacilityPlace(
  campus: Pick<
    ICampusA11y,
    "branchId" | "schoolId" | "schoolName" | "branchName"
  >,
  f: ICampusFacility,
): CampusFacilityPlace {
  return {
    campusId: toPublicId(campus.branchId),
    schoolId: toPublicId(campus.schoolId),
    schoolName: campus.schoolName,
    branchName: campus.branchName,
    facUid: f.facUid,
    facTypeId: f.facTypeId,
    type: resolveFacType(f.facTypeId, f.facType)?.code,
    facType: f.facType,
    name: f.name,
    building: f.building,
    floors: f.floors,
    location: f.location as { type: "Point"; coordinates: [number, number] },
  };
}

/**
 * Every campus accessibility facility (across all campuses) that has its own
 * coordinates, flattened into standalone places. Used to merge campus data into
 * the unified "all accessible places" listing.
 *
 * @returns One place per located facility.
 */
export async function findAllFacilities(): Promise<CampusFacilityPlace[]> {
  const docs = await findCampusesWithLocatedFacilities();
  const out: CampusFacilityPlace[] = [];
  for (const campus of docs) {
    for (const f of campus.facilities ?? []) {
      if (hasCoordinates(f)) out.push(toFacilityPlace(campus, f));
    }
  }
  return out;
}

/**
 * Campus accessibility facilities within `radiusM` of the point, flattened into
 * standalone places and sorted nearest-first. Because only the campus centroid
 * is 2dsphere-indexed, candidate campuses are pre-selected with a buffer and
 * then each facility is distance-filtered to the true radius.
 *
 * @param lat Latitude of the search centre.
 * @param lng Longitude of the search centre.
 * @param radiusM Search radius in metres.
 * @returns Located facilities within the radius, nearest first.
 */
export async function findFacilitiesNearby(
  lat: number,
  lng: number,
  radiusM: number,
): Promise<CampusFacilityPlace[]> {
  const docs = await findCampusesNearbyWithFacilities(
    lat,
    lng,
    radiusM + CAMPUS_QUERY_BUFFER_M,
  );
  const out: { place: CampusFacilityPlace; dist: number }[] = [];
  for (const campus of docs) {
    for (const f of campus.facilities ?? []) {
      if (!hasCoordinates(f)) continue;
      const coords = f.location!.coordinates as [number, number];
      const dist = haversineMeters([lng, lat], coords);
      if (dist <= radiusM)
        out.push({ place: toFacilityPlace(campus, f), dist });
    }
  }
  return out.sort((a, b) => a.dist - b.dist).map((x) => x.place);
}

/**
 * Paginated campus directory. `city` is matched 臺/台-insensitively, `type`
 * filters on the facility-type code, `keyword` matches the normalized
 * searchName / aliasNames, and `schoolId` (public) lists one school's campuses.
 *
 * @param filter City / type / keyword / schoolId filters plus sort + pagination.
 * @returns Campus summaries with total count and page metadata.
 */
export async function findAll(
  filter: CampusListFilter,
): Promise<CampusListResult> {
  const { city, type, keyword, schoolId, sort, page, limit } = filter;
  const { docs, totalCount } = await findCampusPage(
    { city, type, keyword, schoolId },
    sort,
    page,
    limit,
  );

  return {
    items: docs.map(toSummary),
    totalCount,
    page,
    totalPages: Math.ceil(totalCount / limit),
  };
}

/**
 * Single campus with its full `facilities` array (each carrying its type code),
 * or null if not found.
 *
 * @param campusId The positive public campus id.
 * @returns The full campus detail or null.
 */
export async function findByCampusId(
  campusId: number,
): Promise<CampusDetail | null> {
  const doc = await findCampusByBranchId(toRawId(campusId));
  return doc ? toDetail(doc) : null;
}

/**
 * Paginated school directory — one row per institution with its campus and
 * facility totals — for a school-first browsing UI.
 *
 * @param filter City / keyword filters plus pagination.
 * @returns Schools with total count and page metadata.
 */
export async function listSchools(
  filter: CampusSchoolFilter,
): Promise<CampusSchoolListResult> {
  const { city, keyword, page, limit } = filter;
  const { items: rows, totalCount } = await aggregateSchoolPage(
    { city, keyword },
    page,
    limit,
  );

  const items: CampusSchool[] = rows.map((s) => ({
    schoolId: toPublicId(s._id),
    schoolName: s.schoolName,
    city: s.city,
    branchCount: s.branchCount,
    facilityCount: s.facilityCount,
  }));

  return { items, totalCount, page, totalPages: Math.ceil(totalCount / limit) };
}
