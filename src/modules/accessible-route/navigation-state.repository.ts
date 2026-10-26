import { createHash } from "node:crypto";
import { redisClient, redisReady } from "../../config/redis";
import type {
  NavigationRouteEnvelope,
  RerouteData,
} from "./accessible-route.types";

const TOKEN_PREFIX = "voice-nav:route:";
const HEAD_PREFIX = "voice-nav:head:";
const LOCK_PREFIX = "voice-nav:reroute-lock:";
const COMPLETED_PREFIX = "voice-nav:reroute-completed:";
const SNAPSHOT_PREFIX = "voice-nav:snapshot:";
const DECISION_PREFIX = "voice-nav:candidate-decision:";
const RESUME_LOCK_PREFIX = "voice-nav:resume-lock:";
export const ROUTE_TOKEN_TTL_SEC = 30 * 60;
const REROUTE_LOCK_TTL_SEC = 120;
const RESUME_LOCK_TTL_SEC = 10;
const STOP_FENCE_RETRY_MS = 25;
const STOP_FENCE_MAX_ATTEMPTS =
  Math.ceil((RESUME_LOCK_TTL_SEC * 1000) / STOP_FENCE_RETRY_MS) + 4;

const INITIAL_SCRIPT = `
redis.call("SET", KEYS[1], ARGV[1], "EX", ARGV[2])
redis.call("SET", KEYS[2], "1", "EX", ARGV[2])
return 1
`;

const BEGIN_SCRIPT = `
local marker = redis.call("GET", KEYS[4])
if marker then
  local m = cjson.decode(marker)
  if m.state ~= "ADOPTED" then return {"reconciling", ""} end
end
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
if redis.call("EXISTS", KEYS[6]) == 1 then return {"conflict", ""} end
local head = redis.call("GET", KEYS[2])
if (not head) or tonumber(head) ~= tonumber(ARGV[2]) then
  return {"stale", head or ""}
end
redis.call("SET", KEYS[3], ARGV[3], "EX", ARGV[4])
redis.call("SET", KEYS[2], ARGV[5], "EX", ARGV[4])
redis.call("SET", KEYS[4], ARGV[6], "EX", ARGV[4])
if KEYS[5] and ARGV[7] then
  redis.call("SET", KEYS[5], ARGV[7], "EX", ARGV[4])
end
redis.call("DEL", KEYS[1])
return {"ok", ""}
`;

const RELEASE_SCRIPT = `
if redis.call("GET", KEYS[1]) == ARGV[1] then return redis.call("DEL", KEYS[1]) end
return 0
`;

const DELETE_SNAPSHOT_USER_SCRIPT = `
local resumeLock = redis.call("GET", KEYS[3])
local raw = redis.call("GET", KEYS[1])
if raw then
  local ok, snapshot = pcall(cjson.decode, raw)
  if not ok or snapshot.userId ~= ARGV[1] then return "user_mismatch" end
end
redis.call("SET", KEYS[2], ARGV[1], "EX", ARGV[2])
redis.call("DEL", KEYS[1])
if resumeLock and string.sub(resumeLock, 1, 10) == "committed:" then return "busy" end
return "stopped"
`;

const BEGIN_RESUME_SCRIPT = `
local stoppedBy = redis.call("GET", KEYS[2])
if stoppedBy then
  if stoppedBy == ARGV[1] then return "stopped" end
  return "user_mismatch"
end
local raw = redis.call("GET", KEYS[1])
if not raw then return "missing" end
local ok, snapshot = pcall(cjson.decode, raw)
if not ok or snapshot.userId ~= ARGV[1] then return "user_mismatch" end
if snapshot.routeToken ~= ARGV[2] or tonumber(snapshot.routeVersion) ~= tonumber(ARGV[3]) then return "stale" end
if redis.call("GET", KEYS[4]) ~= tostring(snapshot.routeVersion) then return "stale" end
local marker = redis.call("GET", KEYS[5])
if marker then
  local m = cjson.decode(marker)
  if m.state ~= "ADOPTED" then return "stale" end
end
if not redis.call("SET", KEYS[3], "pending:" .. ARGV[4], "NX", "EX", ARGV[5]) then return "busy" end
return "acquired"
`;

