import { randomBytes } from "crypto";
import { redisGet, redisSetChecked } from "../../config/redis";
import type { AccessibleRoute } from "../../types/route";

const ROUTE_TOKEN_PREFIX = "voice-nav:route:";
const ROUTE_TOKEN_TTL_SEC = 30 * 60;

function routeTokenKey(token: string): string {
  return `${ROUTE_TOKEN_PREFIX}${token}`;
}

/** Cache each trusted planner route and add a token only after Redis confirms it. */
export async function attachRouteTokens(
  routes: AccessibleRoute[],
): Promise<AccessibleRoute[]> {
  return Promise.all(
    routes.map(async (route) => {
      const routeToken = randomBytes(32).toString("base64url");
      const stored = await redisSetChecked(
        routeTokenKey(routeToken),
        JSON.stringify(route),
        ROUTE_TOKEN_TTL_SEC,
      );
      if (!stored) {
        console.warn("[accessible-route] route token cache unavailable");
        return route;
      }
      return { ...route, routeToken };
    }),
  );
}

/** Resolve a short-lived bearer capability to a server-produced route. */
export async function getRouteByToken(
  routeToken: string,
): Promise<AccessibleRoute | null> {
  const raw = await redisGet(routeTokenKey(routeToken));
  if (!raw) return null;
  try {
    return JSON.parse(raw) as AccessibleRoute;
  } catch {
    return null;
  }
}
