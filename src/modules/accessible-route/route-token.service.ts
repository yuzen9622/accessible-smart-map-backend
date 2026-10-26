import { copyWithDescriptors } from "../../utils/route-source-names";
import { hasCurrentWalkingPolicy } from "./walking-policy.service";
import { randomBytes, randomUUID } from "crypto";
import { storeBusPlan } from "./bus-plan.repository";
import { redisGet } from "../../config/redis";
import type { AccessibleRoute } from "../../types/route";
import type {
  CanonicalPlanRouteRequest,
  NavigationRouteEnvelope,
} from "./accessible-route.types";
import {
  navigationTokenKey,
  sealNavigationEnvelope,
  verifyNavigationEnvelopeIntegrity,
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
      const navigationRoute = copyWithDescriptors(route, {
        navigationId,
        routeVersion,
      });
      const stored = await storeInitialNavigationEnvelope(
        routeToken,
        sealNavigationEnvelope({
          schemaVersion: 1,
          route: navigationRoute,
          navigationId,
          routeVersion,
          canonicalRequest,
        }),
      );
      if (!stored) {
        console.warn("[accessible-route] route token cache unavailable");
        return route;
      }
      await storeBusPlan(routeToken, navigationRoute);
      return copyWithDescriptors(navigationRoute, { routeToken });
    }),
  );
}

/** Resolve a short-lived bearer capability to a server-produced route. */
export async function getRouteByToken(
  routeToken: string,
): Promise<AccessibleRoute | null> {
  return (await getNavigationEnvelopeByToken(routeToken))?.route ?? null;
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
    Number(candidate.routeVersion) >= 1 &&
    !!candidate.route &&
    typeof candidate.route === "object" &&
    Array.isArray(candidate.route.legs) &&
    candidate.route.legs.every(
      (leg) => !!leg && typeof leg === "object" && typeof leg.type === "string",
    ) &&
    candidate.route.navigationId === candidate.navigationId &&
    candidate.route.routeVersion === candidate.routeVersion &&
    !!candidate.canonicalRequest &&
    typeof candidate.canonicalRequest === "object" &&
    verifyNavigationEnvelopeIntegrity(candidate as NavigationRouteEnvelope)
  );
}

export async function resolveNavigationEnvelope(
  value: unknown,
): Promise<NavigationRouteEnvelope | null> {
  if (
    !isNavigationEnvelope(value) ||
    !(await hasCurrentWalkingPolicy(value.route))
  )
    return null;
  const policy = value.route.walkingPolicy;
  if (
    policy &&
    (policy.mode !== value.canonicalRequest.mode ||
      policy.avoidStairs !== value.canonicalRequest.avoidStairs)
  )
    return null;
  return value;
}

export async function getNavigationEnvelopeByToken(
  routeToken: string,
): Promise<NavigationRouteEnvelope | null> {
  const raw = await redisGet(navigationTokenKey(routeToken));
  if (!raw) return null;
  try {
    return await resolveNavigationEnvelope(JSON.parse(raw));
  } catch {
    return null;
  }
}
