import CampusA11yModel from "../../model/campus-a11y.model";
import type { ICampusA11y } from "../../types";
import { codeToId } from "./campus.fac-type";
import {
  cityFilter,
  escapeRegExp,
  normalizeName,
  taiwanClass,
  toRawId,
} from "./campus.util";
import type { CampusSort } from "./campus.types";

const SUMMARY_FIELDS =
  "schoolId branchId schoolName branchName city address phone location buildingCount facilityCount facilities.facTypeId facilities.facType";

const FACILITY_PLACE_FIELDS =
  "schoolId branchId schoolName branchName facilities";

const SORT_SPECS: Record<CampusSort, Record<string, 1 | -1>> = {
  name: { schoolName: 1, branchName: 1 },
  "-name": { schoolName: -1, branchName: -1 },
  facilities: { facilityCount: -1 },
  "-facilities": { facilityCount: 1 },
};

/** A campus projected down to the summary fields. */
export type CampusSummaryRow = Pick<
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
>;

/** A campus projected down to the fields needed to flatten its facilities. */
export type CampusFacilityRow = Pick<
  ICampusA11y,
  "schoolId" | "branchId" | "schoolName" | "branchName" | "facilities"
>;

/** One aggregated school row from the school directory. */
export interface CampusSchoolRow {
  _id: number;
  schoolName: string;
  city?: string;
  branchCount: number;
  facilityCount: number;
}

/** Shared filters across the campus directory queries. */
export interface CampusQueryFilter {
  city?: string;
  type?: string;
  keyword?: string;
  schoolId?: number;
}

function makeGeoQuery(lng: number, lat: number, radiusM: number) {
  return {
    $near: {
      $geometry: { type: "Point", coordinates: [lng, lat] },
      $maxDistance: radiusM,
    },
  };
}

/** Resolves an optional type code to a facTypeId filter fragment. */
function facTypeQuery(type?: string): Record<string, number> {
  if (!type) return {};
  const id = codeToId(type);
  return id != null ? { "facilities.facTypeId": id } : {};
}

/**
 * Builds the keyword `$or` clause. Primary path matches the normalized
 * `searchName` / `aliasNames`; the raw schoolName / branchName clauses are a
 * legacy fallback (臺/台-insensitive substring) so documents not yet backfilled
 * with `searchName`/`aliasNames` still match on the common case.
 */
function keywordClause(keyword: string): Record<string, unknown>[] | null {
  const nk = normalizeName(keyword);
  if (!nk) return null;
  const rx = escapeRegExp(nk);
  const rawPat = taiwanClass(rx);
  return [
    { searchName: { $regex: rx } },
    { aliasNames: { $regex: rx } },
    { schoolName: { $regex: rawPat, $options: "i" } },
    { branchName: { $regex: rawPat, $options: "i" } },
  ];
}

function buildFilter(filter: CampusQueryFilter): Record<string, unknown> {
  const query: Record<string, unknown> = { ...facTypeQuery(filter.type) };
  if (filter.city) query.city = cityFilter(filter.city);
  if (filter.schoolId != null) query.schoolId = toRawId(filter.schoolId);
  if (filter.keyword) {
    const clause = keywordClause(filter.keyword);
    if (clause) query.$or = clause;
  }
  return query;
}

/**
 * Campus summaries within a radius, optionally owning a facility of a type.
 *
 * @param lat Latitude of the search centre
 * @param lng Longitude of the search centre
 * @param radiusM Search radius in metres
 * @param type Optional facility-type code
 * @returns Summary-projected campuses, nearest first
 */
export async function findCampusesNearby(
  lat: number,
  lng: number,
  radiusM: number,
  type?: string,
): Promise<CampusSummaryRow[]> {
  return CampusA11yModel.find({
    location: makeGeoQuery(lng, lat, radiusM),
    ...facTypeQuery(type),
  })
    .select(SUMMARY_FIELDS)
    .lean<CampusSummaryRow[]>();
}

