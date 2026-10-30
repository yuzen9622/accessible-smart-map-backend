import type { SupportedLang } from "../../types/lang";
import { haversineMeters } from "../../utils/geo";
import { preparePlaceBounds, type PlaceBounds } from "../../utils/place-extent";
import {
  formatCampusFacilityLabel,
  normalizeCampusFacilityName,
} from "../../utils/campus-facility-name";
import { resolveFacType } from "../campus/campus.fac-type";
import { displayFacility } from "./a11y.display";
import { fetchTaipeiMetroNotices } from "../../adapters/taipei-metro-notice.adapter";
import {
  activeElevatorNotices,
  outageNoticeForMetroFacility,
  type ActiveMetroNotice,
} from "../../utils/metro-notice";
import * as campusService from "../campus/campus.service";
import type { CampusFacilityPlace } from "../campus/campus.service";
import { countActiveHazardsNear } from "../hazard-report/hazard-report.service";
import {
  bumpCategory,
  classifyMetroCategory,
  mapOsmCategory,
  computeVerdict,
  buildQuickAssessSummary,
  countOwnQuickAssess,
  findOwnBathroomFacilities,
  findOwnElevatorFacilities,
  findOwnFacilityGroups,
  findOwnNearby,
  findOwnNearbyInBounds,
  findOwnNearbyLimited,
  findOwnRampFacilities,
  mergeA11yPlaces,
  A11Y_MAX_RESULTS,
  type A11yCategory,
  type A11yFacility,
  type A11yPlace,
  type QuickAssessMode,
  type QuickAssessResult,
} from "./a11y.service";
import type { IOsmA11y } from "../../types";

/**
 * Cross-module composition for the accessibility endpoints.
 *
 * `a11y.service` answers for the collections this module owns; campus
 * facilities and hazard reports belong to other modules. Joining them here
 * rather than inside the service keeps `a11y.service` from growing into an
 * aggregation layer that reaches sideways into its peers.
 */

/** Maps a campus facility type code onto this module's category vocabulary. */
function mapCampusCategory(code?: string): A11yCategory {
  switch (code) {
    case "ramp":
      return "ramp";
    case "elevator":
      return "elevator";
    case "accessible_toilet":
      return "toilet";
    case "accessible_parking":
    case "accessible_motorcycle_parking":
      return "parking";
    default:
      return "other";
  }
}

/**
 * Normalizes a flattened campus facility into the A11y (metro) response shape
 * so campus facilities render through the same frontend layer as metro/OSM.
 */
export function campusToA11yPlace(
  f: CampusFacilityPlace,
  lang?: SupportedLang,
): A11yPlace {
  const category = f.facType || resolveFacType(f.facTypeId)?.label;
  const name =
    normalizeCampusFacilityName(f.name, category) || "校園無障礙設施";
  return {
    項次: f.facUid,
    "出入口電梯/無障礙坡道名稱": name,
    ...(lang !== undefined
      ? {
          displayName: formatCampusFacilityLabel({
            ...f,
            name,
            facType: category,
          }),
        }
      : {}),
    location: f.location,
    source: "campus",
    campusId: f.campusId,
    schoolName: f.schoolName,
    facUid: f.facUid,
    facType: f.type,
    facTypeLabel: f.facType,
  };
}

function campusToFacility(
  f: CampusFacilityPlace,
  lang?: SupportedLang,
): A11yFacility {
  const category = f.facType || resolveFacType(f.facTypeId)?.label;
  const name =
    normalizeCampusFacilityName(f.name, category) || "校園無障礙設施";
  return {
    _id: f.facUid,
    name,
    ...(lang !== undefined
      ? {
          displayName: formatCampusFacilityLabel({
            ...f,
            name,
            facType: category,
          }),
        }
      : {}),
    location: f.location,
    category: mapCampusCategory(f.type),
    source: "campus",
    schoolName: f.schoolName,
  };
}

async function loadMetroNotices(): Promise<Map<string, ActiveMetroNotice>> {
  return activeElevatorNotices(await fetchTaipeiMetroNotices());
}

function withFacilityNotices(
  facilities: A11yFacility[],
  notices: ReadonlyMap<string, ActiveMetroNotice>,
): A11yFacility[] {
  if (!notices.size) return facilities;
  return facilities.map((f) => {
    if (f.source !== "metro") return f;
    const outageNotice = outageNoticeForMetroFacility(notices, f.name);
    return outageNotice ? { ...f, outageNotice } : f;
  });
}

