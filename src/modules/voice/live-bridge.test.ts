import { beforeEach, describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";

const { connect, getRouteByToken, getMemorySettings, loadMemories } =
  vi.hoisted(() => ({
    connect: vi.fn(),
    getRouteByToken: vi.fn(),
    getMemorySettings: vi.fn().mockResolvedValue({ memoryEnabled: false }),
    loadMemories: vi.fn().mockResolvedValue([]),
  }));
vi.mock("../../config/ai", () => ({ googleGenAi: { live: { connect } } }));
vi.mock("../agent/tool-catalog", () => ({ buildGeminiTools: vi.fn(() => []) }));
vi.mock("../ai/agent-tools", () => ({ executeLocalTool: vi.fn() }));
vi.mock("../accessible-route/route-token.service", () => ({ getRouteByToken }));
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
