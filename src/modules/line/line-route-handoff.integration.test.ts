import express from "express";
import type { Server } from "http";
import request from "supertest";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { lineRoutePlanFixture } from "../../../tests/helpers/line-route";

const state = vi.hoisted(() => {
  const values = new Map<string, { value: string; expires: number }>();
  const get = vi.fn(async (key: string) => {
    const entry = values.get(key);
    return entry && entry.expires > Date.now() ? entry.value : null;
  });
  const set = vi.fn(
    async (key: string, value: string, _ex: string, ttl: number) => {
      values.set(key, { value, expires: Date.now() + ttl * 1000 });
      return "OK";
    },
  );
  return {
    values,
    get,
    set,
    run: vi.fn(),
    execute: vi.fn(),
    lookup: vi.fn(),
    cacheAvailable: true,
  };
});
vi.mock("../../config/redis", () => ({
  redisClient: {
    get: state.get,
    set: state.set,
    del: vi.fn(async (key: string) => state.values.delete(key)),
  },
  redisGet: state.get,
  redisSetChecked: async (key: string, value: string, ttl: number) => {
    if (!state.cacheAvailable) return false;
    return (await state.set(key, value, "EX", ttl)) === "OK";
  },
  redisSetNx: vi.fn(async () => true),
}));
vi.mock("../agent/agent-manager.service", () => ({ runToolLoop: state.run }));
vi.mock("../ai/agent-tools", () => ({ executeLocalTool: state.execute }));
vi.mock("../../config/ai", () => ({ model: "fixture-model" }));
vi.mock("../accessible-route/route-token.service", () => ({
  getNavigationEnvelopeByToken: state.lookup,
}));
vi.mock("../accessible-route/accessible-route.service", () => ({
  planAccessibleRouteFromRequest: vi.fn(),
}));
vi.mock("../../adapters/line.adapter");
vi.mock("../../adapters/ai-audio.adapter", () => ({
  transcribeAudio: vi.fn(),
}));
vi.mock("./line.repository", () => ({ updateBoundContactLocations: vi.fn() }));
vi.mock("./line-menu.service", () => ({}));
vi.mock("../sos/sos.service", () => ({
  listActiveSosForLineUser: vi.fn(async () => ({ bound: false, sessions: [] })),
}));
vi.mock("../user/user.service", () => ({}));
vi.mock("../emergency-contact/emergency-contact.service", () => ({}));
import {
  replyAgentResult,
  showLoadingAnimation,
} from "../../adapters/line.adapter";
import { createLineRouter } from "./line.router";
import { handleEvents } from "./line.service";
import type { LineEvent } from "./line.types";

const location = { latitude: 25.03, longitude: 121.56 };
const event = (user: string, message: Record<string, unknown>) =>
  ({
    type: "message",
    replyToken: "reply",
    timestamp: Date.now(),
    source: { type: "user", userId: user },
    message: { id: "fixture-message", ...message },
  }) as LineEvent;
let server: Server;
beforeAll(async () => {
  const app = express();
  app.use("/api/v1/line", createLineRouter());
  server = await new Promise<Server>((resolve) => {
    const http = app.listen(0, "127.0.0.1", () => resolve(http));
  });
});
afterAll(async () => {
  vi.useRealTimers();
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
});
beforeEach(() => {
  vi.clearAllMocks();
  vi.useRealTimers();
  state.values.clear();
  state.cacheAvailable = true;
  vi.mocked(showLoadingAnimation).mockResolvedValue(undefined);
  process.env.PUBLIC_LIFF_ROUTE_BASE_URL = "https://liff.line.me/fixture-liff";
  state.execute.mockResolvedValue(JSON.stringify(lineRoutePlanFixture()));
  state.run.mockImplementation(async (...args) => {
    const output = await args[10]("planAccessibleRoute", {
      origin: "current_location",
      destination: "台北車站",
    });
    return {
      text: "搭乘 307 到台北車站。",
      toolResults: [
        { name: "planAccessibleRoute", args: {}, result: output.clientResult },
      ],
    };
  });
});