const COMMIT_RESUME_SCRIPT = `
local stoppedBy = redis.call("GET", KEYS[2])
if stoppedBy then
  if stoppedBy == ARGV[1] then return "stopped" end
  return "user_mismatch"
end
if redis.call("GET", KEYS[1]) ~= "pending:" .. ARGV[2] then return "stale" end
local raw = redis.call("GET", KEYS[3])
if not raw then return "stale" end
local ok, snapshot = pcall(cjson.decode, raw)
if not ok or snapshot.userId ~= ARGV[1] then return "user_mismatch" end
if snapshot.routeToken ~= ARGV[4] or tonumber(snapshot.routeVersion) ~= tonumber(ARGV[5]) then return "stale" end
if redis.call("GET", KEYS[4]) ~= tostring(snapshot.routeVersion) then return "stale" end
local marker = redis.call("GET", KEYS[5])
if marker then
  local m = cjson.decode(marker)
  if m.state ~= "ADOPTED" then return "stale" end
end
redis.call("SET", KEYS[1], "committed:" .. ARGV[2], "EX", ARGV[3])
return "committed"
`;

const RELEASE_RESUME_SCRIPT = `
local value = redis.call("GET", KEYS[1])
if value == "pending:" .. ARGV[1] or value == "committed:" .. ARGV[1] then
  return redis.call("DEL", KEYS[1])
end
return 0
`;

const STORE_SNAPSHOT_SCRIPT = `
local snapshot = cjson.decode(ARGV[1])
if redis.call("GET", KEYS[3]) == snapshot.userId then return 0 end
local head = redis.call("GET", KEYS[2])
if not head or tonumber(head) ~= snapshot.routeVersion then return 0 end
local marker = redis.call("GET", KEYS[4])
if marker then
  local m = cjson.decode(marker)
  if m.state ~= "ADOPTED" then return 0 end
end
local raw = redis.call("GET", KEYS[1])
if raw then
  local old = cjson.decode(raw)
  if old.routeVersion > snapshot.routeVersion or old.updatedAt > snapshot.updatedAt then return 0 end
end
redis.call("SET", KEYS[1], ARGV[1], "EX", ARGV[2])
return 1
`;

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function envelopeIntegrity(envelope: NavigationRouteEnvelope): string {
  const { integrity: _integrity, ...payload } = envelope;
  const wire: unknown = JSON.parse(JSON.stringify(payload));
  return createHash("sha256").update(canonicalJson(wire)).digest("hex");
}

export function sealNavigationEnvelope(
  envelope: NavigationRouteEnvelope,
): NavigationRouteEnvelope {
  return { ...envelope, integrity: envelopeIntegrity(envelope) };
}

export function verifyNavigationEnvelopeIntegrity(
  envelope: NavigationRouteEnvelope,
): boolean {
  try {
    return (
      typeof envelope.integrity === "string" &&
      /^[a-f0-9]{64}$/.test(envelope.integrity) &&
      envelope.integrity === envelopeIntegrity(envelope)
    );
  } catch {
    return false;
  }
}

export function navigationTokenKey(token: string): string {
  return `${TOKEN_PREFIX}${token}`;
}

const headKey = (navigationId: string) => `${HEAD_PREFIX}${navigationId}`;
const snapshotKey = (navigationId: string) =>
  `${SNAPSHOT_PREFIX}${navigationId}`;
const lockKey = (navigationId: string, version: number) =>
  `${LOCK_PREFIX}${navigationId}:${version}`;
const completedKey = (navigationId: string, requestId: string) =>
  `${COMPLETED_PREFIX}${navigationId}:${requestId}`;
