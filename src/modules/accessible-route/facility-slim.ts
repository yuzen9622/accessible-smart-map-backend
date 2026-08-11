/**
 * Response payload slimming for OSM a11y facilities.
 *
 * Every leg's facility arrays embed the FULL OsmA11y document — up to ~50
 * `tags` fields, ~2KB per facility, and the same facility repeats across
 * adjacent transit/walk legs. `slimRoutes` (always on) projects each facility
 * down to the fields the frontend and re-scoring endpoints actually consume.
 * `compactRoutes` (opt-in via body `format: "compact"`) dedupes facilities into
 * a route-level `facilities` dictionary keyed by osmId, leaving each leg with an
 * empty array plus `a11yRefs` (osmId references). Full documents stay available
 * via GET /api/a11y/place.
 */

import type { IOsmA11y } from "../../types";
import type {
  AccessibleRoute,
  WalkLeg,
  BusLeg,
  MetroLeg,
  ThsrLeg,
  TraLeg,
  SlimA11y,
} from "../../types/route";

export type { SlimA11y } from "../../types/route";
import type { AnyLeg } from "./accessible-route.types";

const A11Y_TAG_WHITELIST = new Set<string>([
  "wheelchair",
  "elevator",
  "highway",
  "footway",
  "ramp:wheelchair",
  "ramp",
  "handrail",
  "kerb",
  "smoothness",
  "surface",
  "width",
  "incline",
  "toilets:wheelchair",
  "traffic_signals:sound",
  "traffic_signals:vibration",
  "tactile_paving",
  "crossing",
  "pedestrian arcade:wheelchair",
  "shelter",
  "bench",
  "automatic_door",
  "door",
  "lit",
  "capacity:disabled",
  "name",
  "opening_hours",
  "level",
  "amenity",
]);

/**
 * Project one facility document down to the slim response shape.
 *
 * @param f Full OSM a11y facility document.
 * @returns The slimmed facility (whitelisted tags only).
 */
export function slimFacility(f: IOsmA11y): SlimA11y {
  const slim: SlimA11y = {
    osmId: f.osmId,
    category: f.category,
    location: f.location,
  };
  if (f.name) slim.name = f.name;
  if (f.wheelchair) slim.wheelchair = f.wheelchair;
  const src = f.tags ?? {};
  let tags: Record<string, string> | undefined;
  for (const key of Object.keys(src)) {
    if (!A11Y_TAG_WHITELIST.has(key)) continue;
    (tags ??= {})[key] = src[key];
  }
  if (tags) slim.tags = tags;
  return slim;
}

/**
 * The facility-array property names a leg carries, by leg type. The leg
 * interfaces type them as IOsmA11y[]; after slimming they hold SlimA11y objects
 * (a structural subset), so the in-place replacement casts once and stays
 * contained to this module.
 *
 * @param leg Leg whose facility-array keys are needed.
 * @returns The property names holding facility arrays for this leg type.
 */
function facilityArrayKeys(leg: AnyLeg): string[] {
  switch (leg.type) {
    case "WALK":
      return ["a11yFacilities"];
    case "BUS":
      return ["departureStopA11y", "arrivalStopA11y"];
    default:
      return ["departureStationA11y", "arrivalStationA11y"];
  }
}

/**
 * Replace every facility array's documents with slim projections, in place.
 *
 * @param routes Routes whose leg facility arrays are slimmed.
 */
export function slimRoutes(routes: AccessibleRoute[]): void {
  for (const route of routes) {
    for (const leg of route.legs) {
      const bag = leg as unknown as Record<string, unknown>;
      for (const key of facilityArrayKeys(leg)) {
        const arr = bag[key];
        if (Array.isArray(arr)) bag[key] = arr.map(slimFacility);
      }
      if (leg.type === "BUS") delete bag.cityCode;
    }
  }
}

/**
 * Per route, move (already slim) facilities into a route-level dictionary keyed
 * by osmId; each leg keeps an empty array plus `a11yRefs`. Run AFTER slimRoutes.
 *
 * @param routes Routes to compact in place.
 */
export function compactRoutes(routes: AccessibleRoute[]): void {
  for (const route of routes) {
    const facilities: Record<string, SlimA11y> = {};
    for (const leg of route.legs) {
      const bag = leg as unknown as Record<string, unknown>;
      const refs = new Set<string>();
      for (const key of facilityArrayKeys(leg)) {
        const arr = bag[key];
        if (!Array.isArray(arr)) continue;
        for (const f of arr as SlimA11y[]) {
          facilities[f.osmId] ??= f;
          refs.add(f.osmId);
        }
        bag[key] = [];
      }
      if (refs.size) bag.a11yRefs = [...refs];
    }
    route.facilities = facilities;
  }
}