describe("LINE location → agent → preview HTTP handoff", () => {
  it("remembers a separate location webhook and serves that exact plan through the card URL", async () => {
    await handleEvents([event("user-a", { type: "location", ...location })]);
    await handleEvents([
      event("user-a", { type: "text", text: "我要去台北車站" }),
    ]);
    expect(state.run.mock.calls[0][3]).toEqual(location);
    expect(state.run.mock.calls[0][1]).toContain("current_location");
    expect(state.execute.mock.calls[0][2]).toEqual(location);
    const card = vi.mocked(replyAgentResult).mock.calls[0][2];
    const url = new URL(card!.liffUrl!);
    const planToken = url.searchParams.get("planToken");
    expect(planToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(url.search).not.toMatch(/25\.03|121\.56|user-a|sessionId/);
    const response = await request(server)
      .get("/api/v1/line/route-preview")
      .query({ planToken });
    expect(response.status).toBe(200);
    expect(response.body.data).toEqual(lineRoutePlanFixture());
    expect(state.execute).toHaveBeenCalledTimes(1);
  });

  it("restores a trusted selected route on the next text turn without planning again", async () => {
    await handleEvents([event("user-a", { type: "location", ...location })]);
    await handleEvents([
      event("user-a", { type: "text", text: "我要去台北車站" }),
    ]);
    const plan = lineRoutePlanFixture();
    state.lookup.mockResolvedValue({
      schemaVersion: 1,
      route: plan.routes[0],
      navigationId: "navigation-id",
      routeVersion: 1,
      canonicalRequest: plan.effectivePreferences,
    });
    state.run.mockImplementationOnce(async (...args) => {
      expect(args[1]).toContain("公車路線");
      expect(args[1]).toContain('"mode":"wheelchair"');
      expect(args[1]).not.toContain("trusted-route-token");
      const output = await args[10]("getNavInstructions", {});
      return {
        text: "在起站搭乘 307。",
        toolResults: [
          { name: "getNavInstructions", args: {}, result: output.clientResult },
        ],
      };
    });
    state.execute.mockResolvedValueOnce('{"ok":true,"instructions":[]}');
    await handleEvents([
      event("user-a", { type: "text", text: "要在哪裡上車？" }),
    ]);
    expect(state.lookup).toHaveBeenCalledWith("trusted-route-token");
    expect(state.execute.mock.calls.map((call) => call[0])).toEqual([
      "planAccessibleRoute",
      "getNavInstructions",
    ]);
    expect(state.execute.mock.calls[1][4]).toMatchObject({
      lineUserId: "user-a",
      routeToken: "trusted-route-token",
    });
    expect(vi.mocked(replyAgentResult).mock.calls[1][1]).toBe(
      "在起站搭乘 307。",
    );
  });

  it("does not share location or selected-route context with another LINE user", async () => {
    await handleEvents([event("user-a", { type: "location", ...location })]);
    await handleEvents([
      event("user-a", { type: "text", text: "我要去台北車站" }),
    ]);
    state.run.mockResolvedValueOnce({
      text: "請分享目前位置。",
      toolResults: [],
    });
    await handleEvents([
      event("user-b", { type: "text", text: "我要去台北車站" }),
    ]);
    expect(state.run.mock.calls[1][3]).toBeUndefined();
    expect(state.lookup).not.toHaveBeenCalled();
    expect(state.run.mock.calls[1][1]).not.toContain("緯度 25.03");
  });

  it("expires both precise location and preview after 30 minutes without sliding preview TTL", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-20T00:00:00Z"));
    await handleEvents([event("user-a", { type: "location", ...location })]);
    await handleEvents([
      event("user-a", { type: "text", text: "我要去台北車站" }),
    ]);
    const card = vi.mocked(replyAgentResult).mock.calls[0][2];
    const planToken = new URL(card!.liffUrl!).searchParams.get("planToken");
    expect(planToken).toBeTruthy();
    vi.setSystemTime(new Date("2026-10-20T00:29:59Z"));
    expect(
      (
        await request(server)
          .get("/api/v1/line/route-preview")
          .query({ planToken })
      ).status,
    ).toBe(200);
    vi.setSystemTime(new Date("2026-10-20T00:30:01Z"));
    expect(
      (
        await request(server)
          .get("/api/v1/line/route-preview")
          .query({ planToken })
      ).status,
    ).toBe(404);
    state.run.mockResolvedValueOnce({
      text: "請重新分享位置。",
      toolResults: [],
    });
    await handleEvents([
      event("user-a", { type: "text", text: "附近有什麼？" }),
    ]);
    expect(state.run.mock.calls[1][3]).toBeUndefined();
  });

  it("never sends a bare map link when the snapshot cache is unavailable", async () => {
    state.cacheAvailable = false;
    await handleEvents([
      event("user-a", { type: "text", text: "從市政府去台北車站" }),
    ]);
    expect(
      vi.mocked(replyAgentResult).mock.calls[0][2]?.liffUrl,
    ).toBeUndefined();
  });

  it.each([
    {},
    { planToken: "invalid" },
    { sessionId: "68f000000000000000000001" },
    { planToken: "a".repeat(43), sessionId: "a".repeat(32) },
    { planToken: "a".repeat(43), travelMode: "drive" },
  ])("rejects ambiguous or invalid preview query %j", async (query) => {
    const response = await request(server)
      .get("/api/v1/line/route-preview")
      .query(query);
    expect(response.status).toBe(400);
  });

  it("returns 404 for an unknown valid capability rather than treating it as an SOS id", async () => {
    const response = await request(server)
      .get("/api/v1/line/route-preview")
      .query({ planToken: "a".repeat(43) });
    expect(response.status).toBe(404);
  });
});
