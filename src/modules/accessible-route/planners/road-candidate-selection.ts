import type { AccessibleRoute } from "../../../types/route";
import { createRoadGeometryComparison } from "./road-route-diversity";

function comparableDistance(route: AccessibleRoute): number | undefined {
  let hasRoadLeg = false;
  let distance = 0;
  for (const leg of route.legs) {
    if (
      leg.type !== "DRIVE" &&
      leg.type !== "MOTORCYCLE" &&
      leg.type !== "WALK"
    )
      return undefined;
    if (leg.type !== "WALK") hasRoadLeg = true;
    if (!Number.isFinite(leg.distanceM) || leg.distanceM < 0) return undefined;
    if (!Array.isArray(leg.polyline) || leg.polyline.length < 2)
      return undefined;
    if (
      leg.polyline.some(
        (point) =>
          !Array.isArray(point) ||
          !Number.isFinite(point[0]) ||
          !Number.isFinite(point[1]) ||
          Math.abs(point[0]) > 180 ||
          Math.abs(point[1]) > 90,
      )
    )
      return undefined;
    if (
      leg.distanceM > 0 &&
      !leg.polyline.some(
        (point) =>
          point[0] !== leg.polyline[0][0] || point[1] !== leg.polyline[0][1],
      )
    )
      return undefined;
    distance += leg.distanceM;
  }
  return hasRoadLeg && Number.isFinite(distance) ? distance : undefined;
}

function comparableTime(route: AccessibleRoute): number | undefined {
  return Number.isFinite(route.totalMinutes) && route.totalMinutes >= 0
    ? route.totalMinutes
    : undefined;
}

/** Keep the first ranked route and select distinct alternatives within hazard tiers. */
export function selectRoadCandidates(
  routes: AccessibleRoute[],
): AccessibleRoute[] {
  if (!routes.length) return [];
  const comparison = createRoadGeometryComparison(routes[0]);
  if (!comparison) return [routes[0]];

  const tiers: string[] = [];
  const tierOf = (route: AccessibleRoute): string => {
    const blocking = route.hazardAdvisory?.blockingOnRoute ?? 0;
    const penalty =
      blocking > 0 ? (route.hazardAdvisory?.penaltyPoints ?? 0) : 0;
    return `${blocking}:${penalty}`;
  };
  const candidates = routes.slice(1, 24).flatMap((route, offset) => {
    const tier = tierOf(route);
    if (!tiers.includes(tier)) tiers.push(tier);
    const shape = comparison.shape(route);
    return shape && comparison.distinct(comparison.firstShape, shape)
      ? [{ route, index: offset + 1, tier, shape }]
      : [];
  });
  type Candidate = (typeof candidates)[number];
  const firstTier = tierOf(routes[0]);
  if (!tiers.includes(firstTier)) tiers.unshift(firstTier);

  const better = (a: Candidate[], b: Candidate[]): boolean => {
    for (const tier of tiers) {
      const count = (values: Candidate[]) =>
        values.filter((candidate) => candidate.tier === tier).length;
      const difference = count(a) - count(b);
      if (difference) return difference > 0;
    }
    for (const tier of tiers) {
      const bestMetric = (
        values: Candidate[],
        metric: (route: AccessibleRoute) => number | undefined,
      ) => {
        const inTier = values
          .filter((candidate) => candidate.tier === tier)
          .map(({ route }) => route);
        if (tier === firstTier) inTier.push(routes[0]);
        return Math.min(
          Infinity,
          ...inTier.map((route) => metric(route) ?? Infinity),
        );
      };
      for (const metric of [comparableTime, comparableDistance]) {
        const aBest = bestMetric(a, metric);
        const bBest = bestMetric(b, metric);
        if (aBest !== bBest) return aBest < bBest;
      }
    }
    for (let i = 0; i < a.length; i++) {
      if (a[i].index !== b[i]?.index)
        return a[i].index < (b[i]?.index ?? Infinity);
    }
    return false;
  };

  let best: Candidate[] = [];
  for (let i = 0; i < candidates.length; i++) {
    const one = [candidates[i]];
    if (better(one, best)) best = one;
    for (let j = i + 1; j < candidates.length; j++) {
      const pair = [candidates[i], candidates[j]];
      if (
        better(pair, best) &&
        comparison.distinct(pair[0].shape, pair[1].shape)
      )
        best = pair;
    }
  }
  return [routes[0], ...best.map(({ route }) => route)];
}
