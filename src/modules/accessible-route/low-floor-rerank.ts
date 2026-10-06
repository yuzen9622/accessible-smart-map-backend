/**
 * Top-3 boarding-accessibility tie-break.
 *
 * Runs after the realtime overlay, using only scores that are already computed:
 * routeCost is recomputed per route and reduced by a boarding credit capped at
 * 4 (cost minutes). That cap IS the maximum swap distance — two routes further
 * apart than 4 in base cost can never trade places — so this is a tie-breaker,
 * not a re-scoring.
 */

import { transitPreferencePenalty } from "./planners/transit-preference";
import { routeCost } from "./scoring";
import { getRoutingConfig } from "../../config/routing";
import type { RouteLowFloorEvidence } from "../../types";
import type {
  AccessibilityMode,
  TransitPreference,
  AccessibleRoute,
  BusLeg,
  MetroLeg,
  ThsrLeg,
  TraLeg,
} from "../../types/route";

const CREDIT_STEP_FREE = 4;
const CREDIT_UNKNOWN = 2;
const CREDIT_HIGH_FLOOR = 0;
/**
 * A route's low-floor history only says how often this route ran low-floor
 * buses, not which bus comes next, so its credit stays strictly inside the
 * range a confirmed live plate earns: an all-low-floor history is worth less
 * than a confirmed low-floor bus, an all-high-floor history more than a
 * confirmed high-floor one. Half-and-half lands on CREDIT_UNKNOWN.
 */
const CREDIT_HISTORY_MIN = 1;
const CREDIT_HISTORY_MAX = 3;

type TransitLeg = BusLeg | MetroLeg | ThsrLeg | TraLeg;

function firstTransitLeg(route: AccessibleRoute): TransitLeg | undefined {
  const leg = route.legs.find((l) => l.type !== "WALK");
  if (!leg) return undefined;
  return leg.type === "DRIVE" || leg.type === "MOTORCYCLE"
    ? undefined
    : (leg as TransitLeg);
}

/** Route low-floor history keyed by TDX sub-route uid. */
export type RouteLowFloorHistory = Map<string, RouteLowFloorEvidence>;

/**
 * The low-floor share of a route's history, or undefined when the sample is
 * too small or too many observed plates have an unknown car type.
 *
 * @param evidence The route's history, if any.
 * @returns The share of type-known plates that were low-floor.
 */
export function usableLowFloorShare(
  evidence: RouteLowFloorEvidence | undefined,
): number | undefined {
  if (!evidence || evidence.knownTypePlates === 0) return undefined;
  const { minDistinctPlates, minTypeCoverage } =
    getRoutingConfig().lowFloorEvidence;
  if (evidence.distinctPlates < minDistinctPlates) return undefined;
  if (evidence.knownTypePlates / evidence.distinctPlates < minTypeCoverage) {
    return undefined;
  }
  return evidence.lowFloorPlates / evidence.knownTypePlates;
}

/**
 * Boarding-accessibility credit in [0, CREDIT_STEP_FREE]. Unknown always ranks
 * above a confirmed high-floor boarding; route history only applies when the
 * live plate is unknown.
 *
 * @param route The route to assess.
 * @param history Route low-floor history by sub-route uid.
 * @returns The credit to subtract from the route's cost.
 */
function boardingCredit(
  route: AccessibleRoute,
  history?: RouteLowFloorHistory,
): number {
  if ((route.hazardAdvisory?.blockingOnRoute ?? 0) > 0) return 0;
  const leg = firstTransitLeg(route);
  if (!leg || leg.type !== "BUS") return CREDIT_STEP_FREE;
  if (leg.isLowFloor === true) return CREDIT_STEP_FREE;
  if (leg.isLowFloor === false) return CREDIT_HIGH_FLOOR;
  const share = usableLowFloorShare(history?.get(leg.subRouteUid));
  if (share !== undefined) {
    return (
      CREDIT_HISTORY_MIN + (CREDIT_HISTORY_MAX - CREDIT_HISTORY_MIN) * share
    );
  }
  return CREDIT_UNKNOWN;
}

function busBoardingEvidence(
  route: AccessibleRoute,
  history?: RouteLowFloorHistory,
): boolean {
  const leg = firstTransitLeg(route);
  if (leg?.type !== "BUS") return false;
  return (
    leg.isLowFloor !== undefined ||
    usableLowFloorShare(history?.get(leg.subRouteUid)) !== undefined
  );
}

/**
 * Reorder `routes` in place. Leaves the array untouched unless every
 * precondition holds: at least two routes, no future-scheduled route pinned by
 * retainEarliestFutureRoute, scoring already applied, and at least one route
 * with real low-floor evidence (a live plate or usable route history).
 *
 * @param routes The final top-N routes, reordered in place.
 * @param mode Accessibility mode driving the cost profile.
 * @param transitPreference Soft mode preference applied to the cost.
 * @param history Route low-floor history by sub-route uid.
 */
export function rerankByLowFloor(
  routes: AccessibleRoute[],
  mode: AccessibilityMode,
  transitPreference?: TransitPreference,
  history?: RouteLowFloorHistory,
): void {
  if (routes.length < 2) return;
  if (routes.some((r) => r._isFutureScheduled === true)) return;
  if (routes.some((r) => typeof r.accessibilityScore !== "number")) return;
  if (!routes.some((route) => busBoardingEvidence(route, history))) return;

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
      ) +
      transitPreferencePenalty(route, transitPreference) -
      boardingCredit(route, history),
  }));

  scored.sort((a, b) => a.adjusted - b.adjusted || a.index - b.index);
  for (let i = 0; i < scored.length; i++) routes[i] = scored[i].route;
}
