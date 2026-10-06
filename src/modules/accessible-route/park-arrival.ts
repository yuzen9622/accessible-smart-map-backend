import type { IParkEntrance } from "../../types";
import type { AccessibilityMode } from "../../types/route";
import { haversineMeters } from "../../utils/geo";
import type { ArrivalEntrance, LatLng } from "./accessible-route.types";
import { WHEELCHAIR_MIN_EFFECTIVE_WIDTH_M } from "./planners/pedestrian-a11y/cost";

/**
 * How far from a geocoded text destination a park's entrances are searched.
 * Only used for name matching; the entrance finally chosen can be farther,
 * since every entrance of the matched park is considered.
 */
export const PARK_NAME_SEARCH_RADIUS_M = 600;

/** A destination this close to an entrance already is that entrance (a reroute, or a tapped entrance). */
export const AT_ENTRANCE_TOLERANCE_M = 1;

/** Ramp gradient limit (1:12) applied when the caller set no `maxSlopePercent`. */
export const PARK_ENTRANCE_DEFAULT_MAX_SLOPE_PERCENT = 8.33;

/** Shortest text that may match as a fragment of a longer park name ("天母公園" in "1號天母公園"). */
const MIN_PARTIAL_NAME_LENGTH = 3;

/** Data the resolver needs; implemented by the a11y module, faked in tests. */
export interface ParkArrivalLookup {
  findCandidates(
    point: LatLng,
    radiusM: number,
  ): Promise<{
    containingParks: string[];
    nearbyEntrances: IParkEntrance[];
    parksWithArea: string[];
  }>;
  findEntrancesOfParks(parkNames: string[]): Promise<IParkEntrance[]>;
}

export type ParkArrival =
  | { kind: "entrance"; entrance: ArrivalEntrance }
  | { kind: "no_qualifying"; parkName: string };

export interface ParkArrivalInput {
  /** The caller's destination text; undefined when they gave coordinates. */
  destinationText?: string;
  requested: LatLng;
  origin: LatLng;
  mode: AccessibilityMode;
  maxSlopePercent?: number;
}

interface EntranceThresholds {
  minWidthM?: number;
  maxSlopePercent?: number;
}

function normalizeName(name: string): string {
  return name
    .normalize("NFKC")
    .replace(/\s+/g, "")
    .replace(/台/g, "臺")
    .replace(/^臺北市/, "");
}

/**
 * @param text The caller's destination text.
 * @param parkName A park name from the dataset.
 * @returns Whether the text names that park, wholly or as a distinctive fragment.
 */
export function destinationNamesPark(text: string, parkName: string): boolean {
  const t = normalizeName(text);
  const p = normalizeName(parkName);
  if (!t || !p) return false;
  return (
    t.includes(p) || (t.length >= MIN_PARTIAL_NAME_LENGTH && p.includes(t))
  );
}

/**
 * @param mode The trip's accessibility mode.
 * @param maxSlopePercent The caller's slope limit, if any.
 * @returns The limits an entrance must meet; an absent limit is not checked.
 */
export function entranceThresholds(
  mode: AccessibilityMode,
  maxSlopePercent: number | undefined,
): EntranceThresholds {
  if (mode === "wheelchair") {
    return {
      minWidthM: WHEELCHAIR_MIN_EFFECTIVE_WIDTH_M,
      maxSlopePercent:
        maxSlopePercent ?? PARK_ENTRANCE_DEFAULT_MAX_SLOPE_PERCENT,
    };
  }
  if (mode === "elderly") {
    return {
      maxSlopePercent:
        maxSlopePercent ?? PARK_ENTRANCE_DEFAULT_MAX_SLOPE_PERCENT,
    };
  }
  return maxSlopePercent === undefined ? {} : { maxSlopePercent };
}

/**
 * An unmeasured width or slope fails a limit that applies to it: an entrance
 * is only promised to a user when the survey shows it meets their need.
 */
function qualifies(
  entrance: IParkEntrance,
  limits: EntranceThresholds,
): boolean {
  if (
    limits.minWidthM !== undefined &&
    (entrance.minClearWidthM === null ||
      entrance.minClearWidthM < limits.minWidthM)
  ) {
    return false;
  }
  if (
    limits.maxSlopePercent !== undefined &&
    (entrance.slopePercent === null ||
      entrance.slopePercent > limits.maxSlopePercent)
  ) {
    return false;
  }
  return true;
}

