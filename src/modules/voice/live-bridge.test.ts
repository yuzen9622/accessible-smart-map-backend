import { beforeEach, describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";

const {
  connect,
  getRouteByToken,
  getNavigationEnvelopeByToken,
  rerouteAccessibleRoute,
  getMemorySettings,
  loadMemories,
} = vi.hoisted(() => ({
  connect: vi.fn(),
  getRouteByToken: vi.fn(),
  getNavigationEnvelopeByToken: vi.fn(),
  rerouteAccessibleRoute: vi.fn(),
  getMemorySettings: vi.fn().mockResolvedValue({ memoryEnabled: false }),
  loadMemories: vi.fn().mockResolvedValue([]),
}));
vi.mock("../../config/ai", () => ({ googleGenAi: { live: { connect } } }));
vi.mock("../agent/tool-catalog", () => ({ buildGeminiTools: vi.fn(() => []) }));
vi.mock("../ai/agent-tools", () => ({ executeLocalTool: vi.fn() }));
vi.mock("../accessible-route/route-token.service", () => ({
  getRouteByToken,
  getNavigationEnvelopeByToken,
}));
vi.mock("../accessible-route/reroute.service", () => ({
  rerouteAccessibleRoute,
}));
vi.mock("../ai/memory.service", () => ({ getMemorySettings, loadMemories }));
vi.mock("./transcript-corrector", () => ({
  correctUserTranscript: vi.fn(async (t: string) => t.replace("珠北", "竹北")),
}));

import { createLiveBridge } from "./live-bridge";
import { executeLocalTool } from "../ai/agent-tools";
import { buildGeminiTools } from "../agent/tool-catalog";
import { correctUserTranscript } from "./transcript-corrector";

function makeWs(): WebSocket {
  return {
    readyState: WebSocket.OPEN,
    bufferedAmount: 0,
    send: vi.fn(),
    close: vi.fn(),
  } as unknown as WebSocket;
}

function makeSession() {
  return {
    sendRealtimeInput: vi.fn(),
    sendClientContent: vi.fn(),
    sendToolResponse: vi.fn(),
    close: vi.fn(),
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

const REROUTE_COOLDOWN_MS = 30_000;
const start = [121, 25] as [number, number];
const end = [121.001, 25] as [number, number];
const walkRoute = {
  routeId: "r",
  routeName: "walk",
  totalMinutes: 2,
  transferCount: 0,
  accessibilityHighlights: [],
  legs: [
    {
      type: "WALK",
      from: "A",
      to: "B",
      distanceM: 100,
      minutesEst: 2,
      polyline: [start, end],
      a11yFacilities: [],
      steps: [
        {
          relativeDirection: "DEPART",
          absoluteDirection: null,
          streetName: "路",
          bogusName: false,
          area: false,
          distanceM: 50,
          location: start,
          instruction: "向前走",
        },
        {
          relativeDirection: "CONTINUE",
          absoluteDirection: null,
          streetName: "路",
          bogusName: false,
          area: false,
          distanceM: 50,
          location: end,
          instruction: "抵達路口",
        },
      ],
    },
  ],
} as any;

describe("createLiveBridge transcript forwarding", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getNavigationEnvelopeByToken.mockResolvedValue(null);
    delete process.env.GEMINI_LIVE_TEMPERATURE;
    delete process.env.GEMINI_LIVE_LANGUAGE_CODE;
  });

  it("normalizes both user and model transcripts before sending them to the client", async () => {
    let onmessage: ((message: unknown) => void) | undefined;
    connect.mockImplementation(async ({ callbacks }) => {
      onmessage = callbacks.onmessage;
      return makeSession();
    });
    const ws = makeWs();

    await createLiveBridge({ ws, userId: "voice-user" });
    onmessage?.({
      serverContent: {
        inputTranscription: { text: "带我去火车站" },
        outputTranscription: { text: "好的，我帮您查询" },
      },
    });

    await vi.waitFor(() => expect(ws.send).toHaveBeenCalledTimes(2));
    expect(ws.send).toHaveBeenCalledWith(
      JSON.stringify({
        type: "transcript",
        role: "user",
        text: "帶我去火車站",
        final: false,
        utteranceId: "u1",
      }),
    );
    expect(ws.send).toHaveBeenCalledWith(
      JSON.stringify({
        type: "transcript",
        role: "model",
        text: "好的，我幫您查詢",
      }),
    );
  });

  it("accumulates interim user fragments and emits a raw final plus a later correction", async () => {
    let onmessage: ((message: unknown) => void) | undefined;
    connect.mockImplementation(async ({ callbacks }) => {
      onmessage = callbacks.onmessage;
      return makeSession();
    });
    const ws = makeWs();

    await createLiveBridge({ ws, userId: "voice-user" });
    onmessage?.({
      serverContent: { inputTranscription: { text: "我想去珠北" } },
    });
    onmessage?.({
      serverContent: { inputTranscription: { text: "車站", finished: true } },
    });

    await vi.waitFor(() => expect(ws.send).toHaveBeenCalledTimes(4));
    expect(ws.send).toHaveBeenNthCalledWith(
      1,
      JSON.stringify({
        type: "transcript",
        role: "user",
        text: "我想去珠北",
        final: false,
        utteranceId: "u1",
      }),
    );
    expect(ws.send).toHaveBeenNthCalledWith(
      2,
      JSON.stringify({
        type: "transcript",
        role: "user",
        text: "車站",
        final: false,
        utteranceId: "u1",
      }),
    );
    expect(ws.send).toHaveBeenNthCalledWith(
      3,
      JSON.stringify({
        type: "transcript",
        role: "user",
        text: "我想去珠北車站",
        final: true,
        utteranceId: "u1",
      }),
    );
    expect(ws.send).toHaveBeenNthCalledWith(
      4,
      JSON.stringify({
        type: "transcript.correction",
        role: "user",
        text: "我想去竹北車站",
        utteranceId: "u1",
      }),
    );
  });

  it("skips the correction frame when the corrector changes nothing", async () => {
    let onmessage: ((message: unknown) => void) | undefined;
    connect.mockImplementation(async ({ callbacks }) => {
      onmessage = callbacks.onmessage;
      return makeSession();
    });
    const ws = makeWs();

    await createLiveBridge({ ws, userId: "voice-user" });
    onmessage?.({
      serverContent: {
        inputTranscription: { text: "我想去竹北車站", finished: true },
      },
    });

    await vi.waitFor(() => expect(ws.send).toHaveBeenCalledTimes(2));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(ws.send).toHaveBeenCalledTimes(2);
    expect(
      (ws.send as unknown as { mock: { calls: string[][] } }).mock.calls.map(
        (call) => JSON.parse(call[0]).type,
      ),
    ).toEqual(["transcript", "transcript"]);
  });

  it("does not send the correction frame when the session closed while it was in flight", async () => {
    let onmessage: ((message: unknown) => void) | undefined;
    connect.mockImplementation(async ({ callbacks }) => {
      onmessage = callbacks.onmessage;
      return makeSession();
    });
    const ws = makeWs();
    vi.mocked(correctUserTranscript).mockImplementationOnce(
      (text: string) =>
        new Promise((resolve) =>
          setTimeout(() => resolve(text.replace("珠北", "竹北")), 300),
        ),
    );

    const bridge = await createLiveBridge({ ws, userId: "voice-user" });
    onmessage?.({
      serverContent: {
        inputTranscription: { text: "我想去珠北車站", finished: true },
      },
    });
    await vi.waitFor(() => expect(ws.send).toHaveBeenCalledTimes(2));
    bridge.close();

    await new Promise((resolve) => setTimeout(resolve, 450));
    const types = (
      ws.send as unknown as { mock: { calls: string[][] } }
    ).mock.calls.map((call) => JSON.parse(call[0]).type);
    expect(types).not.toContain("transcript.correction");
  });

  it("emits the user final before any model transcript even when correction is slow", async () => {
    let onmessage: ((message: unknown) => void) | undefined;
    connect.mockImplementation(async ({ callbacks }) => {
      onmessage = callbacks.onmessage;
      return makeSession();
    });
    const ws = makeWs();
    vi.mocked(correctUserTranscript).mockImplementationOnce(
      (text: string) =>
        new Promise((resolve) => setTimeout(() => resolve(text), 60)),
    );

    await createLiveBridge({ ws, userId: "voice-user" });
    onmessage?.({ serverContent: { inputTranscription: { text: "你好。" } } });
    onmessage?.({
      serverContent: {
        modelTurn: { parts: [{ text: "" }] },
        outputTranscription: { text: "您好！有什麼我可以幫您的嗎？" },
      },
    });
    onmessage?.({
      serverContent: {
        outputTranscription: { text: "無障礙設施查詢也可以。" },
      },
    });
    onmessage?.({ serverContent: { turnComplete: true } });

    await vi.waitFor(() =>
      expect(
        (ws.send as unknown as { mock: { calls: string[][] } }).mock.calls.some(
          (call) => JSON.parse(call[0]).final === true,
        ),
      ).toBe(true),
    );
    const frames = (
      ws.send as unknown as { mock: { calls: string[][] } }
    ).mock.calls.map((call) => JSON.parse(call[0]));
    const finalIndex = frames.findIndex((f) => f.final === true);
    const firstModelIndex = frames.findIndex((f) => f.role === "model");
    expect(finalIndex).toBeGreaterThanOrEqual(0);
    expect(firstModelIndex).toBeGreaterThanOrEqual(0);
    expect(finalIndex).toBeLessThan(firstModelIndex);
  });
});

