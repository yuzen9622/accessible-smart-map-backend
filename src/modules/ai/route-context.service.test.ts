import { beforeEach, describe, expect, it, vi } from "vitest";
const { lookup } = vi.hoisted(() => ({ lookup: vi.fn() }));
vi.mock("../accessible-route/route-token.service", () => ({
  getNavigationEnvelopeByToken: lookup,
}));
import {
  RouteConversationContext,
  createRouteAwareExecutor,
} from "./route-context.service";
import { summarizeToolResult } from "../agent/conversation-context";

const route = {
  routeId: "bus-a",
  navigationId: "nav-a",
  routeVersion: 1,
  routeToken: "capability-secret",
  routeName: "方案 1",
  totalMinutes: 15,
  transferCount: 0,
  accessibilityHighlights: [],
  legs: [
    {
      type: "BUS",
      routeName: "99",
      departureStop: "起站",
      arrivalStop: "台中火車站",
      polyline: [
        [120, 24],
        [121, 25],
      ],
    },
  ],
};
const result = {
  ok: true,
  routeContractVersion: 1,
  planId: "plan-a",
  selectedRouteId: "bus-a",
  routes: [route],
  effectivePreferences: {
    mode: "wheelchair",
    transitPreference: "bus",
    avoidStairs: true,
  },
};

beforeEach(() => vi.resetAllMocks());
describe("trusted route context and projections", () => {
  it("delivers the original geometry to UI, a token-free BUS summary to the model, then uses the same token for instructions", async () => {
    const ctx = new RouteConversationContext();
    const raw = vi
      .fn()
      .mockResolvedValueOnce(JSON.stringify(result))
      .mockResolvedValueOnce('{"ok":true,"instructions":[]}');
    const exec = createRouteAwareExecutor(ctx, raw);
    const output = await exec("planAccessibleRoute", {
      origin: "這裡",
      destination: "台中火車站",
    });
    expect(typeof output).toBe("object");
    if (typeof output === "string") throw new Error("missing projections");
    expect(output.clientResult).toEqual(result);
    expect(JSON.stringify(output.modelResult)).toContain('"type":"BUS"');
    expect(JSON.stringify(output.modelResult)).not.toMatch(
      /polyline|capability-secret|routeToken/,
    );
    await exec("getNavInstructions", {
      routeToken: "model-made-up",
      origin: "other",
      destination: "other",
    });
    expect(raw).toHaveBeenCalledTimes(2);
    expect(raw.mock.calls[1][4]).toMatchObject({
      routeToken: "capability-secret",
    });
    expect(
      JSON.parse(summarizeToolResult(result)).routes[0].legs[0],
    ).toMatchObject({ type: "BUS", routeName: "99" });
  });
  it("does not replan instructions without a selection, and invalid selection clears the previous one", async () => {
    const ctx = new RouteConversationContext();
    const raw = vi.fn();
    const exec = createRouteAwareExecutor(ctx, raw);
    expect(
      await exec("getNavInstructions", { origin: "A", destination: "B" }),
    ).toContain("ROUTE_CONTEXT_REQUIRED");
    ctx.adopt(result);
    lookup.mockResolvedValue(null);
    expect(await ctx.set({ routeToken: "expired" })).toMatchObject({
      ok: false,
      reason: "INVALID_ROUTE_TOKEN",
    });
    expect(await exec("getNavInstructions", {})).toContain(
      "INVALID_ROUTE_TOKEN",
    );
    expect(raw).not.toHaveBeenCalled();
  });
  it("rejects stale token lookups and stale in-flight planning results after a clear", async () => {
    const ctx = new RouteConversationContext();
    let finish!: (value: unknown) => void;
    lookup.mockReturnValue(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    const setting = ctx.set({ routeToken: "old" });
    await ctx.set(null);
    finish({
      route,
      canonicalRequest: {},
      navigationId: "nav-a",
      routeVersion: 1,
    });
    expect(await setting).toMatchObject({
      ok: false,
      reason: "STALE_SELECTION",
    });
    const raw = vi.fn(
      () =>
        new Promise<string>((resolve) => {
          finish = resolve as typeof finish;
        }),
    );
    const running = createRouteAwareExecutor(ctx, raw)("planAccessibleRoute", {
      origin: "A",
      destination: "B",
    });
    await ctx.set(null);
    finish(JSON.stringify(result));
    expect(await running).toContain("STALE_SELECTION");
    expect(ctx.token).toBeUndefined();
  });
  it("keeps confirmed trip preferences but allows explicit none and false to clear them", async () => {
    const ctx = new RouteConversationContext({ mode: "normal" });
    ctx.adopt(result);
    const raw = vi.fn().mockResolvedValue('{"ok":false}');
    await createRouteAwareExecutor(ctx, raw)("planAccessibleRoute", {
      origin: "A",
      destination: "B",
      transitPreference: "none",
      avoidStairs: false,
    });
    expect(raw.mock.calls[0][1]).toMatchObject({
      mode: "wheelchair",
      transitPreference: "none",
      avoidStairs: false,
    });
  });
});

it("bounds unavailable token storage and never adopts a response arriving after timeout", async () => {
  vi.useFakeTimers();
  try {
    let finish!: (value: unknown) => void;
    lookup.mockReturnValue(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    const ctx = new RouteConversationContext();
    const pending = ctx.set({ routeToken: "slow" });
    await vi.advanceTimersByTimeAsync(5000);
    expect(await pending).toEqual({
      ok: false,
      reason: "ROUTE_CONTEXT_UNAVAILABLE",
    });
    finish({
      route,
      canonicalRequest: {},
      navigationId: "nav-a",
      routeVersion: 1,
    });
    await Promise.resolve();
    expect(ctx.token).toBeUndefined();
  } finally {
    vi.useRealTimers();
  }
});