const resumeLockKey = (navigationId: string) =>
  `${RESUME_LOCK_PREFIX}${navigationId}`;

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
      JSON.stringify(sealNavigationEnvelope(envelope)),
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
  | { status: "stale" | "conflict" | "reconciling" }
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
      4,
      completedKey(navigationId, clientRequestId),
      headKey(navigationId),
      lockKey(navigationId, previousVersion),
      `${DECISION_PREFIX}${navigationId}`,
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
    if (result[0] === "reconciling") {
      // A process that died before publishing cannot hold mutation forever.
      // Live transactions own a 120s lease; only expired decisions recover here.
      const raw = await (
        await strictClient()
      ).get(`${DECISION_PREFIX}${navigationId}`);
      if (
        raw &&
        Date.now() - (JSON.parse(raw) as CandidateDecision).createdAt >
          REROUTE_LOCK_TTL_SEC * 1000
      ) {
        await recoverCandidateDecision(navigationId);
      }
      return { status: "reconciling" };
    }
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
  decision?: CandidateDecision,
): Promise<"ok" | "stale" | "conflict" | "unavailable"> {
  try {
    const result = (await (
      await strictClient()
    ).eval(
      FINALIZE_SCRIPT,
      6,
      lockKey(envelope.navigationId, previousVersion),
      headKey(envelope.navigationId),
      navigationTokenKey(token),
      completedKey(envelope.navigationId, clientRequestId),
      `${DECISION_PREFIX}${envelope.navigationId}`,
      resumeLockKey(envelope.navigationId),
      clientRequestId,
      String(previousVersion),
      JSON.stringify(sealNavigationEnvelope(envelope)),
      String(ROUTE_TOKEN_TTL_SEC),
      String(envelope.routeVersion),
      JSON.stringify(data),
      ...(decision ? [JSON.stringify(decision)] : []),
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

/**
 * Turn-by-turn progress durable enough to survive a client going to the
 * background or losing its socket, so a reconnect can resume mid-route instead
 * of replanning from the current position.
 */
export interface NavigationSessionSnapshot {
  navigationId: string;
  userId: string;
  routeToken: string;
  routeVersion: number;
  currentStepIndex: number;
  onVehicle: boolean;
  latestPosition: {
    latitude: number;
    longitude: number;
    heading?: number;
  } | null;
  updatedAt: number;
}

function isSnapshot(value: unknown): value is NavigationSessionSnapshot {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<NavigationSessionSnapshot>;
  const position = candidate.latestPosition;
  const positionOk =
    position === null ||
    (typeof position === "object" &&
      position !== null &&
      Number.isFinite(position.latitude) &&
      Number.isFinite(position.longitude));
  return (
    typeof candidate.navigationId === "string" &&
    typeof candidate.userId === "string" &&
    typeof candidate.routeToken === "string" &&
    Number.isInteger(candidate.routeVersion) &&
    Number.isInteger(candidate.currentStepIndex) &&
    typeof candidate.onVehicle === "boolean" &&
    positionOk &&
    Number.isFinite(candidate.updatedAt)
  );
}

/**
 * Writes the snapshot with a fresh TTL, so an active navigation keeps sliding
 * its expiry forward while an abandoned one ages out on its own.
 */
export async function storeNavigationSnapshot(
  snapshot: NavigationSessionSnapshot,
  ttlSec = ROUTE_TOKEN_TTL_SEC,
): Promise<void> {
  try {
    await (
      await strictClient()
    ).eval(
      STORE_SNAPSHOT_SCRIPT,
      4,
      snapshotKey(snapshot.navigationId),
      headKey(snapshot.navigationId),
      `voice-nav:stopped:${snapshot.navigationId}`,
      `${DECISION_PREFIX}${snapshot.navigationId}`,
      JSON.stringify(snapshot),
      String(ttlSec),
    );
  } catch {
    // Fail soft: a missing snapshot only costs the client its resume path.
  }
}

export async function getNavigationSnapshot(
  navigationId: string,
): Promise<NavigationSessionSnapshot | null> {
  try {
    const raw = await (await strictClient()).get(snapshotKey(navigationId));
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    return isSnapshot(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export type NavigationStopStatus =
  "active" | "stopped" | "user_mismatch" | "unavailable";

/** Persists a stop tombstone after any in-flight resume fence is released. */
export async function markNavigationStopped(
  navigationId: string,
  userId: string,
): Promise<NavigationStopStatus> {
  try {
    const client = await strictClient();
    for (let attempt = 0; attempt < STOP_FENCE_MAX_ATTEMPTS; attempt++) {
      const status = (await client.eval(
        DELETE_SNAPSHOT_USER_SCRIPT,
        3,
        snapshotKey(navigationId),
        `voice-nav:stopped:${navigationId}`,
        resumeLockKey(navigationId),
        userId,
        String(ROUTE_TOKEN_TTL_SEC),
      )) as NavigationStopStatus | "busy";
      if (status !== "busy") return status;
      await new Promise((resolve) => setTimeout(resolve, STOP_FENCE_RETRY_MS));
    }
    // Every busy reply already wrote the tombstone and removed the snapshot;
    // only publication ordering is still waiting on the committed lease.
    return "stopped";
  } catch {
    return "unavailable";
  }
}

export type BeginNavigationResumeResult =
  | "acquired"
  | "stopped"
  | "missing"
  | "stale"
  | "busy"
  | "user_mismatch"
  | "unavailable";

/** Acquires the Redis fence that serializes resume publication against stop. */
export async function beginNavigationResume(
  snapshot: NavigationSessionSnapshot,
  attemptId: string,
): Promise<BeginNavigationResumeResult> {
  try {
    return (await (
      await strictClient()
    ).eval(
      BEGIN_RESUME_SCRIPT,
      5,
      snapshotKey(snapshot.navigationId),
      `voice-nav:stopped:${snapshot.navigationId}`,
      resumeLockKey(snapshot.navigationId),
      headKey(snapshot.navigationId),
      `${DECISION_PREFIX}${snapshot.navigationId}`,
      snapshot.userId,
      snapshot.routeToken,
      String(snapshot.routeVersion),
      attemptId,
      String(RESUME_LOCK_TTL_SEC),
    )) as BeginNavigationResumeResult;
  } catch {
    return "unavailable";
  }
}

export type CommitNavigationResumeResult =
  "committed" | "stopped" | "stale" | "user_mismatch" | "unavailable";

/** Linearizes resume before its synchronous local publication. */
export async function commitNavigationResume(
  snapshot: NavigationSessionSnapshot,
  attemptId: string,
): Promise<CommitNavigationResumeResult> {
  try {
    return (await (
      await strictClient()
    ).eval(
      COMMIT_RESUME_SCRIPT,
      5,
      resumeLockKey(snapshot.navigationId),
      `voice-nav:stopped:${snapshot.navigationId}`,
      snapshotKey(snapshot.navigationId),
      headKey(snapshot.navigationId),
      `${DECISION_PREFIX}${snapshot.navigationId}`,
      snapshot.userId,
      attemptId,
      String(RESUME_LOCK_TTL_SEC),
      snapshot.routeToken,
      String(snapshot.routeVersion),
    )) as CommitNavigationResumeResult;
  } catch {
    return "unavailable";
  }
}

export async function releaseNavigationResume(
  navigationId: string,
  attemptId: string,
): Promise<void> {
  try {
    await (
      await strictClient()
    ).eval(RELEASE_RESUME_SCRIPT, 1, resumeLockKey(navigationId), attemptId);
  } catch {
    // The short TTL releases a lease whose owner disappeared.
  }
}

/** Checks the durable tombstone for diagnostics and recovery paths. */
export async function getNavigationStopStatus(
  navigationId: string,
  userId: string,
): Promise<NavigationStopStatus> {
  try {
    const stoppedBy = await (
      await strictClient()
    ).get(`voice-nav:stopped:${navigationId}`);
    if (stoppedBy === null) return "active";
    return stoppedBy === userId ? "stopped" : "user_mismatch";
  } catch {
    return "unavailable";
  }
}

export async function deleteNavigationSnapshot(
  navigationId: string,
  userId: string,
): Promise<void> {
  await markNavigationStopped(navigationId, userId);
}

export interface CandidateDecision {
  createdAt: number;
  state: "PENDING_DECISION" | "ADOPTED" | "ROLLBACK_REQUIRED";
  navigationId: string;
  previousVersion: number;
  nextVersion: number;
  oldToken: string;
  newToken: string;
  proposalId: string;
}

// One transaction verifies the exact commit and persists the publication decision.
// ADOPTED is terminal: neither an ambiguous reply nor a restart may undo it.
const DECISION_SCRIPT = `
local raw = redis.call("GET", KEYS[1])
if not raw then return "missing" end
local m = cjson.decode(raw)
local wanted = cjson.decode(ARGV[1])
if m.proposalId ~= wanted.proposalId or m.oldToken ~= wanted.oldToken or m.newToken ~= wanted.newToken or m.previousVersion ~= wanted.previousVersion or m.nextVersion ~= wanted.nextVersion then return "mismatch" end
if m.state == "ADOPTED" then return "ADOPTED" end
if redis.call("GET", KEYS[2]) ~= tostring(m.nextVersion) or redis.call("GET", KEYS[3]) ~= ARGV[2] or redis.call("GET", KEYS[4]) ~= ARGV[3] then return "mismatch" end
if ARGV[4] == "probe" then return m.state end
if ARGV[4] == "adopt" and m.state == "PENDING_DECISION" then
  local snapshot = cjson.decode(ARGV[5])
  if redis.call("GET", KEYS[6]) == snapshot.userId then return "ROLLBACK_REQUIRED" end
  redis.call("SET", KEYS[5], ARGV[5], "EX", ARGV[6])
  m.state = "ADOPTED"
  redis.call("SET", KEYS[1], cjson.encode(m), "EX", ARGV[6])
  return "ADOPTED"
end
if ARGV[4] == "rollback" then
  m.state = "ROLLBACK_REQUIRED"
  redis.call("SET", KEYS[1], cjson.encode(m), "EX", ARGV[6])
  redis.call("SET", KEYS[2], tostring(m.previousVersion), "EX", ARGV[6])
  redis.call("DEL", KEYS[3], KEYS[4], KEYS[1])
  return "ROLLED_BACK"
end
return m.state
`;

export type AdoptionStatus =
  | "PENDING_DECISION"
  | "ADOPTED"
  | "ROLLBACK_REQUIRED"
  | "ROLLED_BACK"
  | "missing"
  | "mismatch"
  | "unavailable";
export async function resolveCandidateDecision(
  decision: CandidateDecision,
  envelope: NavigationRouteEnvelope,
  data: RerouteData,
  action: "probe" | "adopt" | "rollback",
  snapshot?: NavigationSessionSnapshot,
): Promise<AdoptionStatus> {
  try {
    return (await (
      await strictClient()
    ).eval(
      DECISION_SCRIPT,
      6,
      `${DECISION_PREFIX}${decision.navigationId}`,
      headKey(decision.navigationId),
      navigationTokenKey(decision.newToken),
      completedKey(decision.navigationId, decision.proposalId),
      snapshotKey(decision.navigationId),
      `voice-nav:stopped:${decision.navigationId}`,
      JSON.stringify(decision),
      JSON.stringify(sealNavigationEnvelope(envelope)),
      JSON.stringify(data),
      action,
      JSON.stringify(snapshot ?? null),
      String(ROUTE_TOKEN_TTL_SEC),
    )) as AdoptionStatus;
  } catch {
    return "unavailable";
  }
}

/** Recovery is driven by stored data, never a guessed token/version. */
export async function recoverCandidateDecision(
  navigationId: string,
): Promise<AdoptionStatus> {
  try {
    const client = await strictClient();
    const raw = await client.get(`${DECISION_PREFIX}${navigationId}`);
    if (!raw) return "missing";
    const decision = JSON.parse(raw) as CandidateDecision;
    if (decision.state === "ADOPTED") return "ADOPTED";
    const [token, completed] = await Promise.all([
      client.get(navigationTokenKey(decision.newToken)),
      client.get(completedKey(navigationId, decision.proposalId)),
    ]);
    if (!token || !completed) return "mismatch";
    return resolveCandidateDecision(
      decision,
      JSON.parse(token),
      JSON.parse(completed),
      "rollback",
    );
  } catch {
    return "unavailable";
  }
}

// Resume may repair exactly one unpublished, durably adopted candidate switch.
// Read marker/head/snapshot/token/completed atomically; no guessed version jumps.
const ADOPTED_RESUME_SCRIPT = `
local raw = redis.call("GET", KEYS[1])
if not raw then return nil end
local m = cjson.decode(raw)
local expected = cjson.decode(ARGV[1])
if m.state ~= "ADOPTED" or m.navigationId ~= expected.navigationId or m.oldToken ~= ARGV[2] or m.previousVersion ~= tonumber(ARGV[3]) or m.nextVersion ~= m.previousVersion + 1 or m.nextVersion ~= expected.routeVersion or m.newToken ~= expected.routeToken then return nil end
if redis.call("GET", KEYS[2]) ~= tostring(m.nextVersion) or redis.call("GET", KEYS[4]) == expected.userId then return nil end
local stored = redis.call("GET", KEYS[3])
if not stored then return nil end
local snapshot = cjson.decode(stored)
if snapshot.navigationId ~= expected.navigationId or snapshot.userId ~= expected.userId or snapshot.routeToken ~= m.newToken or snapshot.routeVersion ~= m.nextVersion then return nil end
local token = redis.call("GET", ARGV[4] .. m.newToken)
local completed = redis.call("GET", ARGV[5] .. m.navigationId .. ":" .. m.proposalId)
if not token or not completed then return nil end
local envelope = cjson.decode(token)
local data = cjson.decode(completed)
if envelope.schemaVersion ~= 1 or envelope.navigationId ~= m.navigationId or envelope.routeVersion ~= m.nextVersion or envelope.route.navigationId ~= m.navigationId or envelope.route.routeVersion ~= m.nextVersion or data.navigationId ~= m.navigationId or data.previousRouteVersion ~= m.previousVersion or data.routeVersion ~= m.nextVersion or data.routeToken ~= m.newToken then return nil end
return completed
`;

export async function getAdoptedCandidateReplacement(
  snapshot: NavigationSessionSnapshot,
  previousToken: string,
  previousVersion: number,
): Promise<RerouteData | null> {
  try {
    const raw = await (
      await strictClient()
    ).eval(
      ADOPTED_RESUME_SCRIPT,
      4,
      `${DECISION_PREFIX}${snapshot.navigationId}`,
      headKey(snapshot.navigationId),
      snapshotKey(snapshot.navigationId),
      `voice-nav:stopped:${snapshot.navigationId}`,
      JSON.stringify(snapshot),
      previousToken,
      String(previousVersion),
      TOKEN_PREFIX,
      COMPLETED_PREFIX,
    );
    return typeof raw === "string" ? (JSON.parse(raw) as RerouteData) : null;
  } catch {
    return null;
  }
}
