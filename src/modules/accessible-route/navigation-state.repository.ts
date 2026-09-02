import { redisClient, redisReady } from "../../config/redis";
import type {
  NavigationRouteEnvelope,
  RerouteData,
} from "./accessible-route.types";

const TOKEN_PREFIX = "voice-nav:route:";
const HEAD_PREFIX = "voice-nav:head:";
const LOCK_PREFIX = "voice-nav:reroute-lock:";
const COMPLETED_PREFIX = "voice-nav:reroute-completed:";
export const ROUTE_TOKEN_TTL_SEC = 30 * 60;
const REROUTE_LOCK_TTL_SEC = 120;

const INITIAL_SCRIPT = `
redis.call("SET", KEYS[1], ARGV[1], "EX", ARGV[2])
redis.call("SET", KEYS[2], "1", "EX", ARGV[2])
return 1
`;

const BEGIN_SCRIPT = `
local completed = redis.call("GET", KEYS[1])
if completed then return {"replay", completed} end
local head = redis.call("GET", KEYS[2])
if (not head) or tonumber(head) ~= tonumber(ARGV[1]) then
  return {"stale", head or ""}
end
if redis.call("EXISTS", KEYS[3]) == 1 then
  return {"conflict", redis.call("GET", KEYS[3]) or ""}
end
redis.call("SET", KEYS[3], ARGV[2], "EX", ARGV[3])
return {"acquired", ""}
`;

const FINALIZE_SCRIPT = `
if redis.call("GET", KEYS[1]) ~= ARGV[1] then return {"conflict", ""} end
local head = redis.call("GET", KEYS[2])
if (not head) or tonumber(head) ~= tonumber(ARGV[2]) then
  return {"stale", head or ""}
end
redis.call("SET", KEYS[3], ARGV[3], "EX", ARGV[4])
redis.call("SET", KEYS[2], ARGV[5], "EX", ARGV[4])
redis.call("SET", KEYS[4], ARGV[6], "EX", ARGV[4])
redis.call("DEL", KEYS[1])
return {"ok", ""}
`;

const RELEASE_SCRIPT = `
if redis.call("GET", KEYS[1]) == ARGV[1] then return redis.call("DEL", KEYS[1]) end
return 0
`;

export function navigationTokenKey(token: string): string {
  return `${TOKEN_PREFIX}${token}`;
}

const headKey = (navigationId: string) => `${HEAD_PREFIX}${navigationId}`;
const lockKey = (navigationId: string, version: number) =>
  `${LOCK_PREFIX}${navigationId}:${version}`;
const completedKey = (navigationId: string, requestId: string) =>
  `${COMPLETED_PREFIX}${navigationId}:${requestId}`;

async function strictClient() {
  await redisReady();
  if (!redisClient || redisClient.status !== "ready") {
    throw new Error("Redis unavailable");
  }
  return redisClient;
}

export async function storeInitialNavigationEnvelope(
  token: string,
  envelope: NavigationRouteEnvelope,
): Promise<boolean> {
  try {
    const client = await strictClient();
    await client.eval(
      INITIAL_SCRIPT,
      2,
      navigationTokenKey(token),
      headKey(envelope.navigationId),
      JSON.stringify(envelope),
      String(ROUTE_TOKEN_TTL_SEC),
    );
    return true;
  } catch {
    return false;
  }
}

export type StrictTokenRead =
  | { status: "ok"; value: unknown }
  | { status: "missing" }
  | { status: "unavailable" };

export async function readNavigationTokenStrict(
  token: string,
): Promise<StrictTokenRead> {
  try {
    const raw = await (await strictClient()).get(navigationTokenKey(token));
    if (!raw) return { status: "missing" };
    try {
      return { status: "ok", value: JSON.parse(raw) };
    } catch {
      return { status: "missing" };
    }
  } catch {
    return { status: "unavailable" };
  }
}

export type BeginRerouteResult =
  | { status: "acquired" }
  | { status: "replay"; data: RerouteData }
  | { status: "stale" | "conflict" }
  | { status: "unavailable" };

export async function beginReroute(
  navigationId: string,
  previousVersion: number,
  clientRequestId: string,
): Promise<BeginRerouteResult> {
  try {
    const result = (await (
      await strictClient()
    ).eval(
      BEGIN_SCRIPT,
      3,
      completedKey(navigationId, clientRequestId),
      headKey(navigationId),
      lockKey(navigationId, previousVersion),
      String(previousVersion),
      clientRequestId,
      String(REROUTE_LOCK_TTL_SEC),
    )) as [string, string];
    if (result[0] === "replay") {
      return {
        status: "replay",
        data: { ...(JSON.parse(result[1]) as RerouteData), replayed: true },
      };
    }
    if (result[0] === "acquired") return { status: "acquired" };
    return { status: result[0] === "stale" ? "stale" : "conflict" };
  } catch {
    return { status: "unavailable" };
  }
}

export async function finalizeReroute(
  previousVersion: number,
  clientRequestId: string,
  token: string,
  envelope: NavigationRouteEnvelope,
  data: RerouteData,
): Promise<"ok" | "stale" | "conflict" | "unavailable"> {
  try {
    const result = (await (
      await strictClient()
    ).eval(
      FINALIZE_SCRIPT,
      4,
      lockKey(envelope.navigationId, previousVersion),
      headKey(envelope.navigationId),
      navigationTokenKey(token),
      completedKey(envelope.navigationId, clientRequestId),
      clientRequestId,
      String(previousVersion),
      JSON.stringify(envelope),
      String(ROUTE_TOKEN_TTL_SEC),
      String(envelope.routeVersion),
      JSON.stringify(data),
    )) as [string, string];
    return result[0] === "ok"
      ? "ok"
      : result[0] === "stale"
        ? "stale"
        : "conflict";
  } catch {
    return "unavailable";
  }
}

export async function releaseReroute(
  navigationId: string,
  previousVersion: number,
  clientRequestId: string,
): Promise<void> {
  try {
    await (
      await strictClient()
    ).eval(
      RELEASE_SCRIPT,
      1,
      lockKey(navigationId, previousVersion),
      clientRequestId,
    );
  } catch {
    // Fail closed for future requests: the bounded lock expires after 120s.
  }
}
