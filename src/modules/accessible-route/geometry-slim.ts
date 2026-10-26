/**
 * Response-edge geometry slimming. Runs after every stage that reads full
 * geometry (hazard matching, facility enrichment, realtime overlays).
 *
 * Transit legs (BUS / METRO / THSR / TRA) carry no index into their polyline,
 * so they are Douglas–Peucker simplified. WALK and road legs are indexed by
 * a11y segments, traffic segments, maneuvers and navigation steps, so they keep
 * every point. Qualified WALK geometry also keeps its source precision so
 * rounding cannot move a boundary point outside its clipped legal surface.
 */

import { roundCoordinate, simplifyPath } from "../../utils/geo";
import type { AccessibleRoute } from "../../types/route";

export const TRANSIT_SIMPLIFY_TOLERANCE_M = 5;

const SIMPLIFIABLE_LEG_TYPES = new Set(["BUS", "METRO", "THSR", "TRA"]);

/**
 * Slim transport geometry without changing qualified walking geometry.
 *
 * @param routes The finalized routes.
 */
export function slimRouteGeometry(routes: AccessibleRoute[]): void {
  for (const route of routes) {
    for (const leg of route.legs) {
      if (
        leg.type === "WALK" &&
        (leg.walkingPolicy?.version === "sidewalk-v1" ||
          leg.walkingPolicy?.version === "otp-sidewalk-v1")
      )
        continue;
      leg.polyline = SIMPLIFIABLE_LEG_TYPES.has(leg.type)
        ? simplifyPath(leg.polyline, TRANSIT_SIMPLIFY_TOLERANCE_M).map(
            roundCoordinate,
          )
        : leg.polyline.map(roundCoordinate);
      if (leg.type === "DRIVE" || leg.type === "MOTORCYCLE") {
        for (const step of leg.steps ?? []) {
          step.polyline = step.polyline.map(roundCoordinate);
        }
      }
    }
  }
}
