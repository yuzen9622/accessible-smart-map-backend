import { beforeEach, describe, expect, it, vi } from "vitest";

const { redisGet, redisSetChecked } = vi.hoisted(() => ({
  redisGet: vi.fn(),
  redisSetChecked: vi.fn(),
}));
vi.mock("../../config/redis", () => ({ redisGet, redisSetChecked }));

import { attachRouteTokens, getRouteByToken } from "./route-token.service";
import type { AccessibleRoute } from "../../types/route";

const sampleRoute: AccessibleRoute = {
  routeId: "route-1",
  routeName: "步行",
  totalMinutes: 3,
  transferCount: 0,
  legs: [],
  accessibilityHighlights: [],
};

describe("route token cache", () => {
  beforeEach(() => vi.clearAllMocks());

  it("adds a high-entropy token only after Redis confirms the write", async () => {
    redisSetChecked.mockResolvedValue(true);
    const [stored] = await attachRouteTokens([sampleRoute]);
    expect(stored.routeToken!).toMatch(/^[A-Za-z0-9_-]{40,}$/);
    expect(redisSetChecked).toHaveBeenCalledWith(
      expect.stringContaining(stored.routeToken!),
      JSON.stringify(sampleRoute),
      1800,
    );
  });

  it("omits routeToken when Redis is unavailable instead of returning an invalid token", async () => {
    redisSetChecked.mockResolvedValue(false);
    const [stored] = await attachRouteTokens([sampleRoute]);
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
});
