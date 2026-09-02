import { beforeEach, describe, expect, it, vi } from "vitest";

const { redisGet, storeInitialNavigationEnvelope } = vi.hoisted(() => ({
  redisGet: vi.fn(),
  storeInitialNavigationEnvelope: vi.fn(),
}));
vi.mock("../../config/redis", () => ({ redisGet }));
vi.mock("./navigation-state.repository", () => ({
  navigationTokenKey: (token: string) => `voice-nav:route:${token}`,
  storeInitialNavigationEnvelope,
}));

import {
  attachRouteTokens,
  getNavigationEnvelopeByToken,
  getRouteByToken,
} from "./route-token.service";
import type { AccessibleRoute } from "../../types/route";

const sampleRoute: AccessibleRoute = {
  routeId: "route-1",
  routeName: "步行",
  totalMinutes: 3,
  transferCount: 0,
  legs: [],
  accessibilityHighlights: [],
};
const canonicalRequest = {
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
};

describe("route token cache", () => {
  beforeEach(() => vi.clearAllMocks());

  it("adds a high-entropy token only after Redis confirms the write", async () => {
    storeInitialNavigationEnvelope.mockResolvedValue(true);
    const [stored] = await attachRouteTokens([sampleRoute], canonicalRequest);
    expect(stored.routeToken!).toMatch(/^[A-Za-z0-9_-]{40,}$/);
    expect(stored.navigationId).toMatch(/^[0-9a-f-]{36}$/);
    expect(stored.routeVersion).toBe(1);
    expect(storeInitialNavigationEnvelope).toHaveBeenCalledWith(
      stored.routeToken,
      expect.objectContaining({
        schemaVersion: 1,
        navigationId: stored.navigationId,
        routeVersion: 1,
        canonicalRequest,
      }),
    );
  });

  it("omits routeToken when Redis is unavailable instead of returning an invalid token", async () => {
    storeInitialNavigationEnvelope.mockResolvedValue(false);
    const [stored] = await attachRouteTokens([sampleRoute], canonicalRequest);
    expect(stored).toEqual(sampleRoute);
    expect(stored.routeToken).toBeUndefined();
  });

  it("resolves valid cached JSON and treats misses or malformed values as expired", async () => {
    redisGet.mockResolvedValueOnce(JSON.stringify(sampleRoute));
    await expect(getRouteByToken("cap")).resolves.toEqual(sampleRoute);
    redisGet.mockResolvedValueOnce(null);
    await expect(getRouteByToken("missing")).resolves.toBeNull();
    redisGet.mockResolvedValueOnce("not-json");
    await expect(getRouteByToken("bad")).resolves.toBeNull();
  });

  it("reads schemaVersion=1 envelopes while retaining legacy raw-route compatibility", async () => {
    const storedEnvelope = {
      schemaVersion: 1,
      route: { ...sampleRoute, navigationId: "nav", routeVersion: 1 },
      navigationId: "nav",
      routeVersion: 1,
      canonicalRequest,
    };
    redisGet.mockResolvedValueOnce(JSON.stringify(storedEnvelope));
    await expect(getRouteByToken("v1")).resolves.toMatchObject({
      routeId: "route-1",
      navigationId: "nav",
      routeVersion: 1,
    });
    redisGet.mockResolvedValueOnce(JSON.stringify(storedEnvelope));
    await expect(getNavigationEnvelopeByToken("v1")).resolves.toEqual(
      storedEnvelope,
    );
    redisGet.mockResolvedValueOnce(JSON.stringify(sampleRoute));
    await expect(getNavigationEnvelopeByToken("legacy")).resolves.toBeNull();
  });
});
