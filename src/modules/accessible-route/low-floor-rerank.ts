/**
 * Top-3 boarding-accessibility tie-break.
 *
 * Runs after the realtime overlay, using only scores that are already computed:
 * routeCost is recomputed per route and reduced by a boarding credit capped at
 * 4 (cost minutes). That cap IS the maximum swap distance — two routes further
 * apart than 4 in base cost can never trade places — so this is a tie-breaker,
 * not a re-scoring.
 */

import { routeCost } from "./scoring";
import type {
  AccessibilityMode,
  AccessibleRoute,
  BusLeg,
  MetroLeg,
  ThsrLeg,
  TraLeg,
} from "../../types/route";

const CREDIT_STEP_FREE = 4;
const CREDIT_UNKNOWN = 2;
const CREDIT_HIGH_FLOOR = 0;

type TransitLeg = BusLeg | MetroLeg | ThsrLeg | TraLeg;

function firstTransitLeg(route: AccessibleRoute): TransitLeg | undefined {
  const leg = route.legs.find((l) => l.type !== "WALK");
  if (!leg) return undefined;
  return leg.type === "DRIVE" || leg.type === "MOTORCYCLE"
    ? undefined
    : (leg as TransitLeg);
}

/**
 * Boarding-accessibility credit in [0, CREDIT_STEP_FREE]. Unknown always ranks
 * above a confirmed high-floor boarding.
 *
 * @param route The route to assess.
 * @returns The credit to subtract from the route's cost.
 */
function boardingCredit(route: AccessibleRoute): number {
  if ((route.hazardAdvisory?.blockingOnRoute ?? 0) > 0) return 0;
  const leg = firstTransitLeg(route);
  if (!leg || leg.type !== "BUS") return CREDIT_STEP_FREE;
  if (leg.isLowFloor === true) return CREDIT_STEP_FREE;
  if (leg.isLowFloor === false) return CREDIT_HIGH_FLOOR;
  return CREDIT_UNKNOWN;
}

function busBoardingEvidence(route: AccessibleRoute): boolean {
  const leg = firstTransitLeg(route);
  return leg?.type === "BUS" && leg.isLowFloor !== undefined;
}

/**
 * Reorder `routes` in place. Leaves the array untouched unless every
 * precondition holds: at least two routes, no future-scheduled route pinned by
 * retainEarliestFutureRoute, scoring already applied, and at least one route
 * with real low-floor evidence.
 *
 * @param routes The final top-N routes, reordered in place.
 * @param mode Accessibility mode driving the cost profile.
 */
export function rerankByLowFloor(
  routes: AccessibleRoute[],
  mode: AccessibilityMode,
): void {
  if (routes.length < 2) return;
  if (routes.some((r) => r._isFutureScheduled === true)) return;
  if (routes.some((r) => typeof r.accessibilityScore !== "number")) return;
  if (!routes.some(busBoardingEvidence)) return;

  const scored = routes.map((route, index) => ({
    route,
    index,
    adjusted:
      routeCost(
        route.totalMinutes,
        route.transferCount,
        route.accessibilityScore as number,
        mode,
        route.totalWalkDistanceM ?? 0,
      ) - boardingCredit(route),
  }));

  scored.sort((a, b) => a.adjusted - b.adjusted || a.index - b.index);
  for (let i = 0; i < scored.length; i++) routes[i] = scored[i].route;
}