describe("createLiveBridge Live config", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.GEMINI_LIVE_TEMPERATURE;
    delete process.env.GEMINI_LIVE_LANGUAGE_CODE;
    connect.mockResolvedValue(makeSession());
  });

  it("defaults temperature to 0 (aligned with the text agent)", async () => {
    await createLiveBridge({ ws: makeWs(), userId: "u" });
    expect(connect.mock.calls[0][0].config.temperature).toBe(0);
  });

  it("uses a valid GEMINI_LIVE_TEMPERATURE and falls back for an invalid one", async () => {
    process.env.GEMINI_LIVE_TEMPERATURE = "0.4";
    await createLiveBridge({ ws: makeWs(), userId: "u" });
    expect(connect.mock.calls[0][0].config.temperature).toBe(0.4);

    connect.mockClear();
    process.env.GEMINI_LIVE_TEMPERATURE = "abc";
    await createLiveBridge({ ws: makeWs(), userId: "u" });
    expect(connect.mock.calls[0][0].config.temperature).toBe(0);
  });

  it("adds speechConfig only for a validly-formatted language code", async () => {
    process.env.GEMINI_LIVE_LANGUAGE_CODE = "cmn-TW";
    await createLiveBridge({ ws: makeWs(), userId: "u" });
    expect(connect.mock.calls[0][0].config.speechConfig).toEqual({
      languageCode: "cmn-TW",
    });
  });

  it("omits speechConfig when the language code is unset or malformed", async () => {
    await createLiveBridge({ ws: makeWs(), userId: "u" });
    expect(connect.mock.calls[0][0].config.speechConfig).toBeUndefined();

    connect.mockClear();
    process.env.GEMINI_LIVE_LANGUAGE_CODE = "zh_TW";
    await createLiveBridge({ ws: makeWs(), userId: "u" });
    expect(connect.mock.calls[0][0].config.speechConfig).toBeUndefined();
  });

  it("adds navigation functions only to the Live tool config", async () => {
    await createLiveBridge({ ws: makeWs(), userId: "u" });
    const declarations =
      connect.mock.calls[0][0].config.tools.at(-1).functionDeclarations;
    expect(declarations.map((item: any) => item.name)).toEqual([
      "startNavigation",
      "stopNavigation",
      "repeatNavStep",
      "getActiveNavigationContext",
    ]);
  });
});

