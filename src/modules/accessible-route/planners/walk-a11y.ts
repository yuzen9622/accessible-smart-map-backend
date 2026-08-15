/**
 * Pure WALK-leg accessibility detail derivation.
 *
 * Production planners currently initialise WALK `a11yFacilities` as empty and
 * do not have route-wide surface/elevation coverage. This helper therefore
 * exposes unknowns by default. When a caller has already attached genuine OSM
 * facilities, it derives only observations that their tags support; it never
 * queries data or treats a missing tag as a negative measurement.
 */

import { haversineCoords } from "../../../utils/geo";
import type { WalkA11yDetails } from "../../../types/route";

type Coord = [number, number];

/** Structural subset shared by full and slim OSM facility response objects. */
export interface WalkA11yFacility {
  osmId?: string;
  category?: string;
  wheelchair?: string;
  tags?: Record<string, unknown>;
  location?: { coordinates?: readonly unknown[] };
}

const PAVED_SURFACES = new Set([
  "paved",
  "asphalt",
  "concrete",
  "concrete:lanes",
  "concrete:plates",
  "paving_stones",
  "sett",
  "cobblestone",
  "bricks",
  "tiles",
]);
const GRAVEL_SURFACES = new Set(["gravel", "fine_gravel"]);
const FALSE_VALUES = new Set(["no", "false", "0"]);
const ACCESSIBLE_VALUES = new Set(["yes", "designated", "true", "1"]);
const CURB_RAMP_VALUES = new Set(["flush", "lowered", "rolled"]);
const DECIMAL = "[+-]?(?:\\d+(?:[.,]\\d+)?|\\.\\d+)";

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function parseDecimal(value: string): number | null {
  if (!new RegExp(`^${DECIMAL}$`).test(value)) return null;
  const parsed = Number(value.replace(",", "."));
  return Number.isFinite(parsed) ? parsed : null;
}

function normalized(value: unknown): string | null {
  if (typeof value === "string") {
    const trimmed = value.trim().toLowerCase();
    return trimmed || null;
  }
  const numeric = finiteNumber(value);
  return numeric === null ? null : String(numeric);
}

function tag(facility: WalkA11yFacility, key: string): string | null {
  return normalized(facility.tags?.[key]);
}

function rawTag(facility: WalkA11yFacility, key: string): unknown {
  return facility.tags?.[key];
}

