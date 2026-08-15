import * as campusService from "../campus/campus.service";
import type { CampusFacilityPlace } from "../campus/campus.service";
import { findNearby as findNearbyReports } from "../hazard-report/hazard-report.service";
import {
  bumpCategory,
  computeVerdict,
  buildQuickAssessSummary,
  countOwnQuickAssess,
  findOwnBathroomFacilities,
  findOwnElevatorFacilities,
  findOwnFacilityGroups,
  findOwnNearby,
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
export function campusToA11yPlace(f: CampusFacilityPlace): A11yPlace {
  return {
    項次: f.facUid,
    "出入口電梯/無障礙坡道名稱": f.name ?? f.facType ?? "校園無障礙設施",
    location: f.location,
    source: "campus",
    campusId: f.campusId,
    schoolName: f.schoolName,
    facUid: f.facUid,
    facType: f.type,
    facTypeLabel: f.facType,
  };
}

function campusToFacility(f: CampusFacilityPlace): A11yFacility {
  return {
    _id: f.facUid,
    name: f.name ?? f.facType ?? "校園無障礙設施",
    location: f.location,
    category: mapCampusCategory(f.type),
    source: "campus",
    schoolName: f.schoolName,
  };
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
): Promise<A11yFacility[]> {
  const want = categories && categories.length > 0 ? new Set(categories) : null;
  const [own, campus] = await Promise.all([
    findOwnFacilityGroups(categories),
    campusService.findAllFacilities(),
  ]);
  const facilities = [
    ...own.metro,
    ...own.osm,
    ...campus.slice(0, A11Y_MAX_RESULTS).map(campusToFacility),
    ...own.bathroom,
    ...own.parking,
  ];
  return want ? facilities.filter((f) => want.has(f.category)) : facilities;
}

/**
 * Elevator facilities only: metro names containing 電梯, OSM `elevator`, and
 * campus facilities whose resolved type code is `elevator`.
 */
export async function findElevatorFacilities(): Promise<A11yFacility[]> {
  const [own, campus] = await Promise.all([
    findOwnElevatorFacilities(),
    campusService.findAllFacilities(),
  ]);
  return [
    ...own,
    ...campus
      .filter((f) => f.type === "elevator")
      .slice(0, A11Y_MAX_RESULTS)
      .map(campusToFacility),
  ];
}

/**
 * Ramp facilities only: metro names containing 坡道 but NOT 電梯 (mutually
 * exclusive with the elevator route), OSM `ramp`, and campus `ramp`.
 */
export async function findRampFacilities(): Promise<A11yFacility[]> {
  const [own, campus] = await Promise.all([
    findOwnRampFacilities(),
    campusService.findAllFacilities(),
  ]);
  return [
    ...own,
    ...campus
      .filter((f) => f.type === "ramp")
      .slice(0, A11Y_MAX_RESULTS)
      .map(campusToFacility),
  ];
}

/**
 * Accessible bathroom facilities: the bathroom collection, OSM `toilet`, and
 * campus `accessible_toilet`. Metro has no bathroom data.
 */
export async function findBathroomFacilities(): Promise<A11yFacility[]> {
  const [own, campus] = await Promise.all([
    findOwnBathroomFacilities(),
    campusService.findAllFacilities(),
  ]);
  return [
    ...own,
    ...campus
      .filter((f) => f.type === "accessible_toilet")
      .slice(0, A11Y_MAX_RESULTS)
      .map(campusToFacility),
  ];
}

/**
 * Accessible places near a point, with campus facilities folded into the
 * unified metro/OSM list.
 *
 * @param lat Latitude of the search centre
 * @param lng Longitude of the search centre
 * @param radiusM Search radius in metres
 * @returns The nearby place groups
 */
export async function findNearby(lat: number, lng: number, radiusM = 150) {
  const [rows, nearbyCampus] = await Promise.all([
    findOwnNearby(lat, lng, radiusM),
    campusService.findFacilitiesNearby(lat, lng, radiusM),
  ]);
  return {
    nearbyMetroA11y: mergeA11yPlaces(
      rows.metro,
      rows.osm as IOsmA11y[],
      nearbyCampus.map(campusToA11yPlace),
    ),
    nearbyBathroom: rows.bathroom,
    nearbyOsm: rows.osm,
    nearbyParking: rows.parking,
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
) {
  const [rows, nearbyCampus] = await Promise.all([
    findOwnNearbyLimited(lat, lng, radiusM),
    campusService.findFacilitiesNearby(lat, lng, radiusM),
  ]);
  return {
    nearbyMetroA11y: mergeA11yPlaces(
      rows.metro,
      rows.osm as IOsmA11y[],
      nearbyCampus.slice(0, 15).map(campusToA11yPlace),
    ),
    nearbyBathroom: rows.bathroom,
    nearbyOsm: rows.osm,
    nearbyParking: rows.parking,
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
    findNearbyReports({ lat, lng, radius: radiusM }).catch(() => null),
  ]);

  const counts = own.counts;
  for (const f of campus) bumpCategory(counts, mapCampusCategory(f.type));

  const activeHazardReports =
    hazard && hazard.ok && hazard.data
      ? ((hazard.data as { total?: number }).total ?? 0)
      : 0;

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