function toLatLng(entrance: IParkEntrance): LatLng {
  const [lng, lat] = entrance.location.coordinates;
  return { lat, lng };
}

function distanceM(a: LatLng, b: LatLng): number {
  return haversineMeters(a.lat, a.lng, b.lat, b.lng);
}

function toArrival(entrance: IParkEntrance, requested: LatLng): ParkArrival {
  const location = toLatLng(entrance);
  return {
    kind: "entrance",
    entrance: {
      parkName: entrance.parkName,
      entranceName: entrance.entranceName,
      location,
      minClearWidthM: entrance.minClearWidthM,
      slopePercent: entrance.slopePercent,
      distanceFromRequestedM: Math.round(distanceM(location, requested)),
    },
  };
}

/** Park names in order of their nearest entrance, followed by any park known only by area. */
function parksByProximity(
  nearbyEntrances: IParkEntrance[],
  containingParks: string[],
): string[] {
  return [
    ...new Set([
      ...nearbyEntrances.map((entrance) => entrance.parkName),
      ...containingParks,
    ]),
  ];
}

/**
 * Decide whether a destination is a park and, if so, which accessible
 * entrance the route should end at.
 *
 * A destination is a park when:
 * - coordinates fall inside a park's stored area; or
 * - text names a park, and its geocoded point is inside that park's area or,
 *   for a park with no stored area, within {@link PARK_NAME_SEARCH_RADIUS_M}
 *   of its entrances. Requiring the area keeps "大安森林公園站" — which names
 *   the park but geocodes outside it — at the station.
 * A destination already at an entrance keeps it (reroutes resend the chosen
 * entrance). Of the park's entrances meeting the mode's width and slope
 * limits, the one nearest the origin in a straight line is chosen.
 *
 * @param input Destination, origin and the user's limits.
 * @param lookup Park data access.
 * @returns The chosen entrance, a park with no qualifying entrance, or null when the destination is not a park.
 */
export async function resolveParkArrival(
  input: ParkArrivalInput,
  lookup: ParkArrivalLookup,
): Promise<ParkArrival | null> {
  const { requested } = input;
  const candidates = await lookup.findCandidates(
    requested,
    PARK_NAME_SEARCH_RADIUS_M,
  );
  const atEntrance = candidates.nearbyEntrances.find(
    (entrance) =>
      distanceM(toLatLng(entrance), requested) <= AT_ENTRANCE_TOLERANCE_M,
  );
  if (atEntrance) return toArrival(atEntrance, requested);

  const parks = parksByProximity(
    candidates.nearbyEntrances,
    candidates.containingParks,
  );
  const text = input.destinationText;
  let parkName: string | undefined;
  if (text === undefined) {
    parkName = parks.find((name) => candidates.containingParks.includes(name));
  } else {
    const named = parks.filter((name) => destinationNamesPark(text, name));
    parkName =
      named.find((name) => candidates.containingParks.includes(name)) ??
      named.find((name) => !candidates.parksWithArea.includes(name));
  }
  if (parkName === undefined) return null;

  const limits = entranceThresholds(input.mode, input.maxSlopePercent);
  const usable = (await lookup.findEntrancesOfParks([parkName])).filter(
    (entrance) => qualifies(entrance, limits),
  );
  if (usable.length === 0) return { kind: "no_qualifying", parkName };

  const nearestToOrigin = usable.reduce((best, entrance) =>
    distanceM(toLatLng(entrance), input.origin) <
    distanceM(toLatLng(best), input.origin)
      ? entrance
      : best,
  );
  return toArrival(nearestToOrigin, requested);
}

/**
 * @param entrance The entrance a route was led to.
 * @returns The accessibility highlight describing it.
 */
export function arrivalEntranceHighlight(entrance: ArrivalEntrance): string {
  const measured = [
    entrance.minClearWidthM === null
      ? null
      : `淨寬 ${entrance.minClearWidthM} 公尺`,
    entrance.slopePercent === null ? null : `坡度 ${entrance.slopePercent}%`,
  ].filter((part): part is string => part !== null);
  return (
    `已為您導引至「${entrance.parkName}」${entrance.entranceName}（無障礙出入口` +
    (measured.length ? `，${measured.join("、")}` : "") +
    "）"
  );
}
