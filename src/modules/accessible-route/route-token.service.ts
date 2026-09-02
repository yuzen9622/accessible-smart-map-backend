import { randomBytes, randomUUID } from "crypto";
import { redisGet } from "../../config/redis";
import type { AccessibleRoute } from "../../types/route";
import type {
  CanonicalPlanRouteRequest,
  NavigationRouteEnvelope,
} from "./accessible-route.types";
import {
  navigationTokenKey,
  storeInitialNavigationEnvelope,
} from "./navigation-state.repository";

/** Cache each trusted planner route and add a token only after Redis confirms it. */
export async function attachRouteTokens(
  routes: AccessibleRoute[],
  canonicalRequest: CanonicalPlanRouteRequest,
): Promise<AccessibleRoute[]> {
  return Promise.all(
    routes.map(async (route) => {
      const routeToken = randomBytes(32).toString("base64url");
      const navigationId = randomUUID();
      const routeVersion = 1;
      const navigationRoute = { ...route, navigationId, routeVersion };
      const stored = await storeInitialNavigationEnvelope(routeToken, {
        schemaVersion: 1,
        route: navigationRoute,
        navigationId,
        routeVersion,
        canonicalRequest,
      });
      if (!stored) {
        console.warn("[accessible-route] route token cache unavailable");
        return route;
      }
      return { ...navigationRoute, routeToken };
    }),
  );
}

/** Resolve a short-lived bearer capability to a server-produced route. */
export async function getRouteByToken(
  routeToken: string,
): Promise<AccessibleRoute | null> {
  const raw = await redisGet(navigationTokenKey(routeToken));
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as AccessibleRoute | NavigationRouteEnvelope;
    return isNavigationEnvelope(parsed) ? parsed.route : parsed;
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
