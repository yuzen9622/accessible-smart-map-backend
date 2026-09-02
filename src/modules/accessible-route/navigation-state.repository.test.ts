import { beforeEach, describe, expect, it, vi } from "vitest";

const { evalRedis, getRedis, redisReady } = vi.hoisted(() => ({
  evalRedis: vi.fn(),
  getRedis: vi.fn(),
  redisReady: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../../config/redis", () => ({
  redisReady,
  redisClient: { status: "ready", eval: evalRedis, get: getRedis },
}));

import {
  beginReroute,
  finalizeReroute,
  readNavigationTokenStrict,
  storeInitialNavigationEnvelope,
} from "./navigation-state.repository";

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