describe("createLiveBridge navigation turn arbiter", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getRouteByToken.mockResolvedValue(walkRoute);
    getNavigationEnvelopeByToken.mockResolvedValue(null);
  });

  it("emits one ordered backend reroute episode and atomically replaces the active session", async () => {
    vi.useFakeTimers();
    try {
      let onmessage: ((message: unknown) => void) | undefined;
      const session = makeSession();
      const ws = makeWs();
      connect.mockImplementation(async ({ callbacks }) => {
        onmessage = callbacks.onmessage;
        return session;
      });
      getNavigationEnvelopeByToken.mockResolvedValue({
        navigationId: "11111111-1111-4111-8111-111111111111",
        routeVersion: 1,
      });
      const pendingReroute = deferred<any>();
      rerouteAccessibleRoute.mockReturnValue(pendingReroute.promise);
      const rerouteResult = {
        ok: true,
        data: {
          navigationId: "11111111-1111-4111-8111-111111111111",
          previousRouteVersion: 1,
          routeVersion: 2,
          routeToken: "replacement",
          route: walkRoute,
          instructions: [],
          steps: [],
          warnings: [],
          currentStepIndex: 0,
          replayed: false,
        },
      };
      const bridge = await createLiveBridge({
        ws,
        userId: "u",
        userLocation: { latitude: 25, longitude: 121 },
      });
      await bridge.armRouteToken("initial");
      onmessage?.({
        toolCall: {
          functionCalls: [{ id: "nav", name: "startNavigation", args: {} }],
        },
      });
      await vi.advanceTimersByTimeAsync(0);
      const far = { latitude: 26, longitude: 122 };
      for (let i = 0; i < 3; i++) {
        bridge.updatePosition(far);
        await vi.advanceTimersByTimeAsync(500);
      }
      expect(rerouteAccessibleRoute).toHaveBeenCalledOnce();
      pendingReroute.resolve(rerouteResult);
      await vi.advanceTimersByTimeAsync(0);

      const messages = vi
        .mocked(ws.send)
        .mock.calls.map(([value]) => value)
        .filter((value): value is string => typeof value === "string")
        .map((value) => JSON.parse(value));
      const types = messages.map((message) => message.type);
      expect(types.filter((type) => type === "nav.rerouting")).toHaveLength(1);
      expect(types.indexOf("nav.offroute")).toBeLessThan(
        types.indexOf("nav.rerouting"),
      );
      expect(types.indexOf("nav.rerouting")).toBeLessThan(
        types.indexOf("nav.route_replaced"),
      );
      const rerouting = messages.find(
        (message) => message.type === "nav.rerouting",
      );
      expect(rerouting).toEqual({
        type: "nav.rerouting",
        navigationId: "11111111-1111-4111-8111-111111111111",
        previousRouteVersion: 1,
        clientRequestId: expect.stringMatching(
          /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
        ),
      });
      const routeReplaced = messages.find(
        (message) => message.type === "nav.route_replaced",
      );
      const initialStart = messages.find(
        (message) => message.type === "nav.start",
      );
      expect(routeReplaced).toEqual({
        type: "nav.route_replaced",
        navigationId: "11111111-1111-4111-8111-111111111111",
        previousRouteVersion: 1,
        routeToken: "replacement",
        routeVersion: 2,
        route: walkRoute,
        steps: initialStart.steps,
        warnings: [],
        currentStepIndex: 0,
      });
      expect(rerouteAccessibleRoute).toHaveBeenCalledWith({
        routeToken: "initial",
        currentPosition: far,
        previousRouteVersion: 1,
        reason: "OFF_ROUTE",
        clientRequestId: rerouting.clientRequestId,
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("discards an in-flight reroute result after navigation is cancelled", async () => {
    vi.useFakeTimers();
    try {
      let onmessage: ((message: unknown) => void) | undefined;
      const session = makeSession();
      const ws = makeWs();
      connect.mockImplementation(async ({ callbacks }) => {
        onmessage = callbacks.onmessage;
        return session;
      });
      getNavigationEnvelopeByToken.mockResolvedValue({
        navigationId: "11111111-1111-4111-8111-111111111111",
        routeVersion: 1,
      });
      const pendingReroute = deferred<any>();
      rerouteAccessibleRoute.mockReturnValue(pendingReroute.promise);
      const bridge = await createLiveBridge({ ws, userId: "u" });
      await bridge.armRouteToken("initial");
      onmessage?.({
        toolCall: {
          functionCalls: [{ id: "start", name: "startNavigation", args: {} }],
        },
      });
      await vi.advanceTimersByTimeAsync(0);
      const far = { latitude: 26, longitude: 122 };
      for (let i = 0; i < 3; i++) {
        bridge.updatePosition(far);
        await vi.advanceTimersByTimeAsync(500);
      }
      expect(rerouteAccessibleRoute).toHaveBeenCalledOnce();

      bridge.cancelNav();
      pendingReroute.resolve({
        ok: true,
        data: {
          navigationId: "11111111-1111-4111-8111-111111111111",
          previousRouteVersion: 1,
          routeVersion: 2,
          routeToken: "stale-replacement",
          route: walkRoute,
          instructions: [],
          steps: [],
          warnings: [],
          currentStepIndex: 0,
          replayed: false,
        },
      });
      await vi.advanceTimersByTimeAsync(0);

      const types = vi
        .mocked(ws.send)
        .mock.calls.map(([value]) => value)
        .filter((value): value is string => typeof value === "string")
        .map((value) => JSON.parse(value).type);
      expect(types).toContain("nav.stop");
      expect(types).not.toContain("nav.route_replaced");
      expect(types).not.toContain("nav.reroute_failed");
    } finally {
      vi.useRealTimers();
    }
  });

  it("lets an old reroute commit while a newer lookup is pending, then lets the latest setRoute win", async () => {
    vi.useFakeTimers();
    try {
      let onmessage: ((message: unknown) => void) | undefined;
      const session = makeSession();
      const ws = makeWs();
      connect.mockImplementation(async ({ callbacks }) => {
        onmessage = callbacks.onmessage;
        return session;
      });
      const newerRoute = structuredClone(walkRoute);
      newerRoute.legs[0].steps[0].streetName = "新路線";
      const pendingNewRoute = deferred<typeof newerRoute>();
      getRouteByToken.mockImplementation((token) =>
        token === "newer"
          ? pendingNewRoute.promise
          : Promise.resolve(walkRoute),
      );
      getNavigationEnvelopeByToken.mockImplementation(async (token) => ({
        navigationId:
          token === "newer"
            ? "22222222-2222-4222-8222-222222222222"
            : "11111111-1111-4111-8111-111111111111",
        routeVersion: 1,
      }));
      const pendingReroute = deferred<any>();
      rerouteAccessibleRoute.mockReturnValue(pendingReroute.promise);
      const bridge = await createLiveBridge({ ws, userId: "u" });
      await bridge.armRouteToken("initial");
      onmessage?.({
        toolCall: {
          functionCalls: [
            { id: "start-old", name: "startNavigation", args: {} },
          ],
        },
      });
      await vi.advanceTimersByTimeAsync(0);
      const far = { latitude: 26, longitude: 122 };
      for (let i = 0; i < 3; i++) {
        bridge.updatePosition(far);
        await vi.advanceTimersByTimeAsync(500);
      }
      expect(rerouteAccessibleRoute).toHaveBeenCalledOnce();

      const pendingNewArm = bridge.armRouteToken("newer");
      pendingReroute.resolve({
        ok: true,
        data: {
          navigationId: "11111111-1111-4111-8111-111111111111",
          previousRouteVersion: 1,
          routeVersion: 2,
          routeToken: "old-reroute",
          route: walkRoute,
          instructions: [],
          steps: [],
          warnings: [],
          currentStepIndex: 0,
          replayed: false,
        },
      });
      await vi.advanceTimersByTimeAsync(0);
      let messages = vi
        .mocked(ws.send)
        .mock.calls.map(([value]) => value)
        .filter((value): value is string => typeof value === "string")
        .map((value) => JSON.parse(value));
      expect(
        messages.filter((message) => message.type === "nav.route_replaced"),
      ).toHaveLength(1);
      expect(
        messages.find((message) => message.type === "nav.route_replaced"),
      ).toMatchObject({ routeToken: "old-reroute", routeVersion: 2 });

      pendingNewRoute.resolve(newerRoute);
      await pendingNewArm;
      onmessage?.({
        toolCall: {
          functionCalls: [{ id: "stop-old", name: "stopNavigation", args: {} }],
        },
      });
      await vi.advanceTimersByTimeAsync(0);
      onmessage?.({
        toolCall: {
          functionCalls: [
            { id: "start-new", name: "startNavigation", args: {} },
          ],
        },
      });
      await vi.advanceTimersByTimeAsync(0);

      messages = vi
        .mocked(ws.send)
        .mock.calls.map(([value]) => value)
        .filter((value): value is string => typeof value === "string")
        .map((value) => JSON.parse(value));
      expect(
        messages.some((message) => message.type === "nav.reroute_failed"),
      ).toBe(false);
      const starts = messages.filter((message) => message.type === "nav.start");
      expect(starts.at(-1).steps[0].instruction).toContain("新路線");
    } finally {
      vi.useRealTimers();
    }
  });

  it("discards an old reroute when the newer setRoute commits first", async () => {
    vi.useFakeTimers();
    try {
      let onmessage: ((message: unknown) => void) | undefined;
      const session = makeSession();
      const ws = makeWs();
      connect.mockImplementation(async ({ callbacks }) => {
        onmessage = callbacks.onmessage;
        return session;
      });
      const newerRoute = structuredClone(walkRoute);
      newerRoute.legs[0].steps[0].streetName = "新路線";
      const pendingNewRoute = deferred<typeof newerRoute>();
      getRouteByToken.mockImplementation((token) =>
        token === "newer"
          ? pendingNewRoute.promise
          : Promise.resolve(walkRoute),
      );
      getNavigationEnvelopeByToken.mockImplementation(async (token) => ({
        navigationId:
          token === "newer"
            ? "22222222-2222-4222-8222-222222222222"
            : "11111111-1111-4111-8111-111111111111",
        routeVersion: 1,
      }));
      const pendingReroute = deferred<any>();
      rerouteAccessibleRoute.mockReturnValue(pendingReroute.promise);
      const bridge = await createLiveBridge({ ws, userId: "u" });
      await bridge.armRouteToken("initial");
      onmessage?.({
        toolCall: {
          functionCalls: [
            { id: "start-old", name: "startNavigation", args: {} },
          ],
        },
      });
      await vi.advanceTimersByTimeAsync(0);

      const far = { latitude: 26, longitude: 122 };
      for (let i = 0; i < 3; i++) {
        bridge.updatePosition(far);
        await vi.advanceTimersByTimeAsync(500);
      }
      expect(rerouteAccessibleRoute).toHaveBeenCalledOnce();

      const pendingNewArm = bridge.armRouteToken("newer");
      pendingNewRoute.resolve(newerRoute);
      await pendingNewArm;
      pendingReroute.resolve({
        ok: true,
        data: {
          navigationId: "11111111-1111-4111-8111-111111111111",
          previousRouteVersion: 1,
          routeVersion: 2,
          routeToken: "stale-reroute",
          route: walkRoute,
          instructions: [],
          steps: [],
          warnings: [],
          currentStepIndex: 0,
          replayed: false,
        },
      });
      await vi.advanceTimersByTimeAsync(0);

      onmessage?.({
        toolCall: {
          functionCalls: [{ id: "stop-old", name: "stopNavigation", args: {} }],
        },
      });
      await vi.advanceTimersByTimeAsync(0);
      onmessage?.({
        toolCall: {
          functionCalls: [
            { id: "start-new", name: "startNavigation", args: {} },
          ],
        },
      });
      await vi.advanceTimersByTimeAsync(0);

      const messages = vi
        .mocked(ws.send)
        .mock.calls.map(([value]) => value)
        .filter((value): value is string => typeof value === "string")
        .map((value) => JSON.parse(value));
      expect(
        messages.some((message) => message.type === "nav.route_replaced"),
      ).toBe(false);
      expect(
        messages.some((message) => message.type === "nav.reroute_failed"),
      ).toBe(false);
      const starts = messages.filter((message) => message.type === "nav.start");
      expect(starts.at(-1).steps[0].instruction).toContain("新路線");
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps the old offroute reroute active when the pending setRoute lookup fails", async () => {
    vi.useFakeTimers();
    try {
      let onmessage: ((message: unknown) => void) | undefined;
      const session = makeSession();
      const ws = makeWs();
      connect.mockImplementation(async ({ callbacks }) => {
        onmessage = callbacks.onmessage;
        return session;
      });
      const pendingNewRoute = deferred<typeof walkRoute | null>();
      getRouteByToken.mockImplementation((token) =>
        token === "newer"
          ? pendingNewRoute.promise
          : Promise.resolve(walkRoute),
      );
      getNavigationEnvelopeByToken.mockResolvedValue({
        navigationId: "11111111-1111-4111-8111-111111111111",
        routeVersion: 1,
      });
      const pendingReroute = deferred<any>();
      rerouteAccessibleRoute.mockReturnValue(pendingReroute.promise);
      const bridge = await createLiveBridge({ ws, userId: "u" });
      await bridge.armRouteToken("initial");
      onmessage?.({
        toolCall: {
          functionCalls: [
            { id: "start-old", name: "startNavigation", args: {} },
          ],
        },
      });
      await vi.advanceTimersByTimeAsync(0);

      const pendingNewArm = bridge.armRouteToken("newer");
      const far = { latitude: 26, longitude: 122 };
      for (let i = 0; i < 3; i++) {
        bridge.updatePosition(far);
        await vi.advanceTimersByTimeAsync(500);
      }
      expect(rerouteAccessibleRoute).toHaveBeenCalledOnce();
      expect(rerouteAccessibleRoute).toHaveBeenCalledWith({
        routeToken: "initial",
        currentPosition: far,
        previousRouteVersion: 1,
        reason: "OFF_ROUTE",
        clientRequestId: expect.any(String),
      });

      pendingNewRoute.resolve(null);
      await pendingNewArm;
      expect(rerouteAccessibleRoute).toHaveBeenCalledOnce();
      pendingReroute.resolve({
        ok: true,
        data: {
          navigationId: "11111111-1111-4111-8111-111111111111",
          previousRouteVersion: 1,
          routeVersion: 2,
          routeToken: "replacement",
          route: walkRoute,
          instructions: [],
          steps: [],
          warnings: [],
          currentStepIndex: 0,
          replayed: false,
        },
      });
      await vi.advanceTimersByTimeAsync(0);

      const types = vi
        .mocked(ws.send)
        .mock.calls.map(([value]) => value)
        .filter((value): value is string => typeof value === "string")
        .map((value) => JSON.parse(value).type);
      expect(types.filter((type) => type === "nav.rerouting")).toHaveLength(1);
      expect(
        types.filter((type) => type === "nav.route_replaced"),
      ).toHaveLength(1);
      expect(types.filter((type) => type === "nav.error")).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not let a superseded pending lookup commit", async () => {
    vi.useFakeTimers();
    try {
      let onmessage: ((message: unknown) => void) | undefined;
      connect.mockImplementation(async ({ callbacks }) => {
        onmessage = callbacks.onmessage;
        return makeSession();
      });
      const firstRoute = structuredClone(walkRoute);
      firstRoute.legs[0].steps[0].streetName = "被取代的路線";
      const secondRoute = structuredClone(walkRoute);
      secondRoute.legs[0].steps[0].streetName = "最新路線";
      const firstPending = deferred<typeof firstRoute>();
      const secondPending = deferred<typeof secondRoute>();
      getRouteByToken.mockImplementation((token) => {
        if (token === "first-pending") return firstPending.promise;
        if (token === "second-pending") return secondPending.promise;
        return Promise.resolve(null);
      });
      getNavigationEnvelopeByToken.mockResolvedValue(null);
      const ws = makeWs();
      const bridge = await createLiveBridge({ ws, userId: "u" });

      const firstArm = bridge.armRouteToken("first-pending");
      const secondArm = bridge.armRouteToken("second-pending");
      firstPending.resolve(firstRoute);
      await firstArm;
      secondPending.resolve(secondRoute);
      await secondArm;
      onmessage?.({
        toolCall: {
          functionCalls: [{ id: "start", name: "startNavigation", args: {} }],
        },
      });
      await vi.advanceTimersByTimeAsync(0);

      const starts = vi
        .mocked(ws.send)
        .mock.calls.map(([value]) => value)
        .filter((value): value is string => typeof value === "string")
        .map((value) => JSON.parse(value))
        .filter((message) => message.type === "nav.start");
      expect(starts).toHaveLength(1);
      expect(starts[0].steps[0].instruction).toContain("最新路線");
      expect(starts[0].steps[0].instruction).not.toContain("被取代的路線");
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not resurrect a pending lookup after cancellation", async () => {
    vi.useFakeTimers();
    try {
      let onmessage: ((message: unknown) => void) | undefined;
      connect.mockImplementation(async ({ callbacks }) => {
        onmessage = callbacks.onmessage;
        return makeSession();
      });
      const pendingRouteValue = structuredClone(walkRoute);
      pendingRouteValue.legs[0].steps[0].streetName = "不應復活的路線";
      const pendingRoute = deferred<typeof pendingRouteValue>();
      getRouteByToken.mockImplementation((token) =>
        token === "pending" ? pendingRoute.promise : Promise.resolve(walkRoute),
      );
      getNavigationEnvelopeByToken.mockResolvedValue({
        navigationId: "11111111-1111-4111-8111-111111111111",
        routeVersion: 1,
      });
      const ws = makeWs();
      const bridge = await createLiveBridge({ ws, userId: "u" });
      await bridge.armRouteToken("initial");
      onmessage?.({
        toolCall: {
          functionCalls: [{ id: "start", name: "startNavigation", args: {} }],
        },
      });
      await vi.advanceTimersByTimeAsync(0);

      const pendingArm = bridge.armRouteToken("pending");
      bridge.cancelNav();
      pendingRoute.resolve(pendingRouteValue);
      await pendingArm;
      onmessage?.({
        toolCall: {
          functionCalls: [
            { id: "restart-old", name: "startNavigation", args: {} },
          ],
        },
      });
      await vi.advanceTimersByTimeAsync(0);

      const starts = vi
        .mocked(ws.send)
        .mock.calls.map(([value]) => value)
        .filter((value): value is string => typeof value === "string")
        .map((value) => JSON.parse(value))
        .filter((message) => message.type === "nav.start");
      expect(starts).toHaveLength(2);
      expect(starts.at(-1).steps[0].instruction).toBe(
        starts[0].steps[0].instruction,
      );
      expect(starts.at(-1).steps[0].instruction).not.toContain(
        "不應復活的路線",
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("emits reroute_failed and retains the old active session", async () => {
    vi.useFakeTimers();
    try {
      let onmessage: ((message: unknown) => void) | undefined;
      const session = makeSession();
      const ws = makeWs();
      connect.mockImplementation(async ({ callbacks }) => {
        onmessage = callbacks.onmessage;
        return session;
      });
      getNavigationEnvelopeByToken.mockResolvedValue({
        navigationId: "11111111-1111-4111-8111-111111111111",
        routeVersion: 1,
      });
      rerouteAccessibleRoute.mockResolvedValue({
        ok: false,
        status: 503,
        error: "Redis unavailable",
      });
      const bridge = await createLiveBridge({ ws, userId: "u" });
      await bridge.armRouteToken("initial");
      onmessage?.({
        toolCall: {
          functionCalls: [{ id: "start", name: "startNavigation", args: {} }],
        },
      });
      await vi.advanceTimersByTimeAsync(0);
      const far = { latitude: 26, longitude: 122 };
      for (let i = 0; i < 3; i++) {
        bridge.updatePosition(far);
        await vi.advanceTimersByTimeAsync(500);
      }
      await vi.advanceTimersByTimeAsync(0);
      onmessage?.({
        toolCall: {
          functionCalls: [
            { id: "context", name: "getActiveNavigationContext", args: {} },
          ],
        },
      });
      await vi.advanceTimersByTimeAsync(0);

      const messages = vi
        .mocked(ws.send)
        .mock.calls.map(([value]) => value)
        .filter((value): value is string => typeof value === "string")
        .map((value) => JSON.parse(value));
      const rerouting = messages.find(
        (message) => message.type === "nav.rerouting",
      );
      expect(
        messages.find((message) => message.type === "nav.reroute_failed"),
      ).toEqual({
        type: "nav.reroute_failed",
        navigationId: "11111111-1111-4111-8111-111111111111",
        previousRouteVersion: 1,
        code: 503,
        message: "Redis unavailable",
        retryable: true,
      });
      expect(rerouteAccessibleRoute).toHaveBeenCalledWith({
        routeToken: "initial",
        currentPosition: far,
        previousRouteVersion: 1,
        reason: "OFF_ROUTE",
        clientRequestId: rerouting.clientRequestId,
      });
      const contextResponse = session.sendToolResponse.mock.calls
        .flatMap(([payload]) => payload.functionResponses)
        .find((response: any) => response.id === "context");
      expect(JSON.parse(contextResponse.response.output)).toMatchObject({
        active: true,
        destination: "B",
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("sends a navigation tool response before the queued verbatim speech turn", async () => {
    let onmessage: ((message: unknown) => void) | undefined;
    const session = makeSession();
    connect.mockImplementation(async ({ callbacks }) => {
      onmessage = callbacks.onmessage;
      return session;
    });
    const bridge = await createLiveBridge({
      ws: makeWs(),
      userId: "u",
      userLocation: { latitude: 25, longitude: 121 },
    });
    await bridge.armRouteToken("cap");
    onmessage?.({
      toolCall: {
        functionCalls: [{ id: "nav-1", name: "startNavigation", args: {} }],
      },
    });
    await vi.waitFor(() =>
      expect(session.sendToolResponse).toHaveBeenCalledOnce(),
    );
    expect(session.sendClientContent).not.toHaveBeenCalled();
    onmessage?.({ serverContent: { turnComplete: true } });
    await vi.waitFor(() =>
      expect(session.sendClientContent).toHaveBeenCalledOnce(),
    );
    expect(session.sendToolResponse.mock.invocationCallOrder[0]).toBeLessThan(
      session.sendClientContent.mock.invocationCallOrder[0],
    );
    expect(session.sendClientContent.mock.calls[0][0].turns).toContain(
      "請逐字唸出以下導航指引",
    );
  });

  it("waits for a real idle boundary while ordinary model output is active", async () => {
    let onmessage: ((message: unknown) => void) | undefined;
    const session = makeSession();
    connect.mockImplementation(async ({ callbacks }) => {
      onmessage = callbacks.onmessage;
      return session;
    });
    const bridge = await createLiveBridge({ ws: makeWs(), userId: "u" });
    await bridge.armRouteToken("cap");
    onmessage?.({
      serverContent: { modelTurn: { parts: [{ text: "一般回覆" }] } },
    });
    bridge.updatePosition({ latitude: 25, longitude: 121 });
    onmessage?.({
      toolCall: {
        functionCalls: [{ id: "nav", name: "startNavigation", args: {} }],
      },
    });
    await vi.waitFor(() =>
      expect(session.sendToolResponse).toHaveBeenCalledOnce(),
    );
    expect(session.sendClientContent).not.toHaveBeenCalled();
    onmessage?.({ serverContent: { turnComplete: true } });
    await vi.waitFor(() =>
      expect(session.sendClientContent).toHaveBeenCalledOnce(),
    );
  });

  it("prioritizes interrupted over turnComplete and replays the whole sentence only at a later idle boundary", async () => {
    let onmessage: ((message: unknown) => void) | undefined;
    const session = makeSession();
    connect.mockImplementation(async ({ callbacks }) => {
      onmessage = callbacks.onmessage;
      return session;
    });
    const bridge = await createLiveBridge({
      ws: makeWs(),
      userId: "u",
      userLocation: { latitude: 25, longitude: 121 },
    });
    await bridge.armRouteToken("cap");
    onmessage?.({
      toolCall: {
        functionCalls: [{ id: "nav", name: "startNavigation", args: {} }],
      },
    });
    await vi.waitFor(() =>
      expect(session.sendToolResponse).toHaveBeenCalledOnce(),
    );
    onmessage?.({ serverContent: { turnComplete: true } });
    await vi.waitFor(() =>
      expect(session.sendClientContent).toHaveBeenCalledOnce(),
    );
    onmessage?.({ serverContent: { interrupted: true, turnComplete: true } });
    await Promise.resolve();
    expect(session.sendClientContent).toHaveBeenCalledOnce();
    onmessage?.({ serverContent: { turnComplete: true } });
    await vi.waitFor(() =>
      expect(session.sendClientContent).toHaveBeenCalledTimes(2),
    );
    expect(session.sendClientContent.mock.calls[1][0].turns).toBe(
      session.sendClientContent.mock.calls[0][0].turns,
    );
  });

  it("does not overlap turns on timeout and closes after consecutive timeout strikes", async () => {
    vi.useFakeTimers();
    try {
      let onmessage: ((message: unknown) => void) | undefined;
      const session = makeSession();
      const ws = makeWs();
      connect.mockImplementation(async ({ callbacks }) => {
        onmessage = callbacks.onmessage;
        return session;
      });
      const bridge = await createLiveBridge({
        ws,
        userId: "u",
        userLocation: { latitude: 25, longitude: 121 },
      });
      await bridge.armRouteToken("cap");
      onmessage?.({
        toolCall: {
          functionCalls: [{ id: "nav", name: "startNavigation", args: {} }],
        },
      });
      await vi.advanceTimersByTimeAsync(0);
      onmessage?.({ serverContent: { turnComplete: true } });
      await vi.advanceTimersByTimeAsync(0);
      expect(session.sendClientContent).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(30_000);
      expect(session.sendClientContent).toHaveBeenCalledOnce();
      expect(ws.close).toHaveBeenCalledWith(4410, "live-turn-timeout");
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps queued navigation speech behind every toolCall already enqueued", async () => {
    let onmessage: ((message: unknown) => void) | undefined;
    const session = makeSession();
    connect.mockImplementation(async ({ callbacks }) => {
      onmessage = callbacks.onmessage;
      return session;
    });
    let resolveFirst!: (value: string) => void;
    let resolveSecond!: (value: string) => void;
    const first = new Promise<string>((resolve) => {
      resolveFirst = resolve;
    });
    const second = new Promise<string>((resolve) => {
      resolveSecond = resolve;
    });
    vi.mocked(executeLocalTool).mockImplementation((name) =>
      name === "slowFirst" ? first : second,
    );

    const bridge = await createLiveBridge({
      ws: makeWs(),
      userId: "u",
      userLocation: { latitude: 25, longitude: 121 },
    });
    await bridge.armRouteToken("cap");
    onmessage?.({
      toolCall: {
        functionCalls: [{ id: "nav", name: "startNavigation", args: {} }],
      },
    });
    await vi.waitFor(() =>
      expect(session.sendToolResponse).toHaveBeenCalledOnce(),
    );

    onmessage?.({
      toolCall: { functionCalls: [{ id: "a", name: "slowFirst", args: {} }] },
    });
    onmessage?.({ serverContent: { turnComplete: true } });
    onmessage?.({
      toolCall: { functionCalls: [{ id: "b", name: "slowSecond", args: {} }] },
    });
    resolveFirst(JSON.stringify({ ok: true }));
    await vi.waitFor(() =>
      expect(executeLocalTool).toHaveBeenCalledWith(
        "slowSecond",
        {},
        { latitude: 25, longitude: 121 },
        "u",
        { allowMemoryWrite: false },
      ),
    );
    expect(session.sendClientContent).not.toHaveBeenCalled();

    resolveSecond(JSON.stringify({ ok: true }));
    await vi.waitFor(() =>
      expect(session.sendToolResponse).toHaveBeenCalledTimes(3),
    );
    expect(session.sendClientContent).not.toHaveBeenCalled();
    onmessage?.({ serverContent: { turnComplete: true } });
    await vi.waitFor(() =>
      expect(session.sendClientContent).toHaveBeenCalledOnce(),
    );
  });

  it("keeps only the latest asynchronously resolved route token", async () => {
    let onmessage: ((message: unknown) => void) | undefined;
    const session = makeSession();
    const ws = makeWs();
    connect.mockImplementation(async ({ callbacks }) => {
      onmessage = callbacks.onmessage;
      return session;
    });
    let resolveOld!: (value: typeof walkRoute) => void;
    let resolveNew!: (value: typeof walkRoute) => void;
    const oldLookup = new Promise<typeof walkRoute>((resolve) => {
      resolveOld = resolve;
    });
    const newLookup = new Promise<typeof walkRoute>((resolve) => {
      resolveNew = resolve;
    });
    getRouteByToken.mockImplementation((token) =>
      token === "old" ? oldLookup : newLookup,
    );
    const oldRoute = structuredClone(walkRoute);
    oldRoute.legs[0].steps[0].streetName = "舊路線";
    const newRoute = structuredClone(walkRoute);
    newRoute.legs[0].steps[0].streetName = "新路線";

    const bridge = await createLiveBridge({ ws, userId: "u" });
    const oldArm = bridge.armRouteToken("old");
    const newArm = bridge.armRouteToken("new");
    resolveNew(newRoute);
    await newArm;
    resolveOld(oldRoute);
    await oldArm;
    onmessage?.({
      toolCall: {
        functionCalls: [{ id: "nav", name: "startNavigation", args: {} }],
      },
    });
    await vi.waitFor(() =>
      expect(session.sendToolResponse).toHaveBeenCalledOnce(),
    );

    const messages = vi
      .mocked(ws.send)
      .mock.calls.map(([value]) => value)
      .filter((value): value is string => typeof value === "string")
      .map((value) => JSON.parse(value));
    const startMessage = messages.find(
      (message) => message.type === "nav.start",
    );
    expect(startMessage.steps[0].instruction).toContain("新路線");
    expect(startMessage.steps[0].instruction).not.toContain("舊路線");
  });

  it("processes the latest position on the trailing edge without a third update", async () => {
    vi.useFakeTimers();
    try {
      let onmessage: ((message: unknown) => void) | undefined;
      const session = makeSession();
      const ws = makeWs();
      connect.mockImplementation(async ({ callbacks }) => {
        onmessage = callbacks.onmessage;
        return session;
      });
      const bridge = await createLiveBridge({ ws, userId: "u" });
      await bridge.armRouteToken("cap");
      onmessage?.({
        toolCall: {
          functionCalls: [{ id: "nav", name: "startNavigation", args: {} }],
        },
      });
      await vi.advanceTimersByTimeAsync(0);
      onmessage?.({ serverContent: { turnComplete: true } });
      await vi.advanceTimersByTimeAsync(0);

      bridge.updatePosition({ latitude: start[1], longitude: start[0] });
      onmessage?.({ serverContent: { turnComplete: true } });
      await vi.advanceTimersByTimeAsync(0);
      bridge.updatePosition({ latitude: end[1], longitude: end[0] });
      await vi.advanceTimersByTimeAsync(500);

      const messages = vi
        .mocked(ws.send)
        .mock.calls.map(([value]) => value)
        .filter((value): value is string => typeof value === "string")
        .map((value) => JSON.parse(value));
      expect(messages.some((message) => message.type === "nav.arrived")).toBe(
        true,
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("returns active navigation context without sending it through the general tool executor", async () => {
    let onmessage: ((message: unknown) => void) | undefined;
    const session = makeSession();
    connect.mockImplementation(async ({ callbacks }) => {
      onmessage = callbacks.onmessage;
      return session;
    });
    const transitRoute = structuredClone(walkRoute);
    transitRoute.routeName = "bus route";
    transitRoute.legs = [
      walkRoute.legs[0],
      {
        type: "BUS",
        routeName: "307",
        departureStop: "甲站",
        arrivalStop: "乙站",
        waitInfo: { time: null, source: "unavailable" },
        estimatedWaitMinutes: 0,
        direction: 1,
        polyline: [end, [121.01, 25]],
        departureStopA11y: [],
        arrivalStopA11y: [],
      },
    ];
    getRouteByToken.mockResolvedValue(transitRoute);
    const bridge = await createLiveBridge({ ws: makeWs(), userId: "u" });
    await bridge.armRouteToken("cap");
    onmessage?.({
      toolCall: {
        functionCalls: [{ id: "start", name: "startNavigation", args: {} }],
      },
    });
    await vi.waitFor(() =>
      expect(session.sendToolResponse).toHaveBeenCalledOnce(),
    );
    onmessage?.({
      toolCall: {
        functionCalls: [
          { id: "context", name: "getActiveNavigationContext", args: {} },
        ],
      },
    });
    await vi.waitFor(() =>
      expect(session.sendToolResponse).toHaveBeenCalledTimes(2),
    );

    const output =
      session.sendToolResponse.mock.calls[1][0].functionResponses[0].response
        .output;
    expect(JSON.parse(output)).toMatchObject({
      active: true,
      destination: "乙站",
      transit: {
        relation: "upcoming",
        mode: "BUS",
        routeName: "307",
        from: "甲站",
        direction: 1,
      },
    });
    expect(executeLocalTool).not.toHaveBeenCalled();
  });

  it("passes the latest navigation position to ordinary realtime tools", async () => {
    let onmessage: ((message: unknown) => void) | undefined;
    const session = makeSession();
    connect.mockImplementation(async ({ callbacks }) => {
      onmessage = callbacks.onmessage;
      return session;
    });
    vi.mocked(executeLocalTool).mockResolvedValue(JSON.stringify({ ok: true }));
    const bridge = await createLiveBridge({
      ws: makeWs(),
      userId: "u",
      userLocation: { latitude: 25, longitude: 121 },
    });
    bridge.updatePosition({ latitude: 25.05, longitude: 121.55, accuracy: 8 });
    onmessage?.({
      toolCall: {
        functionCalls: [
          { id: "weather", name: "getEnvironmentInfo", args: {} },
        ],
      },
    });
    await vi.waitFor(() =>
      expect(executeLocalTool).toHaveBeenCalledWith(
        "getEnvironmentInfo",
        {},
        { latitude: 25.05, longitude: 121.55, accuracy: 8 },
        "u",
        { allowMemoryWrite: false },
      ),
    );
    await vi.waitFor(() =>
      expect(session.sendToolResponse).toHaveBeenCalledOnce(),
    );
  });
});

describe("createLiveBridge consecutive tool calls", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.GEMINI_LIVE_TEMPERATURE;
    delete process.env.GEMINI_LIVE_LANGUAGE_CODE;
  });

  it("returns each tool response to the same session across consecutive toolCalls without dropping or closing early", async () => {
    let onmessage: ((message: unknown) => Promise<void> | void) | undefined;
    const session = makeSession();
    connect.mockImplementation(async ({ callbacks }) => {
      onmessage = callbacks.onmessage;
      return session;
    });
    vi.mocked(executeLocalTool).mockResolvedValue(JSON.stringify({ ok: true }));

    await createLiveBridge({ ws: makeWs(), userId: "voice-user" });

    onmessage?.({
      toolCall: {
        functionCalls: [{ id: "c1", name: "findGooglePlaces", args: {} }],
      },
    });
    onmessage?.({
      toolCall: {
        functionCalls: [{ id: "c2", name: "planAccessibleRoute", args: {} }],
      },
    });

    // handleServerMessage is fire-and-forget from onmessage; wait for both
    // executions to finish resolving before asserting (deferred sync point).
    await vi.waitFor(() =>
      expect(session.sendToolResponse).toHaveBeenCalledTimes(2),
    );

    expect(session.sendToolResponse).toHaveBeenNthCalledWith(1, {
      functionResponses: [
        {
          id: "c1",
          name: "findGooglePlaces",
          response: { output: JSON.stringify({ ok: true }) },
        },
      ],
    });
    expect(session.sendToolResponse).toHaveBeenNthCalledWith(2, {
      functionResponses: [
        {
          id: "c2",
          name: "planAccessibleRoute",
          response: { output: JSON.stringify({ ok: true }) },
        },
      ],
    });
    expect(session.close).not.toHaveBeenCalled();
  });
});

describe("createLiveBridge tool_result payload", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.GEMINI_LIVE_TEMPERATURE;
    delete process.env.GEMINI_LIVE_LANGUAGE_CODE;
  });

  /**
   * Finds the last `tool_result` JSON message sent over the WebSocket. `ws.send`
   * also receives binary audio frames, so string args are filtered and parsed
   * first.
   *
   * @param ws The mocked WebSocket whose `send` calls are inspected.
   * @returns The parsed `tool_result` message, or undefined if none was sent.
   */
  function findToolResult(ws: WebSocket): Record<string, unknown> | undefined {
    const calls = (ws.send as unknown as { mock: { calls: unknown[][] } }).mock
      .calls;
    const messages = calls
      .map((c) => c[0])
      .filter((arg): arg is string => typeof arg === "string")
      .map((arg) => JSON.parse(arg) as Record<string, unknown>);
    return messages.filter((m) => m.type === "tool_result").at(-1);
  }

  it("forwards the parsed tool result and the call args on success", async () => {
    let onmessage: ((message: unknown) => Promise<void> | void) | undefined;
    connect.mockImplementation(async ({ callbacks }) => {
      onmessage = callbacks.onmessage;
      return makeSession();
    });
    const places = [{ id: "a11y_123", name: "台北車站無障礙電梯" }];
    vi.mocked(executeLocalTool).mockResolvedValue(JSON.stringify({ places }));
    const ws = makeWs();

    await createLiveBridge({ ws, userId: "voice-user" });
    const args = { latitude: 25.033, longitude: 121.5654, radius: 500 };
    onmessage?.({
      toolCall: { functionCalls: [{ id: "c1", name: "findA11yPlaces", args }] },
    });

    await vi.waitFor(() => expect(findToolResult(ws)).toBeDefined());
    const msg = findToolResult(ws)!;
    expect(msg.name).toBe("findA11yPlaces");
    expect(msg.ok).toBe(true);
    expect(typeof msg.durationMs).toBe("number");
    expect(msg.result).toEqual({ places });
    expect(msg.args).toEqual(args);
  });

  it("wraps a non-JSON tool return in { result } to match the SSE fallback", async () => {
    let onmessage: ((message: unknown) => Promise<void> | void) | undefined;
    connect.mockImplementation(async ({ callbacks }) => {
      onmessage = callbacks.onmessage;
      return makeSession();
    });
    vi.mocked(executeLocalTool).mockResolvedValue("plain string result");
    const ws = makeWs();

    await createLiveBridge({ ws, userId: "voice-user" });
    onmessage?.({
      toolCall: {
        functionCalls: [{ id: "c1", name: "findA11yPlaces", args: {} }],
      },
    });

    await vi.waitFor(() => expect(findToolResult(ws)).toBeDefined());
    expect(findToolResult(ws)!.result).toEqual({
      result: "plain string result",
    });
  });

  it("omits result but keeps args when the tool throws", async () => {
    let onmessage: ((message: unknown) => Promise<void> | void) | undefined;
    connect.mockImplementation(async ({ callbacks }) => {
      onmessage = callbacks.onmessage;
      return makeSession();
    });
    vi.mocked(executeLocalTool).mockRejectedValue(new Error("tool blew up"));
    const ws = makeWs();

    await createLiveBridge({ ws, userId: "voice-user" });
    const args = { latitude: 25.033, longitude: 121.5654 };
    onmessage?.({
      toolCall: { functionCalls: [{ id: "c1", name: "findA11yPlaces", args }] },
    });

    await vi.waitFor(() => expect(findToolResult(ws)).toBeDefined());
    const msg = findToolResult(ws)!;
    expect(msg.ok).toBe(false);
    expect("result" in msg).toBe(false);
    expect(msg.args).toEqual(args);
  });
});

describe("createLiveBridge user memory integration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.GEMINI_LIVE_TEMPERATURE;
    delete process.env.GEMINI_LIVE_LANGUAGE_CODE;
    connect.mockResolvedValue(makeSession());
  });

  it("loads user memories and enables memory tools when memoryEnabled is true", async () => {
    getMemorySettings.mockResolvedValue({ memoryEnabled: true });
    loadMemories.mockResolvedValue([
      {
        _id: "mem1",
        category: "preference",
        promptText: "偏好輪椅友善路線",
        content: "偏好輪椅友善路線",
      },
    ]);

    const ws = makeWs();
    await createLiveBridge({ ws, userId: "mem-user" });

    expect(getMemorySettings).toHaveBeenCalledWith("mem-user");
    expect(loadMemories).toHaveBeenCalledWith("mem-user", 20);
    expect(buildGeminiTools).toHaveBeenCalledWith("mem-user", true);

    const [config] = connect.mock.calls[0] as unknown as [
      { config: { systemInstruction: string } },
    ];
    expect(config.config.systemInstruction).toContain("【使用者記憶】");
    expect(config.config.systemInstruction).toContain("偏好輪椅友善路線");
    expect(config.config.systemInstruction).toContain("(id:mem1)");
  });

  it("disables memory tools and omits memory prompt when memoryEnabled is false", async () => {
    getMemorySettings.mockResolvedValue({ memoryEnabled: false });

    const ws = makeWs();
    await createLiveBridge({ ws, userId: "no-mem-user" });

    expect(getMemorySettings).toHaveBeenCalledWith("no-mem-user");
    expect(loadMemories).not.toHaveBeenCalled();
    expect(buildGeminiTools).toHaveBeenCalledWith("no-mem-user", false);

    const [config] = connect.mock.calls[0] as unknown as [
      { config: { systemInstruction: string } },
    ];
    expect(config.config.systemInstruction).not.toContain("【使用者記憶】");
  });

  it("passes allowMemoryWrite: true to executeLocalTool when memoryEnabled is true", async () => {
    getMemorySettings.mockResolvedValue({ memoryEnabled: true });
    loadMemories.mockResolvedValue([]);
    let onmessage: ((message: unknown) => Promise<void> | void) | undefined;
    const session = makeSession();
    connect.mockImplementation(async ({ callbacks }) => {
      onmessage = callbacks.onmessage;
      return session;
    });
    vi.mocked(executeLocalTool).mockResolvedValue(
      JSON.stringify({ ok: true, memory: { id: "m1", content: "記住了" } }),
    );

    const ws = makeWs();
    await createLiveBridge({ ws, userId: "mem-user" });

    onmessage?.({
      toolCall: {
        functionCalls: [
          {
            id: "call_save",
            name: "saveMemory",
            args: { content: "習慣搭乘307公車", category: "habit" },
          },
        ],
      },
    });

    await vi.waitFor(() =>
      expect(executeLocalTool).toHaveBeenCalledWith(
        "saveMemory",
        { content: "習慣搭乘307公車", category: "habit" },
        undefined,
        "mem-user",
        { allowMemoryWrite: true },
      ),
    );
  });
});

describe("createLiveBridge reroute generation ownership", () => {
  const NAV_OLD = "11111111-1111-4111-8111-111111111111";
  const NAV_NEW = "22222222-2222-4222-8222-222222222222";
  const FAR = { latitude: 26, longitude: 122 };
  const ON_ROUTE = { latitude: 25, longitude: 121 };

  beforeEach(() => {
    vi.clearAllMocks();
    getRouteByToken.mockResolvedValue(walkRoute);
    getNavigationEnvelopeByToken.mockResolvedValue(null);
  });

  function makeHarness() {
    let onmessage: ((message: unknown) => void) | undefined;
    const session = makeSession();
    const ws = makeWs();
    connect.mockImplementation(async ({ callbacks }) => {
      onmessage = callbacks.onmessage;
      return session;
    });
    const newerRoute = structuredClone(walkRoute);
    newerRoute.legs[0].steps[0].streetName = "新路線";
    getRouteByToken.mockImplementation(async (token: string) =>
      token === "newer" ? newerRoute : walkRoute,
    );
    getNavigationEnvelopeByToken.mockImplementation(async (token: string) => ({
      navigationId: token === "newer" ? NAV_NEW : NAV_OLD,
      routeVersion: 1,
    }));
    const call = async (id: string, name: string): Promise<void> => {
      onmessage?.({ toolCall: { functionCalls: [{ id, name, args: {} }] } });
      await vi.advanceTimersByTimeAsync(0);
    };
    return { ws, session, call };
  }

  type Bridge = Awaited<ReturnType<typeof createLiveBridge>>;

  async function drive(
    bridge: Bridge,
    position: { latitude: number; longitude: number },
    times: number,
  ): Promise<void> {
    for (let i = 0; i < times; i++) {
      bridge.updatePosition(position);
      await vi.advanceTimersByTimeAsync(500);
    }
  }

  function rerouteTokens(): string[] {
    return vi
      .mocked(rerouteAccessibleRoute)
      .mock.calls.map((call) => (call[0] as any).routeToken as string);
  }

  /**
   * Commits the client-selected replacement route as a brand new navigation
   * generation, mirroring the stop -> setRoute -> start sequence the gateway
   * drives when the user picks a different route mid-session.
   */
  async function commitNewerGeneration(
    bridge: Bridge,
    call: (id: string, name: string) => Promise<void>,
  ): Promise<void> {
    await call("stop-old", "stopNavigation");
    await bridge.armRouteToken("newer");
    await call("start-new", "startNavigation");
  }

  it("lets a newly committed generation reroute while the old generation's reroute is still pending", async () => {
    vi.useFakeTimers();
    try {
      const { ws, call } = makeHarness();
      const pendingOld = deferred<any>();
      const pendingNew = deferred<any>();
      rerouteAccessibleRoute.mockImplementation(({ routeToken }: any) =>
        routeToken === "newer" ? pendingNew.promise : pendingOld.promise,
      );
      const bridge = await createLiveBridge({ ws, userId: "u" });

      await bridge.armRouteToken("initial");
      await call("start-old", "startNavigation");
      await drive(bridge, FAR, 3);
      expect(rerouteTokens()).toEqual(["initial"]);

      await commitNewerGeneration(bridge, call);
      await drive(bridge, FAR, 3);

      expect(rerouteTokens()).toEqual(["initial", "newer"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not inherit the old generation's cooldown after a new setRoute commits", async () => {
    vi.useFakeTimers();
    try {
      const { ws, call } = makeHarness();
      rerouteAccessibleRoute.mockResolvedValue({
        ok: false,
        status: 404,
        error: "no route",
      });
      const bridge = await createLiveBridge({ ws, userId: "u" });

      await bridge.armRouteToken("initial");
      await call("start-old", "startNavigation");
      await drive(bridge, FAR, 3);
      expect(rerouteTokens()).toEqual(["initial"]);

      await vi.advanceTimersByTimeAsync(1_000);
      await commitNewerGeneration(bridge, call);
      await drive(bridge, FAR, 3);

      expect(rerouteTokens()).toEqual(["initial", "newer"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps the new generation's in-flight guard when the old generation's reroute settles late", async () => {
    vi.useFakeTimers();
    try {
      const { ws, call } = makeHarness();
      const pendingOld = deferred<any>();
      const pendingNew = deferred<any>();
      rerouteAccessibleRoute.mockImplementation(({ routeToken }: any) =>
        routeToken === "newer" ? pendingNew.promise : pendingOld.promise,
      );
      const bridge = await createLiveBridge({ ws, userId: "u" });

      await bridge.armRouteToken("initial");
      await call("start-old", "startNavigation");
      await drive(bridge, FAR, 3);

      await commitNewerGeneration(bridge, call);
      await drive(bridge, FAR, 3);
      expect(rerouteTokens()).toEqual(["initial", "newer"]);

      await vi.advanceTimersByTimeAsync(REROUTE_COOLDOWN_MS + 1_000);
      pendingOld.resolve({ ok: false, status: 404, error: "stale" });
      await vi.advanceTimersByTimeAsync(0);

      await drive(bridge, ON_ROUTE, 2);
      await drive(bridge, FAR, 3);

      expect(rerouteTokens()).toEqual(["initial", "newer"]);
      const messages = vi
        .mocked(ws.send)
        .mock.calls.map(([value]) => value)
        .filter((value): value is string => typeof value === "string")
        .map((value) => JSON.parse(value));
      expect(
        messages.some((message) => message.type === "nav.reroute_failed"),
      ).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("reuses the same clientRequestId when retrying reroute in the same generation", async () => {
    vi.useFakeTimers();
    try {
      const { ws, call } = makeHarness();
      rerouteAccessibleRoute.mockResolvedValue({
        ok: false,
        status: 503,
        error: "temporarily unavailable",
      });
      const bridge = await createLiveBridge({ ws, userId: "u" });

      await bridge.armRouteToken("initial");
      await call("start-old", "startNavigation");
      await drive(bridge, FAR, 3);
      expect(rerouteAccessibleRoute).toHaveBeenCalledTimes(1);
      const firstRequestId = (
        vi.mocked(rerouteAccessibleRoute).mock.calls[0]![0] as any
      ).clientRequestId;

      // Advance past cooldown and trigger another off-route attempt for the same generation
      await vi.advanceTimersByTimeAsync(REROUTE_COOLDOWN_MS + 1_000);
      await drive(bridge, ON_ROUTE, 2);
      await drive(bridge, FAR, 3);

      expect(rerouteAccessibleRoute).toHaveBeenCalledTimes(2);
      const secondRequestId = (
        vi.mocked(rerouteAccessibleRoute).mock.calls[1]![0] as any
      ).clientRequestId;

      expect(firstRequestId).toBeTruthy();
      expect(secondRequestId).toBe(firstRequestId);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not emit nav.route_replaced if navigation was cancelled/stopped while reroute was pending", async () => {
    vi.useFakeTimers();
    try {
      const { ws, call } = makeHarness();
      const pendingReroute = deferred<any>();
      rerouteAccessibleRoute.mockImplementation(() => pendingReroute.promise);
      const bridge = await createLiveBridge({ ws, userId: "u" });

      await bridge.armRouteToken("initial");
      await call("start-old", "startNavigation");
      await drive(bridge, FAR, 3);
      expect(rerouteAccessibleRoute).toHaveBeenCalledTimes(1);

      // Stop navigation before reroute settles
      await call("stop-old", "stopNavigation");

      // Now the pending reroute resolves with replacement route
      const replacementRoute = structuredClone(walkRoute);
      replacementRoute.routeVersion = 2;
      pendingReroute.resolve({
        ok: true,
        data: {
          route: replacementRoute,
          navigationId: NAV_OLD,
          routeVersion: 2,
          routeToken: "token-v2",
          steps: [],
        },
      });
      await vi.advanceTimersByTimeAsync(0);

      const messages = vi
        .mocked(ws.send)
        .mock.calls.map(([value]) => value)
        .filter((value): value is string => typeof value === "string")
        .map((value) => JSON.parse(value));

      expect(
        messages.some((message) => message.type === "nav.route_replaced"),
      ).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});
