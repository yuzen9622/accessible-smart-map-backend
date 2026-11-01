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
    travelMode: "drive",
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
  it("marks the current selection explicitly without leaking its bearer token or geometry", async () => {
    const ctx = new RouteConversationContext();
    ctx.adopt(result);
    expect(ctx.prompt).toContain('"selected":true');
    expect(ctx.prompt).toContain('"routeId":"bus-a"');
    expect(ctx.prompt).not.toMatch(/polyline|capability-secret|routeToken/);
    await ctx.set(null);
    expect(ctx.prompt).toContain('"selected":false');
    expect(ctx.prompt).not.toContain('"routeId":"bus-a"');
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
  it.each(["en", "zh-TW", undefined] as const)(
    "localizes missing selection for %s without calling the executor",
    async (language) => {
      const ctx = new RouteConversationContext();
      const raw = vi.fn();
      const output = await createRouteAwareExecutor(ctx, raw)(
        "getNavInstructions",
        {},
        undefined,
        undefined,
        { language },
      );
      expect(typeof output).toBe("string");
      const parsed = JSON.parse(output as string);
      expect(parsed).toMatchObject({
        ok: false,
        reason: "ROUTE_CONTEXT_REQUIRED",
      });
      expect(parsed.error).toBe(
        language === "en"
          ? "No route has been selected. Please plan and select a route before requesting instructions."
          : "尚未選擇路線；請先規劃並選擇路線，再查詢詳細指引。",
      );
      expect(raw).not.toHaveBeenCalled();
    },
  );
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
  it("adopts indoor plans and retains applicable accessibility conditions from an outdoor trip", async () => {
    const ctx = new RouteConversationContext();
    ctx.adopt(result);
    const indoor = {
      ...result,
      journeyKind: "indoor",
      selectedRouteId: "indoor-a",
      originVenuePlace: {
        venueId: "v",
        placeId: "2606",
        sourceVersion: 2,
        buildingId: "info",
        levelRef: "6F",
      },
      destinationVenuePlace: {
        venueId: "v",
        placeId: "2301",
        sourceVersion: 2,
        buildingId: "info",
        levelRef: "3F",
      },
      venueLeg: {
        fromPlaceId: "2606",
        toPlaceId: "2301",
        steps: [
          {
            type: "elevator",
            instruction: "搭電梯到3F",
            fromLevelRef: "6F",
            toLevelRef: "3F",
          },
        ],
        path: { coordinates: [[120, 24, 18]] },
      },
      routes: [
        { ...route, routeId: "indoor-a", routeToken: "indoor-token", legs: [] },
      ],
      effectivePreferences: {
        mode: "wheelchair",
        travelMode: "walk",
        transitPreference: "none",
        avoidStairs: true,
      },
    };
    const raw = vi
      .fn()
      .mockResolvedValueOnce(JSON.stringify(indoor))
      .mockResolvedValueOnce('{"ok":true}');
    const exec = createRouteAwareExecutor(ctx, raw);
    await exec("planIndoorRoute", { fromPlaceId: "2606", toPlaceId: "2301" });
    expect(raw.mock.calls[0][1]).toEqual({
      mode: "wheelchair",
      avoidStairs: true,
      fromPlaceId: "2606",
      toPlaceId: "2301",
    });
    expect(ctx.token).toBe("indoor-token");
    expect(ctx.preferences).toMatchObject({
      mode: "wheelchair",
      travelMode: "walk",
    });
    expect(ctx.prompt).toContain("搭電梯到3F");
    expect(ctx.prompt).toContain('"sourceVersion":2');
    expect(ctx.prompt).not.toMatch(
      /indoor-token|coordinates|capability-secret/,
    );
    await exec("getNavInstructions", {});
    expect(raw.mock.calls[1][4]).toMatchObject({ routeToken: "indoor-token" });
  });

  it.each(["avoidStairs", "requireElevator"] as const)(
    "retains a confirmed %s requirement for indoor planning without inheriting the outdoor travel mode",
    async (requirement) => {
      const ctx = new RouteConversationContext();
      ctx.adopt({
        ...result,
        effectivePreferences: {
          mode: "normal",
          travelMode: "drive",
          [requirement]: true,
        },
      });
      const raw = vi
        .fn()
        .mockResolvedValue('{"ok":false,"reason":"NO_ACCESSIBLE_ROUTE"}');
      await createRouteAwareExecutor(ctx, raw)("planIndoorRoute", {
        fromPlaceId: "a",
        toPlaceId: "b",
      });
      expect(raw.mock.calls[0][1]).toEqual({
        mode: "normal",
        [requirement]: true,
        fromPlaceId: "a",
        toPlaceId: "b",
      });
      expect(ctx.token).toBe("capability-secret");
      expect(ctx.preferences).toMatchObject({ [requirement]: true });
    },
  );

  it("honors explicit false for indoor constraints while leaving the previous selection unchanged on failure", async () => {
    const ctx = new RouteConversationContext({
      mode: "normal",
      avoidStairs: true,
      requireElevator: true,
    });
    const raw = vi.fn().mockResolvedValue('{"ok":false}');
    await createRouteAwareExecutor(ctx, raw)("planIndoorRoute", {
      fromPlaceId: "a",
      toPlaceId: "b",
      avoidStairs: false,
      requireElevator: false,
    });
    expect(raw.mock.calls[0][1]).toEqual({
      mode: "normal",
      avoidStairs: false,
      requireElevator: false,
      fromPlaceId: "a",
      toPlaceId: "b",
    });
    expect(ctx.preferences).toMatchObject({
      avoidStairs: true,
      requireElevator: true,
    });
  });

  it("rehydrates indoor steps and floors from the trusted token envelope", async () => {
    lookup.mockResolvedValue({
      route: { ...route, legs: [] },
      navigationId: "nav-a",
      routeVersion: 1,
      canonicalRequest: { mode: "wheelchair", travelMode: "walk" },
      venueLegs: {
        departure: {
          venueId: "nutc-sanmin",
          venueVersion: 4,
          fromPlaceId: "2606",
          toPlaceId: "2301",
          mode: "wheelchair",
          steps: [
            {
              type: "elevator",
              instruction: "搭電梯到3F",
              fromLevelRef: "6F",
              toLevelRef: "3F",
            },
          ],
        },
      },
    });
    const ctx = new RouteConversationContext();
    expect(await ctx.set({ routeToken: "indoor-secret" })).toMatchObject({
      ok: true,
    });
    expect(ctx.prompt).toContain('"fromPlaceId":"2606"');
    expect(ctx.prompt).toContain('"floors":"6F→3F"');
    expect(ctx.prompt).toContain('"venueId":"nutc-sanmin"');
    expect(ctx.prompt).toContain('"venueVersion":4');
    expect(ctx.prompt).not.toContain("indoor-secret");
  });

  it("does not replace a selected route when indoor planning fails or arrives after clearing", async () => {
    const ctx = new RouteConversationContext();
    ctx.adopt(result);
    const failed = vi
      .fn()
      .mockResolvedValue('{"ok":false,"reason":"NO_ROUTE"}');
    await createRouteAwareExecutor(ctx, failed)("planIndoorRoute", {
      fromPlaceId: "a",
      toPlaceId: "b",
    });
    expect(ctx.token).toBe("capability-secret");
    let finish!: (value: string) => void;
    const raw = vi.fn(
      () =>
        new Promise<string>((resolve) => {
          finish = resolve;
        }),
    );
    const pending = createRouteAwareExecutor(ctx, raw)("planIndoorRoute", {
      fromPlaceId: "a",
      toPlaceId: "b",
    });
    await ctx.set(null);
    finish(JSON.stringify(result));
    expect(await pending).toContain("STALE_SELECTION");
    expect(ctx.token).toBeUndefined();
  });

  it.each(["normal", "elderly"] as const)(
    "adopts a new %s motorcycle plan while retaining accessibility conditions from the previous trip",
    async (mode) => {
      const ctx = new RouteConversationContext({ mode: "wheelchair" });
      ctx.adopt({
        ...result,
        effectivePreferences: {
          mode: "normal",
          travelMode: "drive",
          avoidStairs: true,
          requireElevator: true,
        },
      });
      const next = {
        ...result,
        planId: "motorcycle-plan",
        selectedRouteId: "motorcycle-b",
        routes: [
          {
            ...route,
            routeId: "motorcycle-b",
            routeToken: "motorcycle-token",
            legs: [{ type: "MOTORCYCLE" }],
          },
        ],
        effectivePreferences: {
          mode,
          travelMode: "motorcycle",
          avoidStairs: true,
          requireElevator: true,
        },
      };
      const raw = vi
        .fn()
        .mockResolvedValueOnce(JSON.stringify(next))
        .mockResolvedValueOnce('{"ok":true}');
      const exec = createRouteAwareExecutor(ctx, raw);
      await exec("planAccessibleRoute", {
        origin: "台北車站",
        destination: "松山車站",
        mode,
        travelMode: "motorcycle",
      });
      expect(raw.mock.calls[0][1]).toMatchObject({
        mode,
        travelMode: "motorcycle",
        avoidStairs: true,
        requireElevator: true,
      });
      expect(ctx.preferences).toEqual(next.effectivePreferences);
      expect(ctx.token).toBe("motorcycle-token");
      expect(ctx.prompt).toContain('"routeId":"motorcycle-b"');
      expect(ctx.prompt).not.toContain('"routeId":"bus-a"');
      await exec("getNavInstructions", {});
      expect(raw.mock.calls[1][4]).toMatchObject({
        routeToken: "motorcycle-token",
      });
    },
  );

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
      travelMode: "drive",
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
