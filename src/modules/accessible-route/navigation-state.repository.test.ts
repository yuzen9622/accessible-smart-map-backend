import { beforeEach, describe, expect, it, vi } from "vitest";

const { evalRedis, getRedis, setRedis, delRedis, redisReady } = vi.hoisted(
  () => ({
    evalRedis: vi.fn(),
    getRedis: vi.fn(),
    setRedis: vi.fn(),
    delRedis: vi.fn(),
    redisReady: vi.fn().mockResolvedValue(undefined),
  }),
);

vi.mock("../../config/redis", () => ({
  redisReady,
  redisClient: {
    status: "ready",
    eval: evalRedis,
    get: getRedis,
    set: setRedis,
    del: delRedis,
  },
}));

import {
  beginReroute,
  deleteNavigationSnapshot,
  finalizeReroute,
  getNavigationSnapshot,
  readNavigationTokenStrict,
  storeInitialNavigationEnvelope,
  storeNavigationSnapshot,
  type NavigationSessionSnapshot,
} from "./navigation-state.repository";

const snapshot: NavigationSessionSnapshot = {
  navigationId: "nav",
  userId: "user-1",
  routeToken: "token",
  routeVersion: 2,
  currentStepIndex: 3,
  onVehicle: true,
  latestPosition: { latitude: 25, longitude: 121, heading: 90 },
  updatedAt: 1_700_000_000_000,
};

const envelope = {
  schemaVersion: 1 as const,
  route: {
    routeId: "route",
    routeName: "walk",
    totalMinutes: 1,
    transferCount: 0,
    legs: [],
    accessibilityHighlights: [],
  },
  navigationId: "nav",
  routeVersion: 1,
  canonicalRequest: {
    origin: { latitude: 25, longitude: 121 },
    destination: { latitude: 25.1, longitude: 121.1 },
    userLocation: { latitude: 25, longitude: 121 },
    travelMode: "walk" as const,
    mode: "normal" as const,
    maxTransfers: 2,
    format: "standard" as const,
    waypoints: [],
    avoidStairs: false,
    requireElevator: false,
    needsAccessibleToilet: false,
    needsHandrail: false,
  },
};

describe("navigation-state repository Lua tri-state", () => {
  beforeEach(() => vi.clearAllMocks());

  it("atomically stores the initial envelope and v1 head", async () => {
    evalRedis.mockResolvedValue(1);
    await expect(
      storeInitialNavigationEnvelope("token", envelope),
    ).resolves.toBe(true);
    expect(evalRedis).toHaveBeenCalledWith(
      expect.stringContaining('redis.call("SET", KEYS[1]'),
      2,
      "voice-nav:route:token",
      "voice-nav:head:nav",
      JSON.stringify(envelope),
      "1800",
    );
  });

  it.each([
    [["acquired", ""], { status: "acquired" }],
    [["stale", "2"], { status: "stale" }],
    [["conflict", "other"], { status: "conflict" }],
  ])("maps begin Lua result %j without fail-open", async (raw, expected) => {
    evalRedis.mockResolvedValue(raw);
    await expect(beginReroute("nav", 1, "request")).resolves.toEqual(expected);
  });

  it("replays the completed result with replayed=true", async () => {
    evalRedis.mockResolvedValue([
      "replay",
      JSON.stringify({ routeToken: "same", routeVersion: 2, replayed: false }),
    ]);
    await expect(beginReroute("nav", 1, "request")).resolves.toMatchObject({
      status: "replay",
      data: { routeToken: "same", routeVersion: 2, replayed: true },
    });
  });

  it("fails closed when strict reads cannot reach Redis", async () => {
    redisReady.mockRejectedValueOnce(new Error("down"));
    await expect(readNavigationTokenStrict("token")).resolves.toEqual({
      status: "unavailable",
    });
  });

  it("finalizes token, head and idempotency result in one Lua call", async () => {
    evalRedis.mockResolvedValue(["ok", ""]);
    const nextEnvelope = { ...envelope, routeVersion: 2 };
    const data = {
      navigationId: "nav",
      previousRouteVersion: 1,
      routeVersion: 2,
      routeToken: "next",
      route: envelope.route,
      instructions: [],
      steps: [],
      warnings: [],
      currentStepIndex: 0 as const,
      replayed: false,
    };
    await expect(
      finalizeReroute(1, "request", "next", nextEnvelope, data),
    ).resolves.toBe("ok");
    expect(evalRedis).toHaveBeenCalledWith(
      expect.stringContaining('redis.call("SET", KEYS[3]'),
      4,
      "voice-nav:reroute-lock:nav:1",
      "voice-nav:head:nav",
      "voice-nav:route:next",
      "voice-nav:reroute-completed:nav:request",
      "request",
      "1",
      JSON.stringify(nextEnvelope),
      "1800",
      "2",
      JSON.stringify(data),
    );
  });
});