function roundToTwo(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * Parse OSM's documented incline forms into a positive percentage. Bare
 * numbers are OSM percentages; degree and gradient-ratio forms are converted
 * only when their unit makes that conversion unambiguous.
 */
function parseInclinePercent(value: unknown): number | null {
  const numeric = finiteNumber(value);
  if (numeric !== null) return Math.abs(numeric);
  if (typeof value !== "string") return null;

  const raw = value.trim().toLowerCase();
  const ratio = raw.match(new RegExp(`^(${DECIMAL})\\s*:\\s*(${DECIMAL})$`));
  if (ratio) {
    const rise = parseDecimal(ratio[1]);
    const run = parseDecimal(ratio[2]);
    if (rise === null || run === null || run === 0) return null;
    return roundToTwo(Math.abs((rise / run) * 100));
  }

  const matched = raw.match(
    new RegExp(`^([±]?${DECIMAL})\\s*(%|°|deg(?:rees?)?)?$`),
  );
  if (!matched) return null;
  const magnitude = parseDecimal(matched[1].replace("±", ""));
  if (magnitude === null) return null;
  const unit = matched[2];
  if (!unit || unit === "%") return Math.abs(magnitude);
  if (Math.abs(magnitude) >= 90) return null;
  return roundToTwo(Math.abs(Math.tan((magnitude * Math.PI) / 180) * 100));
}

/** OSM's bare `width` values are metres; explicit units are converted exactly. */
function parseWidthCm(value: unknown): number | null {
  const numeric = finiteNumber(value);
  if (numeric !== null) return numeric > 0 ? roundToTwo(numeric * 100) : null;
  if (typeof value !== "string") return null;

  const raw = value.trim().toLowerCase();
  const feetAndInches = raw.match(
    new RegExp(
      `^(${DECIMAL})\\s*(?:ft|feet|foot|')\\s*(${DECIMAL})\\s*(?:in|inch(?:es)?|\")$`,
    ),
  );
  if (feetAndInches) {
    const feet = parseDecimal(feetAndInches[1]);
    const inches = parseDecimal(feetAndInches[2]);
    if (feet === null || inches === null) return null;
    const centimetres = feet * 30.48 + inches * 2.54;
    return centimetres > 0 ? roundToTwo(centimetres) : null;
  }

  const matched = raw.match(
    new RegExp(
      `^(${DECIMAL})\\s*(mm|cm|m|metre(?:s)?|meter(?:s)?|ft|feet|foot|in|inch(?:es)?|')?$`,
    ),
  );
  if (!matched) return null;
  const amount = parseDecimal(matched[1]);
  if (amount === null || amount <= 0) return null;
  switch (matched[2] ?? "m") {
    case "mm":
      return roundToTwo(amount / 10);
    case "cm":
      return roundToTwo(amount);
    case "ft":
    case "feet":
    case "foot":
    case "'":
      return roundToTwo(amount * 30.48);
    case "in":
    case "inch":
    case "inches":
      return roundToTwo(amount * 2.54);
    default:
      return roundToTwo(amount * 100);
  }
}

function isCrossing(facility: WalkA11yFacility): boolean {
  if (tag(facility, "highway") === "crossing") return true;
  if (tag(facility, "footway") === "crossing") return true;
  const crossing = tag(facility, "crossing");
  return crossing !== null && !FALSE_VALUES.has(crossing);
}

function hasCurbRamp(facility: WalkA11yFacility): boolean {
  const category = normalized(facility.category);
  if (category === "kerb_cut" || category === "ramp") return true;
  if (tag(facility, "highway") === "dropped_kerb") return true;
  if (CURB_RAMP_VALUES.has(tag(facility, "kerb") ?? "")) return true;
  return (
    ACCESSIBLE_VALUES.has(tag(facility, "ramp:wheelchair") ?? "") ||
    ACCESSIBLE_VALUES.has(tag(facility, "ramp") ?? "")
  );
}

function isAccessibleToilet(facility: WalkA11yFacility): boolean {
  const category = normalized(facility.category);
  const amenity = tag(facility, "amenity");
  const isToilet =
    category === "toilet" || amenity === "toilet" || amenity === "toilets";
  if (!isToilet) return false;
  return (
    ACCESSIBLE_VALUES.has(tag(facility, "toilets:wheelchair") ?? "") ||
    ACCESSIBLE_VALUES.has(tag(facility, "wheelchair") ?? "") ||
    ACCESSIBLE_VALUES.has(normalized(facility.wheelchair) ?? "")
  );
}

function facilityCoord(facility: WalkA11yFacility): Coord | null {
  const coordinates = facility.location?.coordinates;
  if (!coordinates || coordinates.length < 2) return null;
  const lng = finiteNumber(coordinates[0]);
  const lat = finiteNumber(coordinates[1]);
  if (
    lng === null ||
    lat === null ||
    lng < -180 ||
    lng > 180 ||
    lat < -90 ||
    lat > 90
  ) {
    return null;
  }
  return [lng, lat];
}

function isValidCoord(coord: Coord): boolean {
  return (
    Number.isFinite(coord[0]) &&
    Number.isFinite(coord[1]) &&
    coord[0] >= -180 &&
    coord[0] <= 180 &&
    coord[1] >= -90 &&
    coord[1] <= 90
  );
}

/**
 * Distance along the input polyline to the point nearest `target`. This is not
 * a detour estimate: it is only the route-progress position of an OSM feature.
 */
function distanceAlongPolyline(
  target: Coord,
  polyline: readonly Coord[],
): number | null {
  if (polyline.length < 2 || polyline.some((coord) => !isValidCoord(coord))) {
    return null;
  }

  let accumulatedM = 0;
  let closestDistanceM = Infinity;
  let closestAlongM = 0;
  for (let index = 1; index < polyline.length; index++) {
    const start = polyline[index - 1];
    const end = polyline[index];
    const segmentM = haversineCoords(start, end);
    if (segmentM === 0) continue;

    // Equirectangular projection is sufficiently accurate for selecting the
    // nearest point on a single city-scale route segment; route distance itself
    // continues to use the shared great-circle helper above.
    const latScale = 111_320;
    const lngScale =
      latScale *
      Math.cos((((start[1] + end[1] + target[1]) / 3) * Math.PI) / 180);
    const dx = (end[0] - start[0]) * lngScale;
    const dy = (end[1] - start[1]) * latScale;
    const targetX = (target[0] - start[0]) * lngScale;
    const targetY = (target[1] - start[1]) * latScale;
    const denominator = dx * dx + dy * dy;
    const fraction =
      denominator === 0
        ? 0
        : Math.max(0, Math.min(1, (targetX * dx + targetY * dy) / denominator));
    const nearest: Coord = [
      start[0] + (end[0] - start[0]) * fraction,
      start[1] + (end[1] - start[1]) * fraction,
    ];
    const distanceToRouteM = haversineCoords(target, nearest);
    if (distanceToRouteM < closestDistanceM) {
      closestDistanceM = distanceToRouteM;
      closestAlongM = accumulatedM + segmentM * fraction;
    }
    accumulatedM += segmentM;
  }

  return Number.isFinite(closestDistanceM) ? Math.round(closestAlongM) : null;
}

function facilityKey(facility: WalkA11yFacility, index: number): string {
  return facility.osmId?.trim() || `facility-${index}`;
}

/**
 * Return a fresh explicit unknown shape for WALK legs without source-backed
 * measurements. Empty restPoints means no tagged accessible toilet is attached
 * to this leg; it does not prove none exists nearby.
 */
export function unknownWalkA11yDetails(): WalkA11yDetails {
  return {
    maxSlopePercent: null,
    crossings: null,
    crossingsWithCurbRamp: null,
    minPathWidthCm: null,
    surfaceType: "unknown",
    restPoints: [],
  };
}

/**
 * Derive additive WALK-leg details from facilities already attached to that
 * leg. All values are observations of available OSM tags rather than a claim
 * of route-wide coverage; missing evidence remains null / unknown.
 *
 * @param facilities Existing full or slim OSM facilities; never queried here.
 * @param polyline Routed WALK geometry in [lng, lat] order.
 * @returns A fresh response-ready detail shape.
 */
export function deriveWalkA11yDetails(
  facilities: readonly WalkA11yFacility[],
  polyline: readonly Coord[],
): WalkA11yDetails {
  const slopes: number[] = [];
  const widthsCm: number[] = [];
  const surfaces = new Set<"paved" | "gravel">();
  const crossingKeys = new Set<string>();
  const crossingWithCurbRampKeys = new Set<string>();
  const restPoints: WalkA11yDetails["restPoints"] = [];
  const restPointKeys = new Set<string>();

  facilities.forEach((facility, index) => {
    const incline = parseInclinePercent(rawTag(facility, "incline"));
    if (incline !== null) slopes.push(incline);

    const widthCm = parseWidthCm(rawTag(facility, "width"));
    if (widthCm !== null) widthsCm.push(widthCm);

    const surface = tag(facility, "surface");
    if (surface && PAVED_SURFACES.has(surface)) surfaces.add("paved");
    if (surface && GRAVEL_SURFACES.has(surface)) surfaces.add("gravel");

    const key = facilityKey(facility, index);
    if (isCrossing(facility)) {
      crossingKeys.add(key);
      if (hasCurbRamp(facility)) crossingWithCurbRampKeys.add(key);
    }

    if (!isAccessibleToilet(facility) || restPointKeys.has(key)) return;
    const coords = facilityCoord(facility);
    if (!coords) return;
    const distanceM = distanceAlongPolyline(coords, polyline);
    if (distanceM === null) return;
    restPointKeys.add(key);
    restPoints.push({ type: "accessible_toilet", distanceM });
  });

  restPoints.sort((a, b) => a.distanceM - b.distanceM);
  return {
    maxSlopePercent: slopes.length ? Math.max(...slopes) : null,
    crossings: crossingKeys.size ? crossingKeys.size : null,
    // An untagged kerb is unknown, not a claim that no curb ramp exists.
    crossingsWithCurbRamp: crossingWithCurbRampKeys.size
      ? crossingWithCurbRampKeys.size
      : null,
    minPathWidthCm: widthsCm.length ? Math.min(...widthsCm) : null,
    // Mixed point tags cannot describe one whole-leg surface honestly.
    surfaceType: surfaces.size === 1 ? [...surfaces][0] : "unknown",
    restPoints,
  };
}