function withPlaceNotices(
  places: A11yPlace[],
  notices: ReadonlyMap<string, ActiveMetroNotice>,
): A11yPlace[] {
  if (!notices.size) return places;
  return places.map((p) => {
    if (p.source !== "metro") return p;
    const outageNotice = outageNoticeForMetroFacility(
      notices,
      p["出入口電梯/無障礙坡道名稱"],
    );
    return outageNotice ? { ...p, outageNotice } : p;
  });
}

/**
 * Every accessibility facility across metro, OSM, campus, bathrooms and
 * parking, optionally narrowed to a set of categories.
 *
 * @param categories Categories to keep; omit for everything
 * @returns The merged facility list
 */
export async function findAllFacilities(
  categories?: A11yCategory[],
  lang?: SupportedLang,
): Promise<A11yFacility[]> {
  const want = categories && categories.length > 0 ? new Set(categories) : null;
  const [own, campus, notices] = await Promise.all([
    findOwnFacilityGroups(categories, lang),
    campusService.findAllFacilities(),
    loadMetroNotices(),
  ]);
  const facilities = [
    ...withFacilityNotices(own.metro, notices),
    ...own.osm,
    ...campus
      .slice(0, A11Y_MAX_RESULTS)
      .map((f) => displayFacility(campusToFacility(f, lang), lang)),
    ...own.bathroom,
    ...own.parking,
  ];
  return want ? facilities.filter((f) => want.has(f.category)) : facilities;
}

/**
 * Elevator facilities only: metro names containing 電梯, OSM `elevator`, and
 * campus facilities whose resolved type code is `elevator`.
 */
export async function findElevatorFacilities(
  lang?: SupportedLang,
): Promise<A11yFacility[]> {
  const [own, campus, notices] = await Promise.all([
    findOwnElevatorFacilities(lang),
    campusService.findAllFacilities(),
    loadMetroNotices(),
  ]);
  return [
    ...withFacilityNotices(own, notices),
    ...campus
      .filter((f) => f.type === "elevator")
      .slice(0, A11Y_MAX_RESULTS)
      .map((f) => displayFacility(campusToFacility(f, lang), lang)),
  ];
}

/**
 * Ramp facilities only: metro names containing 坡道 but NOT 電梯 (mutually
 * exclusive with the elevator route), OSM `ramp`, and campus `ramp`.
 */
export async function findRampFacilities(
  lang?: SupportedLang,
): Promise<A11yFacility[]> {
  const [own, campus] = await Promise.all([
    findOwnRampFacilities(lang),
    campusService.findAllFacilities(),
  ]);
  return [
    ...own,
    ...campus
      .filter((f) => f.type === "ramp")
      .slice(0, A11Y_MAX_RESULTS)
      .map((f) => displayFacility(campusToFacility(f, lang), lang)),
  ];
}

/**
 * Accessible bathroom facilities: the bathroom collection, OSM `toilet`, and
 * campus `accessible_toilet`. Metro has no bathroom data.
 */
export async function findBathroomFacilities(
  lang?: SupportedLang,
): Promise<A11yFacility[]> {
  const [own, campus] = await Promise.all([
    findOwnBathroomFacilities(lang),
    campusService.findAllFacilities(),
  ]);
  return [
    ...own,
    ...campus
      .filter((f) => f.type === "accessible_toilet")
      .slice(0, A11Y_MAX_RESULTS)
      .map((f) => displayFacility(campusToFacility(f, lang), lang)),
  ];
}

export type NearbyArea =
  { kind: "radius"; radiusM: number } | { kind: "bbox"; bounds: PlaceBounds };

type LocatedRow = { location: { coordinates: [number, number] } };

export type NearbySummary = Record<
  "elevator" | "ramp" | "toilet",
  { count: number; nearestMeters: number | null }
>;

