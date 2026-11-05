import {
  ACCESSIBLE_RANKING,
  type AccessibleRankingWeights,
} from "../../config/routing";
import type { AccessibilityMode, AccessibleRoute } from "../../types/route";
import {
  candidateEpoch,
  compareRouteEligibility,
  compareRoutesByArrival,
} from "./bus-stop-pair-candidates";
import { walkSpeedMps } from "./scoring";

const MINUTE_MS = 60_000;

/**
 * The effort-weighted ranking for a mode, or undefined when the mode ranks
 * by earliest arrival.
 *
 * @param mode Accessibility mode.
 * @returns The mode's ranking weights, if it has any.
 */
export function accessibleRankingWeights(
  mode: AccessibilityMode,
): AccessibleRankingWeights | undefined {
  return ACCESSIBLE_RANKING[mode];
}

function stepFreeBoardings(route: AccessibleRoute): number {
  return route.legs.filter(
    (leg) =>
      (leg.type === "BUS" && leg.isLowFloor === true) ||
      leg.type === "METRO" ||
      leg.type === "THSR",
  ).length;
}

/**
 * Ranking cost in minutes, relative to `arrivalOriginMs`: arrival, plus the
 * walking minutes' extra weight, plus a penalty per transfer, minus the credit
 * for each step-free boarding (confirmed low-floor bus, metro, high-speed rail).
 *
 * @param route The route to cost.
 * @param mode Accessibility mode supplying the walking speed.
 * @param weights The mode's ranking weights.
 * @param arrivalOriginMs Any fixed instant; only differences matter.
 * @returns The cost; lower ranks first.
 */
export function accessibleRankingCost(
  route: AccessibleRoute,
  mode: AccessibilityMode,
  weights: AccessibleRankingWeights,
  arrivalOriginMs: number,
): number {
  const arrivalMinutes =
    (candidateEpoch(route.arrivalTime ?? null) - arrivalOriginMs) / MINUTE_MS;
  const walkMinutes = (route.totalWalkDistanceM ?? 0) / walkSpeedMps(mode) / 60;
  const transferMinutes =
    Math.max(0, route.transferCount) *
    Math.max(
      weights.transferMinMinutes,
      weights.transferShareOfTrip * route.totalMinutes,
    );
  return (
    arrivalMinutes +
    (weights.walkTimeMultiplier - 1) * walkMinutes +
    transferMinutes -
    stepFreeBoardings(route) * weights.stepFreeBoardingCreditMinutes
  );
}

/**
 * Orders final transit candidates for a mode. Modes without ranking weights
 * keep the earliest-arrival order. Weighted modes keep the safety and advisory
 * tiers first, then put routes arriving within `maxExtraMinutes` of the
 * earliest arrival in their tier ahead of later ones, and order each of those
 * groups by ranking cost. Walking-only routes compete on the same cost.
 *
 * @param routes Scored candidates; not mutated.
 * @param mode Accessibility mode.
 * @returns A new array, best first.
 */
export function rankRoutesForMode(
  routes: AccessibleRoute[],
  mode: AccessibilityMode,
): AccessibleRoute[] {
  const weights = accessibleRankingWeights(mode);
  if (!weights) return [...routes].sort(compareRoutesByArrival);

  const byTier = [...routes].sort(compareRouteEligibility);
  const tiers: AccessibleRoute[][] = [];
  for (const route of byTier) {
    const tier = tiers.at(-1);
    if (tier && compareRouteEligibility(tier[0], route) === 0) tier.push(route);
    else tiers.push([route]);
  }

  return tiers.flatMap((tier) => {
    const earliest = Math.min(
      ...tier.map((route) => candidateEpoch(route.arrivalTime ?? null)),
    );
    const origin = Number.isFinite(earliest) ? earliest : 0;
    return tier
      .map((route) => {
        const arrival = candidateEpoch(route.arrivalTime ?? null);
        return {
          route,
          arrival,
          late: arrival - origin > weights.maxExtraMinutes * MINUTE_MS,
          cost: accessibleRankingCost(route, mode, weights, origin),
        };
      })
      .sort(
        (a, b) =>
          Number(a.late) - Number(b.late) ||
          a.cost - b.cost ||
          a.arrival - b.arrival ||
          a.route.routeId.localeCompare(b.route.routeId),
      )
      .map((entry) => entry.route);
  });
}