describe("navigation session snapshot", () => {
  beforeEach(() => vi.clearAllMocks());

  it("writes the snapshot under its own key with the sliding 30 minute TTL", async () => {
    setRedis.mockResolvedValue("OK");
    await storeNavigationSnapshot(snapshot);
    expect(setRedis).toHaveBeenCalledWith(
      "voice-nav:snapshot:nav",
      JSON.stringify(snapshot),
      "EX",
      1800,
    );
  });

  it("honours an explicit ttl override", async () => {
    setRedis.mockResolvedValue("OK");
    await storeNavigationSnapshot(snapshot, 60);
    expect(setRedis).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(String),
      "EX",
      60,
    );
  });

  it("round-trips a stored snapshot", async () => {
    getRedis.mockResolvedValue(JSON.stringify(snapshot));
    await expect(getNavigationSnapshot("nav")).resolves.toEqual(snapshot);
    expect(getRedis).toHaveBeenCalledWith("voice-nav:snapshot:nav");
  });

  it("returns null for a missing key", async () => {
    getRedis.mockResolvedValue(null);
    await expect(getNavigationSnapshot("nav")).resolves.toBeNull();
  });

  it.each([
    ["unparseable json", "{not json"],
    ["a non-object payload", '"nav"'],
    [
      "a snapshot missing userId",
      JSON.stringify({ ...snapshot, userId: undefined }),
    ],
    [
      "a fractional routeVersion",
      JSON.stringify({ ...snapshot, routeVersion: 1.5 }),
    ],
    [
      "a non-boolean onVehicle",
      JSON.stringify({ ...snapshot, onVehicle: "yes" }),
    ],
    [
      "a malformed position",
      JSON.stringify({ ...snapshot, latestPosition: { latitude: 25 } }),
    ],
  ])("rejects %s", async (_label, raw) => {
    getRedis.mockResolvedValue(raw);
    await expect(getNavigationSnapshot("nav")).resolves.toBeNull();
  });

  it("accepts a snapshot without a position", async () => {
    getRedis.mockResolvedValue(
      JSON.stringify({ ...snapshot, latestPosition: null }),
    );
    await expect(getNavigationSnapshot("nav")).resolves.toMatchObject({
      latestPosition: null,
    });
  });

  it("deletes the snapshot key with user ownership verification", async () => {
    evalRedis.mockResolvedValue(1);
    await deleteNavigationSnapshot("nav", "u");
    expect(evalRedis).toHaveBeenCalledWith(
      expect.any(String),
      1,
      "voice-nav:snapshot:nav",
      "u",
    );
  });

  it("fails soft when Redis is unavailable", async () => {
    redisReady.mockRejectedValue(new Error("down"));
    await expect(storeNavigationSnapshot(snapshot)).resolves.toBeUndefined();
    await expect(getNavigationSnapshot("nav")).resolves.toBeNull();
    await expect(deleteNavigationSnapshot("nav", "u")).resolves.toBeUndefined();
    expect(setRedis).not.toHaveBeenCalled();
    expect(evalRedis).not.toHaveBeenCalled();
  });
});