/** Summarizes the merged structure list plus the remaining OSM and bathroom rows. */
export function summarizeNearby(
  rows: {
    nearbyMetroA11y: A11yPlace[];
    nearbyOsm: IOsmA11y[];
    nearbyBathroom: (LocatedRow & { _id?: unknown })[];
  },
  origin: { lat: number; lng: number },
): NearbySummary {
  const summary: NearbySummary = {
    elevator: { count: 0, nearestMeters: null },
    ramp: { count: 0, nearestMeters: null },
    toilet: { count: 0, nearestMeters: null },
  };
  const metroMatches = new Map<string, number>();
  const metroIds = new Set<string>();
  const exactMatchKey = (
    category: A11yCategory,
    name: string | undefined,
    row: LocatedRow,
  ) => JSON.stringify([category, name, row.location.coordinates]);
  for (const row of rows.nearbyMetroA11y) {
    if (row.source !== "metro" || metroIds.has(row.項次)) continue;
    metroIds.add(row.項次);
    const name = row["出入口電梯/無障礙坡道名稱"];
    const key = exactMatchKey(classifyMetroCategory(name), name, row);
    metroMatches.set(key, (metroMatches.get(key) ?? 0) + 1);
  }
  const seen = new Set<string>();
  const add = (category: A11yCategory, row: LocatedRow, identity?: string) => {
    if (category === "other" || category === "parking") return;
    if (identity) {
      if (seen.has(identity)) return;
      seen.add(identity);
    }
    const [lng, lat] = row.location.coordinates;
    const distance = Math.round(
      haversineMeters(origin.lat, origin.lng, lat, lng),
    );
    const bucket = summary[category];
    bucket.count++;
    bucket.nearestMeters =
      bucket.nearestMeters === null
        ? distance
        : Math.min(bucket.nearestMeters, distance);
  };
  const addOsm = (
    category: A11yCategory,
    row: LocatedRow,
    osmId: string,
    name?: string,
  ) => {
    const identity = `osm:${osmId}`;
    if (seen.has(identity)) return;
    // Match only identical source names, categories and positions, one-to-one.
    // Nearby facilities with distinct names or coordinates remain separate.
    const key = exactMatchKey(category, name, row);
    const matches = metroMatches.get(key) ?? 0;
    if (matches > 0) {
      metroMatches.set(key, matches - 1);
      seen.add(identity);
      return;
    }
    add(category, row, identity);
  };
  for (const row of rows.nearbyMetroA11y) {
    if (row.source === "osm") {
      addOsm(
        mapOsmCategory(row.category!),
        row,
        row.osmId!,
        row["出入口電梯/無障礙坡道名稱"],
      );
      continue;
    }
    const category =
      row.source === "campus"
        ? mapCampusCategory(row.facType)
        : classifyMetroCategory(row["出入口電梯/無障礙坡道名稱"]);
    const identity =
      row.source === "campus"
        ? `campus:${row.campusId}:${row.facUid}`
        : `metro:${row.項次}`;
    add(category, row, identity);
  }
  for (const row of rows.nearbyOsm) {
    const category = mapOsmCategory(row.category);
    // The same OSM feature also appears in the merged structure list.
    addOsm(category, row, row.osmId, row.name);
  }
  for (const row of rows.nearbyBathroom) {
    add("toilet", row, row._id == null ? undefined : `bathroom:${row._id}`);
  }
  return summary;
}

function withDistances<T extends LocatedRow>(
  rows: T[],
  lat: number,
  lng: number,
  sort: boolean,
): (T & { distanceMeters: number })[] {
  const result = rows.map((row) => {
    const document = row as T & { toObject?: () => T };
    const plain =
      typeof document.toObject === "function" ? document.toObject() : row;
    return {
      ...plain,
      distanceMeters: haversineMeters(
        lat,
        lng,
        row.location.coordinates[1],
        row.location.coordinates[0],
      ),
    };
  });
  return sort
    ? result.sort((a, b) => a.distanceMeters - b.distanceMeters)
    : result;
}