/**
 * Every campus that has at least one facility carrying its own coordinates.
 *
 * @returns Facility-projected campuses
 */
export async function findCampusesWithLocatedFacilities(): Promise<
  CampusFacilityRow[]
> {
  return CampusA11yModel.find({
    "facilities.location": { $exists: true },
  })
    .select(FACILITY_PLACE_FIELDS)
    .lean<CampusFacilityRow[]>();
}

/**
 * Campuses whose centroid falls within a radius, for facility-level filtering.
 *
 * @param lat Latitude of the search centre
 * @param lng Longitude of the search centre
 * @param radiusM Search radius in metres, already including the caller's buffer
 * @returns Facility-projected campuses, nearest centroid first
 */
export async function findCampusesNearbyWithFacilities(
  lat: number,
  lng: number,
  radiusM: number,
): Promise<CampusFacilityRow[]> {
  return CampusA11yModel.find({
    location: makeGeoQuery(lng, lat, radiusM),
  })
    .select(FACILITY_PLACE_FIELDS)
    .lean<CampusFacilityRow[]>();
}

/**
 * One page of the campus directory plus its total count.
 *
 * @param filter City / type / keyword / schoolId filters
 * @param sort Sort key
 * @param page 1-based page number
 * @param limit Page size
 * @returns The page's summary rows and the unpaginated total
 */
export async function findCampusPage(
  filter: CampusQueryFilter,
  sort: CampusSort | undefined,
  page: number,
  limit: number,
): Promise<{ docs: CampusSummaryRow[]; totalCount: number }> {
  const query = buildFilter(filter);
  const sortSpec = { ...SORT_SPECS[sort ?? "name"], _id: 1 as const };
  const [docs, totalCount] = await Promise.all([
    CampusA11yModel.find(query)
      .select(SUMMARY_FIELDS)
      .sort(sortSpec)
      .skip((page - 1) * limit)
      .limit(limit)
      .lean<CampusSummaryRow[]>(),
    CampusA11yModel.countDocuments(query),
  ]);
  return { docs, totalCount };
}

/**
 * A single campus with its full facilities array.
 *
 * @param branchId Raw (internal) branch id
 * @returns The campus, or null when unknown
 */
export async function findCampusByBranchId(
  branchId: number,
): Promise<ICampusA11y | null> {
  return CampusA11yModel.findOne({ branchId }).lean<ICampusA11y | null>();
}

/**
 * One page of the school directory, grouped from campuses.
 *
 * @param filter City / keyword filters
 * @param page 1-based page number
 * @param limit Page size
 * @returns The page's school rows and the unpaginated total
 */
export async function aggregateSchoolPage(
  filter: Pick<CampusQueryFilter, "city" | "keyword">,
  page: number,
  limit: number,
): Promise<{ items: CampusSchoolRow[]; totalCount: number }> {
  const match: Record<string, unknown> = {};
  if (filter.city) match.city = cityFilter(filter.city);
  if (filter.keyword) {
    const clause = keywordClause(filter.keyword);
    if (clause) match.$or = clause;
  }

  const [result] = await CampusA11yModel.aggregate<{
    items: CampusSchoolRow[];
    total: { n: number }[];
  }>([
    { $match: match },
    {
      $group: {
        _id: "$schoolId",
        schoolName: { $first: "$schoolName" },
        city: { $first: "$city" },
        branchCount: { $sum: 1 },
        facilityCount: { $sum: "$facilityCount" },
      },
    },
    { $sort: { schoolName: 1, _id: 1 } },
    {
      $facet: {
        items: [{ $skip: (page - 1) * limit }, { $limit: limit }],
        total: [{ $count: "n" }],
      },
    },
  ]);

  return {
    items: result?.items ?? [],
    totalCount: result?.total[0]?.n ?? 0,
  };
}
