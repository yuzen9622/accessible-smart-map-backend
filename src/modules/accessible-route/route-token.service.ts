import {
  attachRoadMatchingData,
  getRoadMatchingData,
} from "../../utils/road-matching-data";
import { copyWithDescriptors } from "../../utils/route-source-names";
import { randomBytes, randomUUID } from "crypto";
import { storeBusPlan } from "./bus-plan.repository";
import { redisGet } from "../../config/redis";
import type { AccessibleRoute } from "../../types/route";
import type {
  CanonicalPlanRouteRequest,
  NavigationRouteEnvelope,
  NavigationRoute,
  NavigationVenueLegs,
} from "./accessible-route.types";
import {
  navigationTokenKey,
  storeInitialNavigationEnvelope,
} from "./navigation-state.repository";

/**
 * Cache each trusted planner route and add a token only after Redis confirms
 * it. Indoor venue legs ride along in the token for voice navigation; the
 * returned routes stay as they were, without them.
 */
export async function attachRouteTokens(
  routes: AccessibleRoute[],
  canonicalRequest: CanonicalPlanRouteRequest,
  venueLegs?: NavigationVenueLegs,
): Promise<AccessibleRoute[]> {
  const legs =
    venueLegs?.departure || venueLegs?.arrival
      ? {
          ...(venueLegs.departure ? { departure: venueLegs.departure } : {}),
          ...(venueLegs.arrival ? { arrival: venueLegs.arrival } : {}),
        }
      : undefined;
  return Promise.all(
    routes.map(async (route) => {
      const routeToken = randomBytes(32).toString("base64url");
      const navigationId = randomUUID();
      const routeVersion = 1;
      const navigationRoute = copyWithDescriptors(route, {
        navigationId,
        routeVersion,
      });
      const roadMatching = getRoadMatchingData(route);
      if (roadMatching) attachRoadMatchingData(navigationRoute, roadMatching);
      const stored = await storeInitialNavigationEnvelope(routeToken, {
        schemaVersion: 1,
        route: navigationRoute,
        ...(getRoadMatchingData(navigationRoute)
          ? { roadMatching: getRoadMatchingData(navigationRoute) }
          : {}),
        ...(legs ? { venueLegs: legs } : {}),
        navigationId,
        routeVersion,
        canonicalRequest,
      });
      if (!stored) {
        console.warn("[accessible-route] route token cache unavailable");
        return route;
      }
      await storeBusPlan(routeToken, navigationRoute);
      const tokenizedRoute = copyWithDescriptors(navigationRoute, {
        routeToken,
      });
      if (roadMatching) attachRoadMatchingData(tokenizedRoute, roadMatching);
      return tokenizedRoute;
    }),
  );
}

/** Resolve a short-lived bearer capability to a server-produced route. */
export async function getRouteByToken(
  routeToken: string,
  options: { includeVenueLegs?: boolean } = {},
): Promise<NavigationRoute | null> {
  const raw = await redisGet(navigationTokenKey(routeToken));
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as AccessibleRoute | NavigationRouteEnvelope;
    if (!isNavigationEnvelope(parsed)) return parsed;
    return options.includeVenueLegs && parsed.venueLegs
      ? { ...parsed.route, venueLegs: parsed.venueLegs }
      : parsed.route;
  } catch {
    return null;
  }
}

export function isNavigationEnvelope(
  value: unknown,
): value is NavigationRouteEnvelope {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<NavigationRouteEnvelope>;
  return (
    candidate.schemaVersion === 1 &&
    typeof candidate.navigationId === "string" &&
    Number.isInteger(candidate.routeVersion) &&
    Boolean(candidate.route) &&
    Boolean(candidate.canonicalRequest)
  );
}

export async function getNavigationEnvelopeByToken(
  routeToken: string,
): Promise<NavigationRouteEnvelope | null> {
  const raw = await redisGet(navigationTokenKey(routeToken));
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    return isNavigationEnvelope(parsed) ? parsed : null;
  } catch {
    return null;
  }
}