/** Nearby facilities in an optional place extent; existing numeric radii remain supported. */
export async function findNearby(
  lat: number,
  lng: number,
  area: NearbyArea | number = { kind: "radius", radiusM: 150 },
  lang?: SupportedLang,
) {
  const searchArea =
    typeof area === "number"
      ? { kind: "radius" as const, radiusM: area }
      : area;
  const bounds =
    searchArea.kind === "bbox" ? preparePlaceBounds(searchArea.bounds) : null;
  const radiusM = searchArea.kind === "radius" ? searchArea.radiusM : 150;
  const [rows, nearbyCampus, notices] = await Promise.all([
    bounds ? findOwnNearbyInBounds(bounds) : findOwnNearby(lat, lng, radiusM),
    bounds
      ? campusService.findFacilitiesInBounds(bounds)
      : campusService.findFacilitiesNearby(lat, lng, radiusM),
    loadMetroNotices(),
  ]);
  const groups = {
    nearbyMetroA11y: withPlaceNotices(
      mergeA11yPlaces(
        rows.metro,
        rows.osm,
        nearbyCampus.map((f) => campusToA11yPlace(f, lang)),
        lang,
      ),
      notices,
    ),
    nearbyBathroom: rows.bathroom.map((row) => displayFacility(row, lang)),
    nearbyOsm: rows.osm.map((row) => displayFacility(row, lang)),
    nearbyParking: rows.parking.map((row) => displayFacility(row, lang)),
  };
  return {
    nearbyMetroA11y: withDistances(
      groups.nearbyMetroA11y,
      lat,
      lng,
      bounds !== null,
    ),
    nearbyBathroom: withDistances(
      groups.nearbyBathroom,
      lat,
      lng,
      bounds !== null,
    ),
    nearbyOsm: withDistances(groups.nearbyOsm, lat, lng, bounds !== null),
    nearbyParking: withDistances(
      groups.nearbyParking,
      lat,
      lng,
      bounds !== null,
    ),
    summary: summarizeNearby(groups, { lat, lng }),
  };
}

/**
 * The capped variant of {@link findNearby}, used by the agent tools.
 *
 * @param lat Latitude of the search centre
 * @param lng Longitude of the search centre
 * @param radiusM Search radius in metres
 * @returns The nearby place groups, capped per source
 */
export async function findNearbyLimited(
  lat: number,
  lng: number,
  radiusM = 300,
  lang?: SupportedLang,
) {
  const [rows, nearbyCampus, notices] = await Promise.all([
    findOwnNearbyLimited(lat, lng, radiusM),
    campusService.findFacilitiesNearby(lat, lng, radiusM),
    loadMetroNotices(),
  ]);
  return {
    nearbyMetroA11y: withPlaceNotices(
      mergeA11yPlaces(
        rows.metro,
        rows.osm as IOsmA11y[],
        nearbyCampus.slice(0, 15).map((f) => campusToA11yPlace(f, lang)),
        lang,
      ),
      notices,
    ),
    nearbyBathroom: rows.bathroom.map((row) => displayFacility(row, lang)),
    nearbyOsm: rows.osm.map((row) => displayFacility(row, lang)),
    nearbyParking: rows.parking.map((row) => displayFacility(row, lang)),
  };
}

const QUICK_ASSESS_DEFAULT_RADIUS_M = 200;
const QUICK_ASSESS_MIN_RADIUS_M = 50;
const QUICK_ASSESS_MAX_RADIUS_M = 1000;

/**
 * Aggregate existing nearby facilities, active hazard reports and OSM
 * wheelchair tagging into a single pre-trip verdict.
 *
 * @param input Search centre, accessibility mode and optional radius
 * @returns The verdict, its summary sentence and the counts behind it
 */
export async function assessQuickAccess(input: {
  lat: number;
  lng: number;
  mode?: QuickAssessMode;
  radiusM?: number;
}): Promise<QuickAssessResult> {
  const { lat, lng } = input;
  const mode = input.mode ?? "wheelchair";
  const radiusM = Math.min(
    QUICK_ASSESS_MAX_RADIUS_M,
    Math.max(
      QUICK_ASSESS_MIN_RADIUS_M,
      input.radiusM ?? QUICK_ASSESS_DEFAULT_RADIUS_M,
    ),
  );

  const [own, campus, hazard] = await Promise.all([
    countOwnQuickAssess(lat, lng, radiusM),
    campusService.findFacilitiesNearby(lat, lng, radiusM),
    countActiveHazardsNear({ lat, lng }, radiusM).catch(() => 0),
  ]);

  const counts = own.counts;
  for (const f of campus) bumpCategory(counts, mapCampusCategory(f.type));

  // Active verified hazards only: queued, unproven, failed and duplicate
  // re-shot reports must not inflate the pre-trip verdict.
  const activeHazardReports = hazard;

  const verdict = computeVerdict(counts, activeHazardReports, mode);
  const summary = buildQuickAssessSummary(
    counts,
    activeHazardReports,
    verdict,
    mode,
    radiusM,
  );

  return {
    verdict,
    summary,
    facilityCount: counts,
    activeHazardReports,
    wheelchairTagRatio: own.wheelchairTagRatio,
    radiusM,
    mode,
  };
}
