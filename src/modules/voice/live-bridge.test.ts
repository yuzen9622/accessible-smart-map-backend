import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import { InteractionStatus, StartSensitivity } from "@google/genai";
import type { WalkStep } from "../../types/route";
import type { AgentToolExecutor } from "../../types/agent";

const {
  connect,
  readNavigationTokenStrict,
  getAdoptedCandidateReplacement,
  switchNavigationCandidate,
  getRouteByToken,
  getNavigationEnvelopeByToken,
  rerouteAccessibleRoute,
  getMemorySettings,
  loadMemories,
  storeNavigationSnapshot,
  getNavigationSnapshot,
  deleteNavigationSnapshot,
  markNavigationStopped,
  beginNavigationResume,
  commitNavigationResume,
  releaseNavigationResume,
} = vi.hoisted(() => ({
  connect: vi.fn(),
  readNavigationTokenStrict: vi.fn(),
  getAdoptedCandidateReplacement: vi.fn(),
  switchNavigationCandidate: vi.fn(),
  getRouteByToken: vi.fn(),
  getNavigationEnvelopeByToken: vi.fn(),
  rerouteAccessibleRoute: vi.fn(),
  getMemorySettings: vi.fn().mockResolvedValue({ memoryEnabled: false }),
  loadMemories: vi.fn().mockResolvedValue([]),
  storeNavigationSnapshot: vi.fn(),
  getNavigationSnapshot: vi.fn(),
  deleteNavigationSnapshot: vi.fn(),
  markNavigationStopped: vi.fn().mockResolvedValue("stopped"),
  beginNavigationResume: vi.fn().mockResolvedValue("acquired"),
  commitNavigationResume: vi.fn().mockResolvedValue("committed"),
  releaseNavigationResume: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../../config/ai", () => ({ googleGenAi: { live: { connect } } }));
vi.mock("../agent/tool-catalog", () => ({ buildGeminiTools: vi.fn(() => []) }));
vi.mock("../ai/agent-tools", () => ({ executeLocalTool: vi.fn() }));
vi.mock("../accessible-route/route-token.service", () => ({
  getRouteByToken,
  getNavigationEnvelopeByToken,
  isNavigationEnvelope: (v: any) =>
    v?.schemaVersion === 1 &&
    typeof v.navigationId === "string" &&
    Number.isInteger(v.routeVersion) &&
    Boolean(v.route) &&
    Boolean(v.canonicalRequest),
}));
vi.mock("../accessible-route/reroute.service", () => ({
  rerouteAccessibleRoute,
}));
vi.mock("../accessible-route/candidate-route-switch.service", () => ({
  switchNavigationCandidate,
}));
vi.mock("../accessible-route/navigation-state.repository", () => ({
  readNavigationTokenStrict,
  getAdoptedCandidateReplacement,
  storeNavigationSnapshot,
  getNavigationSnapshot,
  deleteNavigationSnapshot,
  markNavigationStopped,
  beginNavigationResume,
  commitNavigationResume,
  releaseNavigationResume,
}));
vi.mock("../ai/memory.service", () => ({ getMemorySettings, loadMemories }));
vi.mock("./transcript-corrector", () => ({
  correctUserTranscript: vi.fn(async (t: string) => t.replace("珠北", "竹北")),
}));

import { createLiveBridge } from "./live-bridge";
import {
  NavProgressSchema,
  NavResumeFailedMessageSchema,
  NavResumeOkMessageSchema,
} from "./voice.ws.schema";
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

    await (
      await createLiveBridge({ ws, userId: "voice-user" })
    ).voiceReady;
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

    await (
      await createLiveBridge({ ws, userId: "voice-user" })
    ).voiceReady;
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

    await (
      await createLiveBridge({ ws, userId: "voice-user" })
    ).voiceReady;
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
    await bridge.voiceReady;
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

    await (
      await createLiveBridge({ ws, userId: "voice-user" })
    ).voiceReady;
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
    delete process.env.GEMINI_LIVE_VOICE;
    connect.mockResolvedValue(makeSession());
  });

  it.each(["en", "zh-TW"] as const)(
    "sends UI language %s via system instructions despite a server language override",
    async (language) => {
      vi.stubEnv("GEMINI_LIVE_LANGUAGE_CODE", "cmn-TW");
      const bridge = await createLiveBridge({
        ws: makeWs(),
        userId: "u",
        language,
      });
      try {
        await bridge.voiceReady;
        const config = connect.mock.calls[0][0].config;
        expect(config.systemInstruction).toContain(
          `【目前介面語言偏好：${language}】`,
        );
        expect(config.speechConfig).toBeUndefined();
      } finally {
        bridge.close();
        vi.unstubAllEnvs();
      }
    },
  );

  it("uses a valid GEMINI_LIVE_TEMPERATURE and otherwise leaves Live's default", async () => {
    process.env.GEMINI_LIVE_TEMPERATURE = "0.4";
    await (
      await createLiveBridge({ ws: makeWs(), userId: "u" })
    ).voiceReady;
    expect(connect.mock.calls[0][0].config.temperature).toBe(0.4);

    for (const raw of [undefined, "abc"]) {
      connect.mockClear();
      if (raw === undefined) delete process.env.GEMINI_LIVE_TEMPERATURE;
      else process.env.GEMINI_LIVE_TEMPERATURE = raw;
      await (
        await createLiveBridge({ ws: makeWs(), userId: "u" })
      ).voiceReady;
      expect(connect.mock.calls[0][0].config).not.toHaveProperty("temperature");
    }
  });

  it("adds speechConfig only for a validly-formatted language code", async () => {
    process.env.GEMINI_LIVE_LANGUAGE_CODE = "cmn-TW";
    await (
      await createLiveBridge({ ws: makeWs(), userId: "u" })
    ).voiceReady;
    expect(connect.mock.calls[0][0].config.speechConfig).toEqual({
      languageCode: "cmn-TW",
    });
  });

  it("keeps barge-in but lowers start-of-speech sensitivity so speaker echo does not interrupt", async () => {
    await (
      await createLiveBridge({ ws: makeWs(), userId: "u" })
    ).voiceReady;
    const { realtimeInputConfig } = connect.mock.calls[0][0].config;
    expect(realtimeInputConfig.automaticActivityDetection).toEqual({
      startOfSpeechSensitivity: StartSensitivity.START_SENSITIVITY_LOW,
    });
    expect(realtimeInputConfig.activityHandling).toBeUndefined();
  });

  it("pins the configured prebuilt voice alongside the language code", async () => {
    process.env.GEMINI_LIVE_VOICE = "Kore";
    process.env.GEMINI_LIVE_LANGUAGE_CODE = "cmn-TW";
    await (
      await createLiveBridge({ ws: makeWs(), userId: "u" })
    ).voiceReady;
    expect(connect.mock.calls[0][0].config.speechConfig).toEqual({
      languageCode: "cmn-TW",
      voiceConfig: { prebuiltVoiceConfig: { voiceName: "Kore" } },
    });
  });

  it("omits speechConfig when the language code is unset or malformed", async () => {
    await (
      await createLiveBridge({ ws: makeWs(), userId: "u" })
    ).voiceReady;
    expect(connect.mock.calls[0][0].config.speechConfig).toBeUndefined();

    connect.mockClear();
    process.env.GEMINI_LIVE_LANGUAGE_CODE = "zh_TW";
    await (
      await createLiveBridge({ ws: makeWs(), userId: "u" })
    ).voiceReady;
    expect(connect.mock.calls[0][0].config.speechConfig).toBeUndefined();
  });

  it("adds navigation functions only to the Live tool config", async () => {
    await (
      await createLiveBridge({ ws: makeWs(), userId: "u" })
    ).voiceReady;
    const declarations =
      connect.mock.calls[0][0].config.tools.at(-1).functionDeclarations;
    expect(declarations.map((item: any) => item.name)).toEqual([
      "proposeNavigationCandidate",
      "confirmNavigationCandidateSwitch",
      "startNavigation",
      "stopNavigation",
      "repeatNavStep",
      "getActiveNavigationContext",
      "endVoiceSession",
    ]);
  });
});

describe("createLiveBridge navigation turn arbiter", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getRouteByToken.mockResolvedValue(walkRoute);
    getNavigationEnvelopeByToken.mockResolvedValue(null);
  });

  it.each(["en", "zh-TW"] as const)(
    "reroutes and replaces the active session in %s",
    async (language) => {
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
          canonicalRequest: { requireElevator: false },
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
          language,
          userLocation: { latitude: 25, longitude: 121 },
        });
        await bridge.voiceReady;
        await bridge.armRouteToken("initial");
        onmessage?.({
          serverContent: {
            inputTranscription: { text: "開始導航", finished: true },
          },
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
        expect(types.filter((type) => type === "nav.rerouting")).toHaveLength(
          1,
        );
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
          reason: "OFF_ROUTE",
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
        expect(initialStart.steps.at(-1).instruction).toBe(
          language === "en"
            ? "You have arrived at your destination"
            : "您已抵達目的地",
        );
        expect(routeReplaced).toEqual({
          type: "nav.route_replaced",
          navigationId: "11111111-1111-4111-8111-111111111111",
          previousRouteVersion: 1,
          reason: "OFF_ROUTE",
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
          language,
        });
      } finally {
        vi.useRealTimers();
      }
    },
  );

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
        canonicalRequest: { requireElevator: false },
      });
      const pendingReroute = deferred<any>();
      rerouteAccessibleRoute.mockReturnValue(pendingReroute.promise);
      const bridge = await createLiveBridge({ ws, userId: "u" });
      await bridge.voiceReady;
      await bridge.armRouteToken("initial");
      onmessage?.({
        serverContent: {
          inputTranscription: { text: "開始導航", finished: true },
        },
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
      await bridge.voiceReady;
      await bridge.armRouteToken("initial");
      onmessage?.({
        serverContent: {
          inputTranscription: { text: "開始導航", finished: true },
        },
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
        serverContent: {
          inputTranscription: { text: "停止導航", finished: true },
        },
        toolCall: {
          functionCalls: [{ id: "stop-old", name: "stopNavigation", args: {} }],
        },
      });
      await vi.advanceTimersByTimeAsync(0);
      onmessage?.({
        serverContent: {
          inputTranscription: { text: "開始導航", finished: true },
        },
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
      await bridge.voiceReady;
      await bridge.armRouteToken("initial");
      onmessage?.({
        serverContent: {
          inputTranscription: { text: "開始導航", finished: true },
        },
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
        serverContent: {
          inputTranscription: { text: "停止導航", finished: true },
        },
        toolCall: {
          functionCalls: [{ id: "stop-old", name: "stopNavigation", args: {} }],
        },
      });
      await vi.advanceTimersByTimeAsync(0);
      onmessage?.({
        serverContent: {
          inputTranscription: { text: "開始導航", finished: true },
        },
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

  it("discards the old offroute reroute and cleans up the active session when the pending setRoute lookup fails", async () => {
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
        canonicalRequest: { requireElevator: false },
      });
      const pendingReroute = deferred<any>();
      rerouteAccessibleRoute.mockReturnValue(pendingReroute.promise);
      const bridge = await createLiveBridge({ ws, userId: "u" });
      await bridge.voiceReady;
      await bridge.armRouteToken("initial");
      onmessage?.({
        serverContent: {
          inputTranscription: { text: "開始導航", finished: true },
        },
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
        language: "zh-TW",
        routeToken: "initial",
        currentPosition: far,
        previousRouteVersion: 1,
        reason: "OFF_ROUTE",
        clientRequestId: expect.any(String),
      });

      pendingNewRoute.resolve(null);
      const armSuccess = await pendingNewArm;
      expect(armSuccess).toBe(false);
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
      ).toHaveLength(0);
      expect(types.filter((type) => type === "nav.stop")).toHaveLength(1);
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
      await bridge.voiceReady;

      const firstArm = bridge.armRouteToken("first-pending");
      const secondArm = bridge.armRouteToken("second-pending");
      firstPending.resolve(firstRoute);
      await firstArm;
      secondPending.resolve(secondRoute);
      await secondArm;
      onmessage?.({
        serverContent: {
          inputTranscription: { text: "開始導航", finished: true },
        },
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
        canonicalRequest: { requireElevator: false },
      });
      const ws = makeWs();
      const bridge = await createLiveBridge({ ws, userId: "u" });
      await bridge.voiceReady;
      await bridge.armRouteToken("initial");
      onmessage?.({
        serverContent: {
          inputTranscription: { text: "開始導航", finished: true },
        },
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
        serverContent: {
          inputTranscription: { text: "開始導航", finished: true },
        },
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
        canonicalRequest: { requireElevator: false },
      });
      rerouteAccessibleRoute.mockResolvedValue({
        ok: false,
        status: 503,
        error: "Redis unavailable",
      });
      const bridge = await createLiveBridge({ ws, userId: "u" });
      await bridge.voiceReady;
      await bridge.armRouteToken("initial");
      onmessage?.({
        serverContent: {
          inputTranscription: { text: "開始導航", finished: true },
        },
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
        language: "zh-TW",
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

  it("forwards schema-valid nav.progress frames produced by the session", async () => {
    let onmessage: ((message: unknown) => void) | undefined;
    const session = makeSession();
    const ws = makeWs();
    connect.mockImplementation(async ({ callbacks }) => {
      onmessage = callbacks.onmessage;
      return session;
    });
    const navigationRoute = structuredClone(walkRoute);
    navigationRoute.navigationId = "44444444-4444-4444-8444-444444444444";
    navigationRoute.routeVersion = 1;
    getRouteByToken.mockResolvedValue(navigationRoute);

    const bridge = await createLiveBridge({ ws, userId: "u" });
    await bridge.voiceReady;
    await bridge.armRouteToken("cap");
    onmessage?.({
      serverContent: {
        inputTranscription: { text: "開始導航", finished: true },
      },
      toolCall: {
        functionCalls: [{ id: "nav", name: "startNavigation", args: {} }],
      },
    });
    await vi.waitFor(() =>
      expect(session.sendToolResponse).toHaveBeenCalledOnce(),
    );
    bridge.updatePosition({ latitude: start[1], longitude: start[0] });

    const progress = vi
      .mocked(ws.send)
      .mock.calls.map(([value]) => value)
      .filter((value): value is string => typeof value === "string")
      .map((value) => JSON.parse(value))
      .find((message) => message.type === "nav.progress");
    expect(NavProgressSchema.parse(progress)).toMatchObject({
      navigationId: "44444444-4444-4444-8444-444444444444",
      routeVersion: 1,
      etaSource: "estimated",
    });
  });

  it.each([undefined, "zh-TW", "en"] as const)(
    "sends the navigation tool response before speech in language %s",
    async (language) => {
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
        language,
      });
      await bridge.voiceReady;
      await bridge.armRouteToken("cap");
      onmessage?.({
        serverContent: {
          inputTranscription: { text: "開始導航", finished: true },
        },
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
        language === "en"
          ? "請依介面語言播報以下導航指引：使用英文"
          : "請逐字唸出以下導航指引",
      );
    },
  );

  it("waits for a real idle boundary while ordinary model output is active", async () => {
    let onmessage: ((message: unknown) => void) | undefined;
    const session = makeSession();
    connect.mockImplementation(async ({ callbacks }) => {
      onmessage = callbacks.onmessage;
      return session;
    });
    const bridge = await createLiveBridge({ ws: makeWs(), userId: "u" });
    await bridge.voiceReady;
    await bridge.armRouteToken("cap");
    onmessage?.({
      serverContent: { modelTurn: { parts: [{ text: "一般回覆" }] } },
    });
    bridge.updatePosition({ latitude: 25, longitude: 121 });
    onmessage?.({
      serverContent: {
        inputTranscription: { text: "開始導航", finished: true },
      },
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

  it("speaks queued navigation once the model turn has degraded into a trimmed silent tail", async () => {
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
    await bridge.voiceReady;
    await bridge.armRouteToken("cap");
    onmessage?.({
      serverContent: {
        inputTranscription: { text: "開始導航", finished: true },
      },
      toolCall: {
        functionCalls: [{ id: "nav", name: "startNavigation", args: {} }],
      },
    });
    await vi.waitFor(() =>
      expect(session.sendToolResponse).toHaveBeenCalledOnce(),
    );
    const oneSecondOfSilence = Buffer.alloc(48_000).toString("base64");
    onmessage?.({
      serverContent: {
        modelTurn: {
          parts: [
            { inlineData: { data: farewell(500) } },
            ...Array.from({ length: 30 }, () => ({
              inlineData: { data: oneSecondOfSilence },
            })),
          ],
        },
      },
    });
    // Live keeps the turn open until the hidden tail would finish playing.
    onmessage?.({ serverContent: { generationComplete: true } });
    await vi.waitFor(() =>
      expect(session.sendClientContent).toHaveBeenCalledOnce(),
    );
  });

  it("does not replay or flush when its own navigation content ends a generated turn", async () => {
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
    await bridge.voiceReady;
    await bridge.armRouteToken("cap");
    onmessage?.({
      serverContent: {
        inputTranscription: { text: "開始導航", finished: true },
      },
      toolCall: {
        functionCalls: [{ id: "nav", name: "startNavigation", args: {} }],
      },
    });
    await vi.waitFor(() =>
      expect(session.sendToolResponse).toHaveBeenCalledOnce(),
    );
    onmessage?.({
      serverContent: {
        modelTurn: { parts: [{ inlineData: { data: farewell(500) } }] },
        outputTranscription: { text: "好的，開始導航。" },
      },
    });
    onmessage?.({ serverContent: { generationComplete: true } });
    await vi.waitFor(() =>
      expect(session.sendClientContent).toHaveBeenCalledOnce(),
    );
    const announcement = session.sendClientContent.mock.calls[0][0].turns;
    // Live's observed order: the old turn's interrupted, then its turnComplete.
    onmessage?.({ serverContent: { interrupted: true } });
    onmessage?.({ serverContent: { turnComplete: true } });
    onmessage?.({
      serverContent: {
        modelTurn: { parts: [{ inlineData: { data: farewell(500) } }] },
      },
    });
    onmessage?.({ serverContent: { generationComplete: true } });
    onmessage?.({ serverContent: { turnComplete: true } });
    await new Promise((resolve) => setTimeout(resolve, 20));

    const frames = vi
      .mocked(ws.send)
      .mock.calls.filter(([value]) => typeof value === "string")
      .map(([value]) => JSON.parse(value as string));
    expect(frames.some((frame) => frame.type === "interrupted")).toBe(false);
    expect(
      frames.filter((frame) => frame.type === "turn.complete"),
    ).toHaveLength(2);
    expect(
      session.sendClientContent.mock.calls.filter(
        ([content]) => content.turns === announcement,
      ),
    ).toHaveLength(1);
  });

  it("forwards a barge-in that follows its own preempting interrupt", async () => {
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
    await bridge.voiceReady;
    await bridge.armRouteToken("cap");
    onmessage?.({
      serverContent: {
        inputTranscription: { text: "開始導航", finished: true },
      },
      toolCall: {
        functionCalls: [{ id: "nav", name: "startNavigation", args: {} }],
      },
    });
    await vi.waitFor(() =>
      expect(session.sendToolResponse).toHaveBeenCalledOnce(),
    );
    onmessage?.({ serverContent: { generationComplete: true } });
    await vi.waitFor(() =>
      expect(session.sendClientContent).toHaveBeenCalledOnce(),
    );
    onmessage?.({ serverContent: { interrupted: true } });
    await new Promise((resolve) => setTimeout(resolve, 20));
    const interruptedFrames = () =>
      vi
        .mocked(ws.send)
        .mock.calls.filter(([value]) => typeof value === "string")
        .map(([value]) => JSON.parse(value as string))
        .filter((frame) => frame.type === "interrupted");
    expect(interruptedFrames()).toHaveLength(0);
    onmessage?.({ serverContent: { interrupted: true } });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(interruptedFrames()).toHaveLength(1);
  });

  it("finishes a navigation turn at generationComplete so its playback wait cannot time out voice", async () => {
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
      await bridge.voiceReady;
      await bridge.armRouteToken("cap");
      onmessage?.({
        serverContent: {
          inputTranscription: { text: "開始導航", finished: true },
        },
        toolCall: {
          functionCalls: [{ id: "nav", name: "startNavigation", args: {} }],
        },
      });
      await vi.advanceTimersByTimeAsync(0);
      onmessage?.({ serverContent: { turnComplete: true } });
      await vi.advanceTimersByTimeAsync(0);
      expect(session.sendClientContent).toHaveBeenCalledOnce();
      onmessage?.({ serverContent: { generationComplete: true } });
      await vi.advanceTimersByTimeAsync(60_000);
      const frames = vi
        .mocked(ws.send)
        .mock.calls.filter(([value]) => typeof value === "string")
        .map(([value]) => JSON.parse(value as string));
      expect(frames).not.toContainEqual({
        type: "error",
        code: "LIVE_SESSION_ENDED",
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("treats a fully generated announcement as spoken, so a later barge-in does not replay it", async () => {
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
    await bridge.voiceReady;
    await bridge.armRouteToken("cap");
    onmessage?.({
      serverContent: {
        inputTranscription: { text: "開始導航", finished: true },
      },
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
    const announcement = session.sendClientContent.mock.calls[0][0].turns;
    onmessage?.({ serverContent: { generationComplete: true } });
    // The barge-in arrives after playback started, not in the same tick.
    await new Promise((resolve) => setTimeout(resolve, 20));
    onmessage?.({ serverContent: { interrupted: true } });
    onmessage?.({ serverContent: { turnComplete: true } });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(
      session.sendClientContent.mock.calls.filter(
        ([content]) => content.turns === announcement,
      ),
    ).toHaveLength(1);
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
    await bridge.voiceReady;
    await bridge.armRouteToken("cap");
    onmessage?.({
      serverContent: {
        inputTranscription: { text: "開始導航", finished: true },
      },
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

  it("does not overlap turns on timeout and degrades voice after consecutive timeout strikes", async () => {
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
      await bridge.voiceReady;
      await bridge.armRouteToken("cap");
      onmessage?.({
        serverContent: {
          inputTranscription: { text: "開始導航", finished: true },
        },
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
      expect(ws.close).not.toHaveBeenCalled();
      const frames = (ws.send as unknown as ReturnType<typeof vi.fn>).mock.calls
        .filter((c: unknown[]) => typeof c[0] === "string")
        .map((c: unknown[]) => JSON.parse(c[0] as string));
      expect(frames).toContainEqual({
        type: "error",
        code: "LIVE_SESSION_ENDED",
      });
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
    await bridge.voiceReady;
    await bridge.armRouteToken("cap");
    onmessage?.({
      serverContent: {
        inputTranscription: { text: "開始導航", finished: true },
      },
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
        expect.objectContaining({ allowMemoryWrite: false }),
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
    await bridge.voiceReady;
    const oldArm = bridge.armRouteToken("old");
    const newArm = bridge.armRouteToken("new");
    resolveNew(newRoute);
    await newArm;
    resolveOld(oldRoute);
    await oldArm;
    onmessage?.({
      serverContent: {
        inputTranscription: { text: "開始導航", finished: true },
      },
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
      await bridge.voiceReady;
      await bridge.armRouteToken("cap");
      onmessage?.({
        serverContent: {
          inputTranscription: { text: "開始導航", finished: true },
        },
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
    await bridge.voiceReady;
    await bridge.armRouteToken("cap");
    onmessage?.({
      serverContent: {
        inputTranscription: { text: "開始導航", finished: true },
      },
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
    await bridge.voiceReady;
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
        expect.objectContaining({ allowMemoryWrite: false }),
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

    await (
      await createLiveBridge({ ws: makeWs(), userId: "voice-user" })
    ).voiceReady;

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

    await (
      await createLiveBridge({ ws, userId: "voice-user" })
    ).voiceReady;
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

    await (
      await createLiveBridge({ ws, userId: "voice-user" })
    ).voiceReady;
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

    await (
      await createLiveBridge({ ws, userId: "voice-user" })
    ).voiceReady;
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
    await (
      await createLiveBridge({ ws, userId: "mem-user" })
    ).voiceReady;

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
    await (
      await createLiveBridge({ ws, userId: "no-mem-user" })
    ).voiceReady;

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
    await (
      await createLiveBridge({ ws, userId: "mem-user" })
    ).voiceReady;

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
        expect.objectContaining({ allowMemoryWrite: true }),
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
      onmessage?.({
        serverContent: {
          inputTranscription: {
            text:
              name === "startNavigation"
                ? "開始導航"
                : name === "stopNavigation"
                  ? "停止導航"
                  : "查詢",
            finished: true,
          },
        },
        toolCall: { functionCalls: [{ id, name, args: {} }] },
      });
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
      await bridge.voiceReady;

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
      await bridge.voiceReady;

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
      await bridge.voiceReady;

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
      await bridge.voiceReady;

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
      await bridge.voiceReady;

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

describe("createLiveBridge navigation resume and snapshot lifecycle", () => {
  const NAV_ID = "55555555-5555-4555-8555-555555555555";
  const ON_ROUTE = { latitude: 25, longitude: 121 };
  const MID_ROUTE = { latitude: 25, longitude: 121.0005 };
  const ARRIVAL = { latitude: 25, longitude: 121.001 };
  const identifiedRoute = {
    ...walkRoute,
    navigationId: NAV_ID,
    routeVersion: 1,
  };

  const snapshot = (overrides: Record<string, unknown> = {}) => ({
    navigationId: NAV_ID,
    userId: "u",
    routeToken: "token",
    routeVersion: 1,
    currentStepIndex: 1,
    onVehicle: false,
    latestPosition: null,
    updatedAt: Date.now(),
    ...overrides,
  });

  const resumeMessage = (overrides: Record<string, unknown> = {}) => ({
    type: "nav.resume" as const,
    navigationId: NAV_ID,
    routeVersion: 1,
    routeToken: "token",
    lastKnownStepIndex: 1,
    ...overrides,
  });

  function frames(ws: WebSocket): any[] {
    return vi
      .mocked(ws.send)
      .mock.calls.map(([value]) => value)
      .filter((value): value is string => typeof value === "string")
      .map((value) => JSON.parse(value));
  }

  function frameOf(ws: WebSocket, type: string): any | undefined {
    return frames(ws).find((frame) => frame.type === type);
  }

  function makeHarness() {
    let onmessage: ((message: unknown) => void) | undefined;
    const session = makeSession();
    const ws = makeWs();
    connect.mockImplementation(async ({ callbacks }: any) => {
      onmessage = callbacks.onmessage;
      return session;
    });
    const call = async (id: string, name: string): Promise<void> => {
      onmessage?.({
        serverContent: {
          inputTranscription: {
            text:
              name === "startNavigation"
                ? "開始導航"
                : name === "stopNavigation"
                  ? "停止導航"
                  : "查詢",
            finished: true,
          },
        },
        toolCall: { functionCalls: [{ id, name, args: {} }] },
      });
      await vi.advanceTimersByTimeAsync(0);
    };
    return { ws, session, call };
  }

  beforeEach(() => {
    vi.clearAllMocks();
    getRouteByToken.mockResolvedValue(identifiedRoute);
    getNavigationEnvelopeByToken.mockResolvedValue({
      navigationId: NAV_ID,
      routeVersion: 1,
      canonicalRequest: { requireElevator: false },
    });
    getNavigationSnapshot.mockResolvedValue(snapshot());
    storeNavigationSnapshot.mockResolvedValue(undefined);
    deleteNavigationSnapshot.mockResolvedValue(undefined);
  });

  it("resumes from the snapshot and emits a contract-valid nav.resume_ok", async () => {
    const { ws } = makeHarness();
    const bridge = await createLiveBridge({ ws, userId: "u" });
    await bridge.voiceReady;

    await bridge.resumeNavigation(resumeMessage());

    const ok = frameOf(ws, "nav.resume_ok");
    expect(ok).toMatchObject({
      navigationId: NAV_ID,
      routeVersion: 1,
      routeToken: "token",
      currentStepIndex: 1,
      onVehicle: false,
    });
    expect(NavResumeOkMessageSchema.parse(ok)).toEqual(ok);
    expect(frameOf(ws, "nav.resume_failed")).toBeUndefined();
  });

  it.each([
    ["en", "Roosevelt Road"],
    ["zh-TW", "羅斯福路"],
  ] as const)(
    "resumes source-backed street names in %s without changing saved machine steps",
    async (language, expectedStreet) => {
      const { ws } = makeHarness();
      const route = structuredClone(identifiedRoute);
      const sourceSteps: WalkStep[] = route.legs[0].steps.map(
        (step: WalkStep) => ({
          relativeDirection: step.relativeDirection,
          absoluteDirection: step.absoluteDirection,
          streetName: "羅斯福路",
          bogusName: false,
          area: false,
          stairs: false,
          steepSlope: false,
          distanceM: step.distanceM,
          location: step.location,
        }),
      );
      const sourceLeg = {
        ...route.legs[0],
        steps: sourceSteps,
        stepStreetNames: sourceSteps.map((step, index) => ({
          index,
          streetName: step.streetName,
          nameEn: "Roosevelt Road",
          displayName: "羅斯福路",
        })),
      };
      const saved = { ...route, legs: [sourceLeg] };
      const before = JSON.stringify(saved);
      getRouteByToken.mockResolvedValue(saved);
      const bridge = await createLiveBridge({ ws, userId: "u", language });
      try {
        await bridge.voiceReady;
        await bridge.resumeNavigation(resumeMessage());
        const resumed = frameOf(ws, "nav.resume_ok");
        expect(resumed.currentStepIndex).toBe(1);
        expect(
          resumed.steps.some((step: { instruction: string }) =>
            step.instruction.includes(expectedStreet),
          ),
        ).toBe(true);
        expect(JSON.stringify(saved)).toBe(before);
        expect(rerouteAccessibleRoute).not.toHaveBeenCalled();
        for (const step of sourceSteps)
          expect(Object.keys(step)).toHaveLength(9);
      } finally {
        bridge.close();
      }
    },
  );

  it("rebuilds resumed steps and navigation errors using the new session language", async () => {
    const { ws } = makeHarness();
    const bridge = await createLiveBridge({ ws, userId: "u", language: "en" });
    try {
      await bridge.voiceReady;
      await bridge.resumeNavigation(resumeMessage());
      const resumed = frameOf(ws, "nav.resume_ok");
      expect(resumed.currentStepIndex).toBe(1);
      expect(resumed.steps.at(-1).instruction).toBe(
        "You have arrived at your destination",
      );
      getNavigationSnapshot.mockResolvedValue(null);
      await bridge.resumeNavigation(resumeMessage());
      expect(frameOf(ws, "nav.resume_failed").message).toBe(
        "Your navigation progress has expired. Please plan a new route.",
      );
    } finally {
      bridge.close();
    }
  });

  it("retains English after an expired token resets navigation", async () => {
    const { ws } = makeHarness();
    const bridge = await createLiveBridge({ ws, userId: "u", language: "en" });
    try {
      await bridge.voiceReady;
      getRouteByToken.mockResolvedValueOnce(null);
      expect(await bridge.armRouteToken("expired")).toBe(false);
      expect(frameOf(ws, "nav.error").message).toBe(
        "The route has expired. Please plan a new route.",
      );
      await bridge.armRouteToken("token");
      bridge.startNavigation();
      expect(frameOf(ws, "nav.start").steps.at(-1).instruction).toBe(
        "You have arrived at your destination",
      );
    } finally {
      bridge.close();
    }
  });

  it("re-persists the snapshot immediately after a successful resume", async () => {
    const { ws } = makeHarness();
    const bridge = await createLiveBridge({ ws, userId: "u" });
    await bridge.voiceReady;

    await bridge.resumeNavigation(resumeMessage());

    expect(storeNavigationSnapshot).toHaveBeenCalledWith(
      expect.objectContaining({
        navigationId: NAV_ID,
        userId: "u",
        routeToken: "token",
        routeVersion: 1,
        currentStepIndex: 1,
      }),
    );
  });

  it("resumes onto the snapshot position when the client sends none", async () => {
    getNavigationSnapshot.mockResolvedValue(
      snapshot({ latestPosition: { latitude: 25, longitude: 121 } }),
    );
    const { ws } = makeHarness();
    const bridge = await createLiveBridge({ ws, userId: "u" });
    await bridge.voiceReady;

    await bridge.resumeNavigation(resumeMessage());

    expect(frameOf(ws, "nav.progress")).toBeDefined();
    expect(NavProgressSchema.parse(frameOf(ws, "nav.progress"))).toBeDefined();
  });

  it.each([
    [
      "no snapshot exists",
      "SNAPSHOT_NOT_FOUND",
      () => getNavigationSnapshot.mockResolvedValue(null),
    ],
    [
      "the snapshot belongs to another user",
      "USER_MISMATCH",
      () =>
        getNavigationSnapshot.mockResolvedValue(snapshot({ userId: "other" })),
    ],
    [
      "the snapshot route version moved on",
      "ROUTE_VERSION_MISMATCH",
      () =>
        getNavigationSnapshot.mockResolvedValue(snapshot({ routeVersion: 9 })),
    ],
    [
      "the snapshot route token no longer matches",
      "ROUTE_VERSION_MISMATCH",
      () =>
        getNavigationSnapshot.mockResolvedValue(
          snapshot({ routeToken: "other" }),
        ),
    ],
    [
      "the route token expired",
      "ROUTE_EXPIRED",
      () => getRouteByToken.mockResolvedValue(null),
    ],
    [
      "the envelope no longer binds the navigation",
      "ROUTE_EXPIRED",
      () =>
        getNavigationEnvelopeByToken.mockResolvedValue({
          navigationId: "other-nav",
          routeVersion: 1,
          canonicalRequest: { requireElevator: false },
        }),
    ],
  ])("fails with %s", async (_label, code, arrange) => {
    arrange();
    const { ws } = makeHarness();
    const bridge = await createLiveBridge({ ws, userId: "u" });
    await bridge.voiceReady;

    await bridge.resumeNavigation(resumeMessage());

    const failed = frameOf(ws, "nav.resume_failed");
    expect(failed).toMatchObject({ navigationId: NAV_ID, code });
    expect(NavResumeFailedMessageSchema.parse(failed)).toEqual(failed);
    expect(frameOf(ws, "nav.resume_ok")).toBeUndefined();
    expect(storeNavigationSnapshot).not.toHaveBeenCalled();
  });

  it("throttles snapshot writes between position ticks and resumes them after the interval", async () => {
    vi.useFakeTimers();
    try {
      const { ws, call } = makeHarness();
      const bridge = await createLiveBridge({ ws, userId: "u" });
      await bridge.voiceReady;
      await bridge.armRouteToken("token");
      await call("start", "startNavigation");
      const afterStart = storeNavigationSnapshot.mock.calls.length;
      expect(afterStart).toBeGreaterThan(0);

      // A step advance forces a write regardless of the throttle.
      bridge.updatePosition(ON_ROUTE);
      await vi.advanceTimersByTimeAsync(600);
      const afterStep = storeNavigationSnapshot.mock.calls.length;
      expect(afterStep).toBeGreaterThan(afterStart);

      // A tick that advances nothing inside the interval is throttled away.
      bridge.updatePosition(ON_ROUTE);
      await vi.advanceTimersByTimeAsync(600);
      expect(storeNavigationSnapshot.mock.calls.length).toBe(afterStep);

      await vi.advanceTimersByTimeAsync(6_000);
      bridge.updatePosition(MID_ROUTE);
      await vi.advanceTimersByTimeAsync(600);

      expect(storeNavigationSnapshot.mock.calls.length).toBeGreaterThan(
        afterStep,
      );
      expect(storeNavigationSnapshot).toHaveBeenLastCalledWith(
        expect.objectContaining({
          navigationId: NAV_ID,
          userId: "u",
          routeToken: "token",
          routeVersion: 1,
          latestPosition: expect.objectContaining({
            latitude: 25,
            longitude: 121.0005,
          }),
        }),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("deletes the snapshot once the route is completed", async () => {
    vi.useFakeTimers();
    try {
      const { ws, call } = makeHarness();
      const bridge = await createLiveBridge({ ws, userId: "u" });
      await bridge.voiceReady;
      await bridge.armRouteToken("token");
      await call("start", "startNavigation");

      bridge.updatePosition(ON_ROUTE);
      await vi.advanceTimersByTimeAsync(600);
      bridge.updatePosition(ARRIVAL);
      await vi.advanceTimersByTimeAsync(600);

      expect(frameOf(ws, "nav.arrived")).toBeDefined();
      expect(deleteNavigationSnapshot).toHaveBeenCalledWith(NAV_ID, "u");
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([
    ["the voice stopNavigation tool", "tool"],
    ["an explicit cancelNav", "cancel"],
    ["an explicit endSession", "end"],
  ])("deletes the snapshot on %s", async (_label, how) => {
    vi.useFakeTimers();
    try {
      const { ws, call } = makeHarness();
      const bridge = await createLiveBridge({ ws, userId: "u" });
      await bridge.voiceReady;
      await bridge.armRouteToken("token");
      await call("start", "startNavigation");
      expect(deleteNavigationSnapshot).not.toHaveBeenCalled();

      if (how === "tool") await call("stop", "stopNavigation");
      else if (how === "cancel") bridge.cancelNav();
      else bridge.endSession();

      expect(deleteNavigationSnapshot).toHaveBeenCalledWith(NAV_ID, "u");
    } finally {
      vi.useRealTimers();
    }
  });

  it("stops and tombstones a navigation while resume is still loading", async () => {
    vi.useFakeTimers();
    try {
      const pendingSnapshot = deferred<ReturnType<typeof snapshot>>();
      getNavigationSnapshot.mockReturnValueOnce(pendingSnapshot.promise);
      const { ws, call } = makeHarness();
      const bridge = await createLiveBridge({ ws, userId: "u" });
      await bridge.voiceReady;

      const resume = bridge.resumeNavigation(resumeMessage());
      await Promise.resolve();
      expect(getNavigationSnapshot).toHaveBeenCalledWith(NAV_ID);

      const stopping = call("stop-pending-resume", "stopNavigation");
      await vi.advanceTimersByTimeAsync(0);
      await stopping;

      expect(frameOf(ws, "nav.stop")).toEqual({
        type: "nav.stop",
        reason: "user_voice",
      });
      expect(markNavigationStopped).toHaveBeenCalledWith(NAV_ID, "u");

      pendingSnapshot.resolve(snapshot());
      await resume;
      expect(frameOf(ws, "nav.resume_ok")).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it("fails closed when the distributed resume commit loses to stop", async () => {
    const ws = makeWs();
    connect.mockImplementation(async () => makeSession());
    const bridge = await createLiveBridge({ ws, userId: "u" });
    await bridge.voiceReady;
    commitNavigationResume.mockResolvedValueOnce("stopped");

    await bridge.resumeNavigation(resumeMessage());

    expect(frameOf(ws, "nav.resume_ok")).toBeUndefined();
    expect(frameOf(ws, "nav.resume_failed")).toMatchObject({
      code: "SNAPSHOT_NOT_FOUND",
    });
    expect(releaseNavigationResume).toHaveBeenCalledWith(
      NAV_ID,
      expect.any(String),
    );
    bridge.close();
  });

  it("a stop on another bridge invalidates a resume after its snapshot was read", async () => {
    let onMessageA: ((message: unknown) => void) | undefined;
    const wsA = makeWs();
    const wsB = makeWs();
    connect
      .mockImplementationOnce(async ({ callbacks }: any) => {
        onMessageA = callbacks.onmessage;
        return makeSession();
      })
      .mockImplementationOnce(async () => makeSession());

    const bridgeA = await createLiveBridge({ ws: wsA, userId: "u" });
    const bridgeB = await createLiveBridge({ ws: wsB, userId: "u" });
    await Promise.all([bridgeA.voiceReady, bridgeB.voiceReady]);
    await bridgeA.armRouteToken("token");
    bridgeA.startNavigation();

    const pendingRoute = deferred<typeof identifiedRoute>();
    getRouteByToken.mockReturnValueOnce(pendingRoute.promise);
    const resume = bridgeB.resumeNavigation(resumeMessage());
    await vi.waitFor(() => expect(getRouteByToken).toHaveBeenCalled());

    onMessageA?.({
      serverContent: {
        inputTranscription: { text: "停止導航", finished: true },
      },
      toolCall: {
        functionCalls: [{ id: "cross-stop", name: "stopNavigation", args: {} }],
      },
    });
    await vi.waitFor(() =>
      expect(markNavigationStopped).toHaveBeenCalledWith(NAV_ID, "u"),
    );

    pendingRoute.resolve(identifiedRoute);
    await resume;
    expect(frameOf(wsB, "nav.resume_ok")).toBeUndefined();
    expect(frameOf(wsB, "nav.resume_failed")).toMatchObject({
      code: "SNAPSHOT_NOT_FOUND",
    });

    bridgeA.close();
    bridgeB.close();
  });

  it("keeps the snapshot when the socket closes so a reconnect can resume", async () => {
    vi.useFakeTimers();
    try {
      const { ws, call } = makeHarness();
      const bridge = await createLiveBridge({ ws, userId: "u" });
      await bridge.voiceReady;
      await bridge.armRouteToken("token");
      await call("start", "startNavigation");

      bridge.close();

      expect(deleteNavigationSnapshot).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("ignores a resume once the bridge is closed", async () => {
    const { ws } = makeHarness();
    const bridge = await createLiveBridge({ ws, userId: "u" });
    await bridge.voiceReady;
    bridge.close();

    await bridge.resumeNavigation(resumeMessage());

    expect(getNavigationSnapshot).not.toHaveBeenCalled();
    expect(frameOf(ws, "nav.resume_ok")).toBeUndefined();
  });

  it("reports a retryable failure when the snapshot read throws", async () => {
    getNavigationSnapshot.mockRejectedValue(new Error("redis down"));
    const { ws } = makeHarness();
    const bridge = await createLiveBridge({ ws, userId: "u" });
    await bridge.voiceReady;

    await bridge.resumeNavigation(resumeMessage());

    expect(frameOf(ws, "nav.resume_failed")).toMatchObject({
      code: "SNAPSHOT_NOT_FOUND",
      retryable: true,
    });
  });
});

describe("createLiveBridge navigation independence from the voice session", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getRouteByToken.mockResolvedValue(walkRoute);
    getNavigationEnvelopeByToken.mockResolvedValue({
      navigationId: "nav-1",
      routeVersion: 1,
      canonicalRequest: { requireElevator: false },
    });
    connect.mockResolvedValue(makeSession());
  });

  const framesOf = (ws: WebSocket) =>
    vi
      .mocked(ws.send)
      .mock.calls.map(([value]) => value)
      .filter((value): value is string => typeof value === "string")
      .map((value) => JSON.parse(value));

  it("bridge.startNavigation() produces the same effect as the startNavigation tool call", async () => {
    const wsViaTool = makeWs();
    let onmessage: ((message: unknown) => void) | undefined;
    connect.mockImplementation(async ({ callbacks }) => {
      onmessage = callbacks.onmessage;
      return makeSession();
    });
    const toolBridge = await createLiveBridge({ ws: wsViaTool, userId: "u" });
    await toolBridge.voiceReady;
    await toolBridge.armRouteToken("cap");
    onmessage?.({
      serverContent: {
        inputTranscription: { text: "開始導航", finished: true },
      },
      toolCall: {
        functionCalls: [{ id: "nav", name: "startNavigation", args: {} }],
      },
    });
    await Promise.resolve();
    await Promise.resolve();

    const wsViaWire = makeWs();
    connect.mockResolvedValue(makeSession());
    const wireBridge = await createLiveBridge({ ws: wsViaWire, userId: "u" });
    await wireBridge.voiceReady;
    await wireBridge.armRouteToken("cap");
    wireBridge.startNavigation();

    const toolStart = framesOf(wsViaTool).find((f) => f.type === "nav.start");
    const wireStart = framesOf(wsViaWire).find((f) => f.type === "nav.start");
    expect(wireStart).toBeDefined();
    expect(wireStart).toEqual(toolStart);
    expect(storeNavigationSnapshot).toHaveBeenCalled();

    toolBridge.close();
    wireBridge.close();
  });

  it("session.onclose keeps the client socket open and reports LIVE_SESSION_ENDED", async () => {
    const ws = makeWs();
    let onclose: (() => void) | undefined;
    connect.mockImplementation(async ({ callbacks }) => {
      onclose = callbacks.onclose;
      return makeSession();
    });
    const bridge = await createLiveBridge({ ws, userId: "u" });
    await bridge.voiceReady;

    onclose?.();

    expect(ws.close).not.toHaveBeenCalled();
    expect(framesOf(ws)).toContainEqual({
      type: "error",
      code: "LIVE_SESSION_ENDED",
    });
    bridge.close();
  });

  it("logs the upstream close code so mid-session voice loss is diagnosable", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const ws = makeWs();
    let onclose: ((e: { code: number; reason: string }) => void) | undefined;
    connect.mockImplementation(async ({ callbacks }) => {
      onclose = callbacks.onclose;
      return makeSession();
    });
    const bridge = await createLiveBridge({ ws, userId: "u" });
    await bridge.voiceReady;

    onclose?.({ code: 1011, reason: "Internal error" });

    expect(warn).toHaveBeenCalledWith(
      "[voice] live session closed by upstream",
      JSON.stringify({ code: 1011, reason: "Internal error" }),
    );
    bridge.close();
    warn.mockRestore();
  });

  it("resolves before the Gemini handshake settles", async () => {
    vi.useFakeTimers();
    try {
      const ws = makeWs();
      const pendingConnect = deferred<any>();
      connect.mockReturnValue(pendingConnect.promise);

      const bridge = await createLiveBridge({ ws, userId: "u" });
      expect(vi.getTimerCount()).toBe(1); // Bounded background bootstrap; navigation is already usable.

      await bridge.armRouteToken("cap");
      bridge.startNavigation();

      expect(framesOf(ws).some((f) => f.type === "nav.start")).toBe(true);
      bridge.close();
      await bridge.voiceReady;
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("AI selected-route synchronization", () => {
  const busRoute = {
    ...walkRoute,
    routeId: "bus-view",
    routeName: "公車方案",
    routeToken: "bus-token",
    navigationId: "nav-bus",
    routeVersion: 1,
    legs: [
      {
        type: "BUS",
        routeName: "99",
        departureStop: "起站",
        arrivalStop: "台中火車站",
        polyline: [start, end],
      },
    ],
  };
  const plan = {
    ok: true,
    routeContractVersion: 1,
    planId: "p1",
    selectedRouteId: busRoute.routeId,
    routes: [busRoute],
    effectivePreferences: { mode: "wheelchair", transitPreference: "bus" },
  };
  const envelope = (route = busRoute) => ({
    schemaVersion: 1,
    route,
    navigationId: route.navigationId,
    routeVersion: 1,
    canonicalRequest: { mode: "wheelchair", transitPreference: "bus" },
  });
  const frames = (ws: WebSocket) =>
    vi
      .mocked(ws.send)
      .mock.calls.filter(([v]) => typeof v === "string")
      .map(([v]) => JSON.parse(v as string));
  beforeEach(() => {
    vi.clearAllMocks();
    getMemorySettings.mockResolvedValue({ memoryEnabled: false });
    getNavigationEnvelopeByToken.mockResolvedValue(envelope());
  });

  it("retains the frontend language when rebuilding Live after a route selection", async () => {
    connect.mockImplementation(async () => makeSession());
    const bridge = await createLiveBridge({
      ws: makeWs(),
      userId: "language-reconnect",
      language: "en",
    });
    try {
      await bridge.voiceReady;
      expect(
        await bridge.setRouteContext({ routeToken: "bus-token" }),
      ).toMatchObject({ ok: true });
      expect(connect).toHaveBeenCalledTimes(2);
      for (const [params] of connect.mock.calls) {
        expect(params.config.systemInstruction).toContain("Respond in English");
        expect(params.config.speechConfig).toBeUndefined();
      }
    } finally {
      bridge.close();
    }
  });

  it("passes language to navigation tools after Live reconnect without model language args", async () => {
    let callbacks: any;
    const session = makeSession();
    connect.mockImplementation(async (options) => {
      callbacks = options.callbacks;
      return session;
    });
    vi.mocked(executeLocalTool).mockResolvedValue(
      JSON.stringify({ ok: true, instructions: [] }),
    );
    const bridge = await createLiveBridge({
      ws: makeWs(),
      userId: "u",
      language: "en",
    });
    try {
      await bridge.voiceReady;
      await bridge.setRouteContext({ routeToken: "bus-token" });
      callbacks.onmessage({
        toolCall: {
          functionCalls: [
            { id: "directions", name: "getNavInstructions", args: {} },
          ],
        },
      });
      await vi.waitFor(() =>
        expect(executeLocalTool).toHaveBeenCalledWith(
          "getNavInstructions",
          {},
          undefined,
          "u",
          expect.objectContaining({ language: "en", routeToken: "bus-token" }),
        ),
      );
    } finally {
      bridge.close();
    }
  });

  it("emits full BUS geometry to UI before the matching token-free Live tool response", async () => {
    let callbacks: any;
    const session = makeSession();
    connect.mockImplementation(async (options) => {
      callbacks = options.callbacks;
      return session;
    });
    vi.mocked(executeLocalTool).mockResolvedValue(JSON.stringify(plan));
    const ws = makeWs();
    const bridge = await createLiveBridge({ ws, userId: "route-user" });
    await bridge.voiceReady;
    callbacks.onmessage({
      toolCall: {
        functionCalls: [
          {
            id: "provider-call",
            name: "planAccessibleRoute",
            args: { destination: "台中火車站" },
          },
        ],
      },
    });
    await vi.waitFor(() =>
      expect(session.sendToolResponse).toHaveBeenCalledTimes(1),
    );
    const events = frames(ws);
    const call = events.find((e) => e.type === "tool_call");
    const result = events.find((e) => e.type === "tool_result");
    expect(result).toMatchObject({
      callId: call.callId,
      turnId: call.turnId,
      result: plan,
    });
    const model = JSON.parse(
      session.sendToolResponse.mock.calls[0][0].functionResponses[0].response
        .output,
    );
    expect(model.routes[0].legs[0]).toMatchObject({
      type: "BUS",
      arrivalStop: "台中火車站",
    });
    expect(JSON.stringify(model)).not.toMatch(/polyline|routeToken|bus-token/);
    expect(vi.mocked(ws.send).mock.invocationCallOrder.at(-1)).toBeLessThan(
      session.sendToolResponse.mock.invocationCallOrder[0],
    );
    expect(
      await bridge.setRouteContext({ routeToken: "bus-token" }),
    ).toMatchObject({ ok: true, routeId: "bus-view" });
    expect(connect).toHaveBeenCalledTimes(1); // Default-selection echo keeps the explanation playing.
    bridge.close();
  });

  it("stops old audio/tools immediately and confirms only after the new session is ready, without changing navigation", async () => {
    const callbacks: any[] = [];
    const sessions = [makeSession(), makeSession()];
    const connecting = deferred<any>();
    connect.mockImplementation((options) => {
      callbacks.push(options.callbacks);
      return callbacks.length === 1
        ? Promise.resolve(sessions[0])
        : connecting.promise;
    });
    const pendingPlan = deferred<string>();
    vi.mocked(executeLocalTool).mockReturnValue(pendingPlan.promise);
    getRouteByToken.mockResolvedValue(walkRoute);
    const ws = makeWs();
    const bridge = await createLiveBridge({ ws, userId: "route-user" });
    await bridge.voiceReady;
    await bridge.armRouteToken("active-navigation-token");
    callbacks[0].onmessage({
      toolCall: {
        functionCalls: [{ id: "old-call", name: "planAccessibleRoute" }],
      },
    });
    await vi.waitFor(() => expect(executeLocalTool).toHaveBeenCalledTimes(1));
    const changed = bridge.setRouteContext({ routeToken: "bus-token" });
    let acknowledged = false;
    void changed.then(() => {
      acknowledged = true;
    });
    await vi.waitFor(() => expect(connect).toHaveBeenCalledTimes(2));
    expect(sessions[0].close).toHaveBeenCalledTimes(1);
    expect(acknowledged).toBe(false);
    pendingPlan.resolve(
      JSON.stringify({
        ...plan,
        selectedRouteId: "old",
        routes: [{ ...busRoute, routeId: "old" }],
      }),
    );
    callbacks[0].onmessage({
      serverContent: {
        modelTurn: {
          parts: [
            { inlineData: { data: Buffer.from("old").toString("base64") } },
          ],
        },
        outputTranscription: { text: "舊火車路線" },
      },
    });
    callbacks[0].onclose();
    connecting.resolve(sessions[1]);
    expect(await changed).toMatchObject({ ok: true, routeId: "bus-view" });
    await new Promise((resolve) => setImmediate(resolve));
    expect(
      frames(ws).some(
        (e) =>
          e.type === "tool_result" ||
          e.text === "舊火車路線" ||
          e.type === "nav.stop" ||
          e.type === "error",
      ),
    ).toBe(false);
    expect(
      vi.mocked(ws.send).mock.calls.some(([v]) => Buffer.isBuffer(v)),
    ).toBe(false);
    expect(String(connect.mock.calls[1][0].config.systemInstruction)).toContain(
      '"type":"BUS"',
    );
    expect(
      String(connect.mock.calls[1][0].config.systemInstruction),
    ).not.toContain("bus-token");
    bridge.startNavigation(); // The separately armed route survives selection changes.
    expect(frames(ws).some((e) => e.type === "nav.start")).toBe(true);
    bridge.close();
  });

  it("latest selection wins across overlapping token lookups and clear never replans", async () => {
    connect.mockResolvedValue(makeSession());
    const ws = makeWs();
    const bridge = await createLiveBridge({ ws, userId: "route-user" });
    await bridge.voiceReady;
    const slow = deferred<any>();
    getNavigationEnvelopeByToken.mockReturnValueOnce(slow.promise);
    const first = bridge.setRouteContext({ routeToken: "slow" });
    expect(await bridge.setRouteContext(null)).toEqual({
      ok: true,
      routeId: null,
      navigationId: null,
      routeVersion: null,
    });
    slow.resolve(envelope());
    expect(await first).toEqual({ ok: false, reason: "STALE_SELECTION" });
    expect(executeLocalTool).not.toHaveBeenCalled();
    bridge.close();
  });

  it("does not adopt a plan cancelled by provider interruption", async () => {
    let callbacks: any;
    const session = makeSession();
    connect.mockImplementation(async (options) => {
      callbacks = options.callbacks;
      return session;
    });
    const pending = deferred<string>();
    vi.mocked(executeLocalTool).mockReturnValueOnce(pending.promise);
    const ws = makeWs();
    const bridge = await createLiveBridge({ ws, userId: "route-user" });
    await bridge.voiceReady;
    callbacks.onmessage({
      toolCall: {
        functionCalls: [{ id: "cancelled", name: "planAccessibleRoute" }],
      },
    });
    await vi.waitFor(() => expect(executeLocalTool).toHaveBeenCalledTimes(1));
    callbacks.onmessage({
      serverContent: { interrupted: true },
      toolCallCancellation: { ids: ["cancelled"] },
    });
    pending.resolve(JSON.stringify(plan));
    await vi.waitFor(() =>
      expect(frames(ws).some((e) => e.type === "interrupted")).toBe(true),
    );
    callbacks.onmessage({
      toolCall: {
        functionCalls: [{ id: "follow-up", name: "getNavInstructions" }],
      },
    });
    await vi.waitFor(() =>
      expect(session.sendToolResponse).toHaveBeenCalledTimes(1),
    );
    expect(
      session.sendToolResponse.mock.calls[0][0].functionResponses[0].response
        .output,
    ).toContain("ROUTE_CONTEXT_REQUIRED");
    expect(
      frames(ws)
        .filter((e) => e.type === "tool_result")
        .map((e) => e.name),
    ).toEqual(["getNavInstructions"]);
    bridge.close();
  });

  it("fails the synchronization when reconnection fails, keeping the client socket open", async () => {
    connect
      .mockResolvedValueOnce(makeSession())
      .mockRejectedValueOnce(new Error("provider offline"));
    const ws = makeWs();
    const bridge = await createLiveBridge({ ws, userId: "route-user" });
    await bridge.voiceReady;
    expect(await bridge.setRouteContext({ routeToken: "bus-token" })).toEqual({
      ok: false,
      reason: "ROUTE_CONTEXT_UNAVAILABLE",
    });
    expect(ws.close).not.toHaveBeenCalled();
    bridge.close();
  });
});

it("bounds selection bootstrap including memory lookup and closes a provider session resolving after timeout", async () => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  getMemorySettings.mockResolvedValue({ memoryEnabled: false });
  const lateConnect = deferred<any>();
  connect
    .mockResolvedValueOnce(makeSession())
    .mockReturnValueOnce(lateConnect.promise);
  const ws = makeWs();
  const bridge = await createLiveBridge({ ws, userId: "bounded-route" });
  try {
    await bridge.voiceReady;
    const selecting = bridge.setRouteContext(null);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(await selecting).toEqual({
      ok: false,
      reason: "ROUTE_CONTEXT_UNAVAILABLE",
    });
    const lateSession = makeSession();
    lateConnect.resolve(lateSession);
    await vi.advanceTimersByTimeAsync(0);
    expect(lateSession.close).toHaveBeenCalledTimes(1);
    expect(ws.close).not.toHaveBeenCalled();
  } finally {
    bridge.close();
    vi.useRealTimers();
  }
});

it("a superseded bootstrap cannot overwrite the new session's memory permission", async () => {
  vi.clearAllMocks();
  const oldSettings = deferred<any>();
  getMemorySettings
    .mockReturnValueOnce(oldSettings.promise)
    .mockResolvedValueOnce({ memoryEnabled: false });
  let callbacks: any;
  const session = makeSession();
  connect.mockImplementation(async (options) => {
    callbacks = options.callbacks;
    return session;
  });
  const bridge = await createLiveBridge({
    ws: makeWs(),
    userId: "memory-race",
  });
  await vi.waitFor(() => expect(getMemorySettings).toHaveBeenCalledTimes(1));
  expect(await bridge.setRouteContext(null)).toMatchObject({ ok: true });
  oldSettings.resolve({ memoryEnabled: true });
  await bridge.voiceReady;
  vi.mocked(executeLocalTool).mockResolvedValue('{"ok":false}');
  callbacks.onmessage({
    toolCall: {
      functionCalls: [
        { id: "new-session", name: "saveMemory", args: { content: "example" } },
      ],
    },
  });
  await vi.waitFor(() => expect(executeLocalTool).toHaveBeenCalled());
  expect(vi.mocked(executeLocalTool).mock.calls[0][4]).toMatchObject({
    allowMemoryWrite: false,
  });
  expect(loadMemories).not.toHaveBeenCalled();
  bridge.close();
});

describe("voice planning with continuous microphone input", () => {
  it("keeps a second current-location plan and its retry valid despite untranscribed PCM", async () => {
    vi.clearAllMocks();
    getMemorySettings.mockResolvedValue({ memoryEnabled: false });
    let onmessage!: (message: unknown) => void;
    const session = makeSession();
    connect.mockImplementation(async ({ callbacks }) => {
      onmessage = callbacks.onmessage;
      return session;
    });
    const pending = deferred<string>();
    vi.mocked(executeLocalTool)
      .mockResolvedValueOnce(
        JSON.stringify({ ok: true, routes: [], selectedRouteId: null }),
      )
      .mockReturnValueOnce(pending.promise)
      .mockResolvedValue(
        JSON.stringify({ ok: true, routes: [], selectedRouteId: null }),
      );
    const bridge = await createLiveBridge({
      ws: makeWs(),
      userId: "continuous-pcm-planning",
      userLocation: { latitude: 24.1306588, longitude: 120.6373201 },
    });
    const request = (id: string, origin: string) =>
      onmessage({
        toolCall: {
          functionCalls: [
            {
              id,
              name: "planAccessibleRoute",
              args: { origin, destination: "臺中車站" },
            },
          ],
        },
      });
    try {
      await bridge.voiceReady;
      onmessage({
        serverContent: {
          inputTranscription: { text: "臺中高鐵站到臺中車站", finished: true },
        },
      });
      request("named-origin", "臺中高鐵站");
      await vi.waitFor(() =>
        expect(session.sendToolResponse).toHaveBeenCalledTimes(1),
      );
      onmessage({ serverContent: { turnComplete: true } });
      onmessage({
        serverContent: {
          inputTranscription: { text: "目前位置到臺中車站", finished: true },
        },
      });
      request("current-origin", "current_location");
      await vi.waitFor(() => expect(executeLocalTool).toHaveBeenCalledTimes(2));
      const pcm = Buffer.alloc(3200);
      for (let index = 0; index < pcm.length; index += 2)
        pcm.writeInt16LE(1000, index);
      for (let frame = 0; frame < 5; frame++) bridge.sendAudio(pcm);
      pending.resolve(
        JSON.stringify({ ok: true, routes: [], selectedRouteId: null }),
      );
      await vi.waitFor(() =>
        expect(session.sendToolResponse).toHaveBeenCalledTimes(2),
      );
      request("retry-current-origin", "current_location");
      await vi.waitFor(() =>
        expect(session.sendToolResponse).toHaveBeenCalledTimes(3),
      );
      const responses = session.sendToolResponse.mock.calls.map(([value]) =>
        JSON.parse(value.functionResponses[0].response.output),
      );
      expect(
        responses.map((result) => ({ ok: result.ok, reason: result.reason })),
      ).toEqual([{ ok: true }, { ok: true }, { ok: true }]);
      expect(executeLocalTool).toHaveBeenCalledTimes(3);
      expect(vi.mocked(executeLocalTool).mock.calls[1][2]).toEqual({
        latitude: 24.1306588,
        longitude: 120.6373201,
      });
    } finally {
      bridge.close();
    }
  });
});

describe("voice planning transcript completion", () => {
  it.each([
    {},
    { text: "" },
    { text: "   " },
    { finished: true },
    { text: "", finished: true },
  ])(
    "keeps an in-flight GPS plan current after a non-speech transcription frame %j",
    async (completion) => {
      vi.clearAllMocks();
      getMemorySettings.mockResolvedValue({ memoryEnabled: false });
      let onmessage!: (message: unknown) => void;
      const session = makeSession();
      connect.mockImplementation(async ({ callbacks }) => {
        onmessage = callbacks.onmessage;
        return session;
      });
      const pending = deferred<string>();
      vi.mocked(executeLocalTool).mockReturnValue(pending.promise);
      const ws = makeWs();
      const bridge = await createLiveBridge({
        ws,
        userId: "voice-location-regression",
        userLocation: { latitude: 24.1306588, longitude: 120.6373201 },
      });
      try {
        await bridge.voiceReady;
        onmessage({
          serverContent: { inputTranscription: { text: "我要到臺中車站" } },
        });
        onmessage({
          toolCall: {
            functionCalls: [
              {
                id: "gps-plan",
                name: "planAccessibleRoute",
                args: { origin: "current_location", destination: "臺中車站" },
              },
            ],
          },
        });
        await vi.waitFor(() => expect(executeLocalTool).toHaveBeenCalledOnce());
        onmessage({ serverContent: { inputTranscription: completion } });
        pending.resolve(
          JSON.stringify({ ok: true, routes: [], selectedRouteId: null }),
        );
        await vi.waitFor(() =>
          expect(session.sendToolResponse).toHaveBeenCalledOnce(),
        );
        expect(vi.mocked(executeLocalTool).mock.calls[0][2]).toEqual({
          latitude: 24.1306588,
          longitude: 120.6373201,
        });
        const response =
          session.sendToolResponse.mock.calls[0][0].functionResponses[0];
        expect(JSON.parse(response.response.output)).toMatchObject({
          ok: true,
        });
        const frames = vi
          .mocked(ws.send)
          .mock.calls.map(([value]) => value)
          .filter((value): value is string => typeof value === "string")
          .map((value) => JSON.parse(value));
        expect(
          frames.find((frame) => frame.type === "tool_result").result,
        ).toMatchObject({ ok: true });
        expect(
          frames.filter(
            (frame) =>
              frame.type === "transcript" &&
              frame.role === "user" &&
              frame.final,
          ),
        ).toHaveLength(1);
      } finally {
        bridge.close();
      }
    },
  );
});

describe("voice routing location recovery", () => {
  let onmessage: (message: unknown) => void;
  let onclose: () => void;
  let session: ReturnType<typeof makeSession>;
  let ws: WebSocket;
  const frames = () =>
    vi
      .mocked(ws.send)
      .mock.calls.map((call) => call[0])
      .filter((value): value is string => typeof value === "string")
      .map((value) => JSON.parse(value));
  const callRoute = () =>
    onmessage({
      toolCall: {
        functionCalls: [
          {
            id: "route",
            name: "planAccessibleRoute",
            args: { origin: "current_location", destination: "Station" },
          },
        ],
      },
    });
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    session = makeSession();
    ws = makeWs();
    connect.mockImplementation(async ({ callbacks }) => {
      onmessage = callbacks.onmessage;
      onclose = callbacks.onclose;
      return session;
    });
    vi.mocked(executeLocalTool).mockResolvedValue(
      JSON.stringify({
        ok: false,
        reason: "LOCATION_REQUIRED",
        error: "Please provide a starting point",
      }),
    );
  });
  afterEach(() => {
    vi.useRealTimers();
  });
  it("asks the app for missing GPS and uses its reply before planning, without starting navigation", async () => {
    const bridge = await createLiveBridge({ ws, userId: "fixture-user" });
    await bridge.voiceReady;
    callRoute();
    await vi.advanceTimersByTimeAsync(0);
    expect(frames()).toContainEqual({ type: "location.request" });
    expect(executeLocalTool).not.toHaveBeenCalled();
    bridge.updatePosition({ latitude: 24.15, longitude: 120.68 });
    await vi.advanceTimersByTimeAsync(0);
    expect(executeLocalTool).toHaveBeenCalledWith(
      "planAccessibleRoute",
      expect.anything(),
      { latitude: 24.15, longitude: 120.68 },
      "fixture-user",
      expect.anything(),
    );
    expect(frames().some((frame) => frame.type === "nav.start")).toBe(false);
    expect(ws.close).not.toHaveBeenCalled();
    bridge.close();
  });
  it("bounds the wait for a denied or unavailable fix and sends the failure back to the model without closing voice", async () => {
    const log = vi.spyOn(console, "log");
    const bridge = await createLiveBridge({ ws, userId: "fixture-user" });
    await bridge.voiceReady;
    callRoute();
    await vi.advanceTimersByTimeAsync(2001);
    expect(
      frames().find((frame) => frame.type === "tool_result").result.reason,
    ).toBe("LOCATION_REQUIRED");
    expect(session.sendToolResponse).toHaveBeenCalled();
    expect(session.close).not.toHaveBeenCalled();
    expect(ws.close).not.toHaveBeenCalled();
    const toolLog = log.mock.calls.find(([label]) => label === "[voice] tool");
    expect(JSON.parse(toolLog![1])).toEqual({
      tool: "planAccessibleRoute",
      ok: true,
      durationMs: 2000,
      hasLocation: false,
      resultOk: false,
      failureCode: "LOCATION_REQUIRED",
    });
    log.mockRestore();
    bridge.close();
  });
  it("continues the batch when only the location-dependent call is cancelled", async () => {
    const bridge = await createLiveBridge({ ws, userId: "fixture-user" });
    await bridge.voiceReady;
    onmessage({
      toolCall: {
        functionCalls: [
          {
            id: "route",
            name: "planAccessibleRoute",
            args: { origin: "current_location", destination: "Station" },
          },
          { id: "context", name: "getActiveNavigationContext", args: {} },
        ],
      },
    });
    await vi.advanceTimersByTimeAsync(0);
    onmessage({ toolCallCancellation: { ids: ["route"] } });
    bridge.updatePosition({ latitude: 24.15, longitude: 120.68 });
    await vi.advanceTimersByTimeAsync(0);
    expect(executeLocalTool).not.toHaveBeenCalled();
    expect(session.sendToolResponse).toHaveBeenCalledWith({
      functionResponses: [
        expect.objectContaining({
          id: "context",
          name: "getActiveNavigationContext",
        }),
      ],
    });
    bridge.close();
  });
  it("does not execute a waiting route after the provider becomes unavailable", async () => {
    const bridge = await createLiveBridge({ ws, userId: "fixture-user" });
    await bridge.voiceReady;
    callRoute();
    await vi.advanceTimersByTimeAsync(0);
    onclose();
    bridge.updatePosition({ latitude: 24.15, longitude: 120.68 });
    await vi.advanceTimersByTimeAsync(3000);
    expect(executeLocalTool).not.toHaveBeenCalled();
    expect(session.sendToolResponse).not.toHaveBeenCalled();
    expect(frames()).toContainEqual({
      type: "error",
      code: "LIVE_SESSION_ENDED",
    });
    bridge.close();
  });
  it("cancels an in-flight location request on close without executing its route", async () => {
    const bridge = await createLiveBridge({ ws, userId: "fixture-user" });
    await bridge.voiceReady;
    callRoute();
    await vi.advanceTimersByTimeAsync(0);
    expect(frames()).toContainEqual({ type: "location.request" });
    bridge.close();
    await vi.advanceTimersByTimeAsync(3000);
    expect(executeLocalTool).not.toHaveBeenCalled();
    expect(session.sendToolResponse).not.toHaveBeenCalled();
  });
});

/** Base64 PCM16 tone at 24 kHz that the output trimmer counts as speech. */
function farewell(ms: number): string {
  const buf = Buffer.alloc(ms * 48);
  for (let i = 0; i < ms * 24; i++)
    buf.writeInt16LE(
      Math.round(3000 * Math.sin((2 * Math.PI * 200 * i) / 24000)),
      i * 2,
    );
  return buf.toString("base64");
}

describe("Live model and assistant end", () => {
  let ws: WebSocket;
  let session: ReturnType<typeof makeSession>;
  let bridge: Awaited<ReturnType<typeof createLiveBridge>>;
  let onmessage: (message: any) => void;
  async function emit(message: any) {
    onmessage(message);
    // Drain the serialized server-message queue without advancing timers.
    for (let i = 0; i < 30; i++) await Promise.resolve();
  }
  async function end(text: string) {
    await emit({
      serverContent: { inputTranscription: { text, finished: true } },
    });
    await emit({
      toolCall: {
        functionCalls: [{ id: "end-1", name: "endVoiceSession", args: {} }],
      },
    });
  }
  function events() {
    return vi
      .mocked(ws.send)
      .mock.calls.filter((c) => typeof c[0] === "string")
      .map((c) => JSON.parse(c[0] as string));
  }
  function output() {
    return session.sendToolResponse.mock.calls.at(-1)?.[0]?.functionResponses[0]
      .response.output;
  }
  beforeEach(async () => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    getNavigationEnvelopeByToken.mockResolvedValue(null);
    session = makeSession();
    ws = makeWs();
    connect.mockImplementation(async ({ callbacks }) => {
      onmessage = callbacks.onmessage;
      return session;
    });
    bridge = await createLiveBridge({ ws, userId: "voice-end-user" });
    await bridge.voiceReady;
  });
  afterEach(() => {
    bridge?.close();
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });
  it("uses gemini-3.8-live without a thinking config and a Live-only end tool", () => {
    const args = connect.mock.calls[0][0];
    expect(args.model).toBe("gemini-3.8-live");
    expect(args.config).not.toHaveProperty("thinkingConfig");
    expect(
      args.config.tools
        .flatMap((t: any) => t.functionDeclarations ?? [])
        .map((t: any) => t.name),
    ).toContain("endVoiceSession");
  });
  it("biases input transcription toward Traditional Chinese and accessibility terms", () => {
    const config = connect.mock.calls[0][0].config;
    expect(config.inputAudioTranscription.languageCodes).toEqual([
      "zh-TW",
      "en-US",
    ]);
    expect(config.inputAudioTranscription.customVocabulary).toEqual(
      expect.arrayContaining([
        "無障礙智慧地圖",
        "無障礙",
        "低地板公車",
        "復康巴士",
        "導盲磚",
      ]),
    );
  });
  it("puts English first when the voice session language is English", async () => {
    bridge.close();
    connect.mockClear();
    bridge = await createLiveBridge({
      ws,
      userId: "voice-end-user",
      language: "en",
    });
    await bridge.voiceReady;
    expect(
      connect.mock.calls[0][0].config.inputAudioTranscription.languageCodes,
    ).toEqual(["en-US", "zh-TW"]);
  });
  it.each(["再見", "Bye-bye.", "謝謝你，拜拜。"])(
    "accepts %s, drains farewell playback, and preserves navigation",
    async (text) => {
      getRouteByToken.mockResolvedValueOnce(walkRoute);
      getNavigationEnvelopeByToken.mockResolvedValueOnce({
        navigationId: "end-nav",
        routeVersion: 1,
      });
      expect(await bridge.armRouteToken("walk-end")).toBe(true);
      bridge.startNavigation();
      await emit({
        serverContent: {
          turnComplete: true,
          interactionStatus: InteractionStatus.IDLE,
        },
      });
      const stored = storeNavigationSnapshot.mock.calls.length;
      expect(stored).toBeGreaterThan(0);
      await end(text);
      expect(events()).toContainEqual({
        type: "session.ending",
        reason: "assistant-end",
      });
      expect(output()).toContain('"ok":true');
      const eventCall = vi
        .mocked(ws.send)
        .mock.calls.findIndex(
          (c) => typeof c[0] === "string" && c[0].includes('"session.ending"'),
        );
      expect(
        vi.mocked(ws.send).mock.invocationCallOrder[eventCall],
      ).toBeLessThan(session.sendToolResponse.mock.invocationCallOrder[0]);
      expect(ws.close).not.toHaveBeenCalled();
      bridge.sendAudio(Buffer.alloc(20));
      expect(session.sendRealtimeInput).not.toHaveBeenCalled();
      await emit({
        serverContent: {
          modelTurn: {
            parts: [
              { inlineData: { data: Buffer.alloc(48000).toString("base64") } },
            ],
          },
          turnComplete: true,
          interactionStatus: InteractionStatus.IDLE,
        },
      });
      await vi.advanceTimersByTimeAsync(1749);
      expect(ws.close).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(ws.close).toHaveBeenCalledExactlyOnceWith(1000, "assistant-end");
      expect(deleteNavigationSnapshot).not.toHaveBeenCalled();
      expect(storeNavigationSnapshot.mock.calls.length).toBe(stored);
      expect(events().some((e) => e.type === "nav.stop")).toBe(false);
    },
  );
  it.each([
    "不要結束語音",
    "台中車站附近有什麼餐廳",
    "再見是什麼意思",
    "再見的英文怎麼說",
  ])(
    "delegates semantics to the model rather than classifying %s",
    async (text) => {
      await end(text);
      expect(output()).toContain('"ok":true');
      await vi.advanceTimersByTimeAsync(16000);
      expect(ws.close).toHaveBeenCalledExactlyOnceWith(1000, "assistant-end");
      expect(events().some((e) => e.type === "session.ending")).toBe(true);
    },
  );
  it.each([
    "可以結束語音嗎",
    "請幫我掛斷",
    "Bye-bye.",
    "謝謝你，拜拜。",
    "好的，那今天就先這樣，謝謝你，拜拜。",
  ])("accepts an explicit request %s", async (text) => {
    await end(text);
    expect(output()).toContain('"ok":true');
    expect(events()).toContainEqual({
      type: "session.ending",
      reason: "assistant-end",
    });
  });
  it("does not close on ordinary answer completion without an end tool", async () => {
    await emit({
      serverContent: {
        inputTranscription: { text: "找餐廳", finished: true },
        turnComplete: true,
        interactionStatus: InteractionStatus.IDLE,
      },
    });
    await vi.advanceTimersByTimeAsync(16000);
    expect(ws.close).not.toHaveBeenCalled();
  });
  it("trims the silent tail after an answer and drops its dot transcript", async () => {
    const silence = Buffer.alloc(48000).toString("base64");
    const audioFrames = () =>
      vi.mocked(ws.send).mock.calls.filter((c) => Buffer.isBuffer(c[0])).length;
    const modelText = () =>
      events()
        .filter((e) => e.type === "transcript" && e.role === "model")
        .map((e) => e.text);
    await emit({
      serverContent: {
        modelTurn: {
          parts: [
            { inlineData: { data: farewell(500) } },
            { inlineData: { data: silence } },
            ...Array.from({ length: 30 }, () => ({
              inlineData: { data: silence },
            })),
          ],
        },
        outputTranscription: { text: "我正在確認營業細節。" },
      },
    });
    await emit({
      serverContent: { outputTranscription: { text: ". . . . . . . ." } },
    });
    expect(audioFrames()).toBe(2);
    expect(modelText()).toEqual(["我正在確認營業細節。"]);
    await emit({
      serverContent: {
        modelTurn: { parts: [{ inlineData: { data: farewell(300) } }] },
      },
    });
    expect(audioFrames()).toBe(3);
    await emit({ serverContent: { turnComplete: true } });
    await emit({
      serverContent: {
        modelTurn: { parts: [{ inlineData: { data: silence } }] },
      },
    });
    expect(audioFrames()).toBe(4);
  });
  it("still forwards a user barge-in during a generated turn's playback wait", async () => {
    await emit({
      serverContent: {
        modelTurn: { parts: [{ inlineData: { data: farewell(500) } }] },
      },
    });
    await emit({ serverContent: { generationComplete: true } });
    await emit({ serverContent: { interrupted: true } });
    expect(events()).toContainEqual({ type: "interrupted" });
  });

  it("ignores stale model environment overrides and keeps the required Live model", async () => {
    bridge.close();
    vi.stubEnv("GEMINI_LIVE_MODEL", "legacy-live-model");
    connect.mockClear();
    bridge = await createLiveBridge({ ws, userId: "voice-end-user" });
    await bridge.voiceReady;
    expect(connect.mock.calls[0][0].model).toBe("gemini-3.8-live");
  });
  it("accepts a current model end decision after a new utterance starts", async () => {
    await emit({
      serverContent: { inputTranscription: { text: "再見", finished: true } },
    });
    await emit({
      serverContent: { inputTranscription: { text: "等一下找餐廳" } },
    });
    await emit({
      toolCall: {
        functionCalls: [{ id: "new", name: "endVoiceSession", args: {} }],
      },
    });
    expect(output()).toContain('"ok":true');
    await vi.advanceTimersByTimeAsync(16000);
    expect(ws.close).toHaveBeenCalledExactlyOnceWith(1000, "assistant-end");
  });
  it.each(["same batch", "reverse batch", "later call"])(
    "blocks stopNavigation after endVoiceSession in %s without deleting the snapshot",
    async (timing) => {
      getRouteByToken.mockResolvedValueOnce(walkRoute);
      getNavigationEnvelopeByToken.mockResolvedValueOnce({
        navigationId: "ending-guard-nav",
        routeVersion: 1,
      });
      expect(await bridge.armRouteToken("ending-guard-route")).toBe(true);
      bridge.startNavigation();
      await emit({
        serverContent: {
          turnComplete: true,
          interactionStatus: InteractionStatus.IDLE,
        },
      });
      expect(storeNavigationSnapshot).toHaveBeenCalled();
      await emit({
        serverContent: { inputTranscription: { text: "再見", finished: true } },
      });
      const endCall = { id: "end", name: "endVoiceSession", args: {} };
      const stopCall = { id: "stop", name: "stopNavigation", args: {} };
      await emit({
        toolCall: {
          functionCalls:
            timing === "same batch"
              ? [endCall, stopCall]
              : timing === "reverse batch"
                ? [stopCall, endCall]
                : [endCall],
        },
      });
      if (timing === "later call") {
        await emit({
          serverContent: {
            turnComplete: true,
            interactionStatus: InteractionStatus.IDLE,
          },
        });
        await vi.advanceTimersByTimeAsync(500);
        await emit({ toolCall: { functionCalls: [stopCall] } });
      }
      const responses = session.sendToolResponse.mock.calls.flatMap(
        ([payload]) => payload.functionResponses,
      );
      expect(
        responses.find((r: any) => r.id === "stop")?.response.output,
      ).toContain("VOICE_SESSION_ENDING");
      expect(
        JSON.parse(responses.find((r: any) => r.id === "end")!.response.output),
      ).toEqual({
        ok: true,
        message: "請只用一句簡短道別，不要再提問或提供其他資訊。",
      });
      expect(events().filter((e) => e.type === "session.ending")).toHaveLength(
        1,
      );
      expect(events().some((e) => e.type === "nav.stop")).toBe(false);
      expect(deleteNavigationSnapshot).not.toHaveBeenCalled();
      expect(ws.close).not.toHaveBeenCalled();
    },
  );
  it.each(["turn complete", "new audio"])(
    "accepts a current model end decision after %s without requiring a transcript",
    async (boundary) => {
      await emit({
        serverContent: { inputTranscription: { text: "再見", finished: true } },
      });
      await emit({
        serverContent: {
          turnComplete: true,
          interactionStatus: InteractionStatus.IDLE,
        },
      });
      if (boundary === "new audio") bridge.sendAudio(Buffer.alloc(20));
      await emit({
        toolCall: {
          functionCalls: [{ id: "stale", name: "endVoiceSession", args: {} }],
        },
      });
      expect(output()).toContain('"ok":true');
      await vi.advanceTimersByTimeAsync(16000);
      expect(ws.close).toHaveBeenCalledExactlyOnceWith(1000, "assistant-end");
    },
  );
  it("does not make audio a lexical end authorization boundary", async () => {
    await emit({
      serverContent: { inputTranscription: { text: "再見", finished: true } },
    });
    await emit({ serverContent: { modelTurn: { parts: [{ text: "好的" }] } } });
    bridge.sendAudio(Buffer.alloc(20));
    await emit({
      toolCall: {
        functionCalls: [{ id: "new-audio", name: "endVoiceSession", args: {} }],
      },
    });
    expect(output()).toContain('"ok":true');
    await vi.advanceTimersByTimeAsync(16000);
    expect(ws.close).toHaveBeenCalledExactlyOnceWith(1000, "assistant-end");
  });
  it.each(["audible PCM", "interrupted"])(
    "accepts a new model end call after %s without requiring ASR",
    async (boundary) => {
      bridge.sendAudio(Buffer.alloc(20));
      await emit({
        serverContent: { inputTranscription: { text: "再見", finished: true } },
      });
      if (boundary === "audible PCM") {
        const pcm = Buffer.alloc(21); // Odd trailing byte must not be read as PCM16.
        for (let i = 0; i + 1 < pcm.length; i += 2) pcm.writeInt16LE(1000, i);
        bridge.sendAudio(pcm);
      } else {
        await emit({ serverContent: { interrupted: true } });
      }
      await emit({
        toolCall: {
          functionCalls: [
            { id: "stale-input", name: "endVoiceSession", args: {} },
          ],
        },
      });
      expect(output()).toContain('"ok":true');
      await vi.advanceTimersByTimeAsync(16000);
      expect(ws.close).toHaveBeenCalledExactlyOnceWith(1000, "assistant-end");
      expect(events().some((e) => e.type === "session.ending")).toBe(true);
    },
  );
  it("keeps the current candidate across continuous USER_INPUT silence frames", async () => {
    bridge.sendAudio(Buffer.alloc(20));
    await emit({
      serverContent: { inputTranscription: { text: "再見", finished: true } },
    });
    bridge.sendAudio(Buffer.alloc(20));
    bridge.sendAudio(Buffer.alloc(20));
    await emit({
      toolCall: {
        functionCalls: [{ id: "valid", name: "endVoiceSession", args: {} }],
      },
    });
    expect(output()).toContain('"ok":true');
    expect(events()).toContainEqual({
      type: "session.ending",
      reason: "assistant-end",
    });
  });
  it.each(["end first", "stop first"])(
    "blocks narration tools including end pre-arm (%s)",
    async (order) => {
      getRouteByToken.mockResolvedValueOnce(walkRoute);
      getNavigationEnvelopeByToken.mockResolvedValueOnce({
        navigationId: "narration-nav",
        routeVersion: 1,
      });
      await bridge.armRouteToken("narration-token");
      bridge.updatePosition({ latitude: 25, longitude: 121 });
      bridge.startNavigation();
      expect(session.sendClientContent).toHaveBeenCalled();
      const endCall = {
        id: "narration-end",
        name: "endVoiceSession",
        args: {},
      };
      const stopCall = {
        id: "narration-stop",
        name: "stopNavigation",
        args: {},
      };
      await emit({
        toolCall: {
          functionCalls:
            order === "end first" ? [endCall, stopCall] : [stopCall, endCall],
        },
      });
      expect(
        events().some(
          (e) => e.type === "session.ending" || e.type === "nav.stop",
        ),
      ).toBe(false);
      expect(markNavigationStopped).not.toHaveBeenCalled();
      expect(JSON.stringify(session.sendToolResponse.mock.calls)).toContain(
        "navigation speech turn cannot execute tools",
      );
    },
  );
  it("rejects a queued end decision overtaken by real text before execution", async () => {
    onmessage({
      toolCall: {
        functionCalls: [{ id: "old-end", name: "endVoiceSession", args: {} }],
      },
    });
    onmessage({
      serverContent: { inputTranscription: { text: "等一下", finished: true } },
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(output()).toContain("STALE_SELECTION");
    expect(events().some((e) => e.type === "session.ending")).toBe(false);
  });
  it("waits for a post-tool farewell turn, not a tool-associated turnComplete", async () => {
    await emit({
      serverContent: { inputTranscription: { text: "再見", finished: true } },
    });
    await emit({
      serverContent: {
        turnComplete: true,
        interactionStatus: InteractionStatus.IDLE,
      },
      toolCall: {
        functionCalls: [{ id: "end", name: "endVoiceSession", args: {} }],
      },
    });
    await vi.advanceTimersByTimeAsync(8000);
    expect(ws.close).not.toHaveBeenCalled();
    await emit({
      serverContent: {
        turnComplete: true,
        interactionStatus: InteractionStatus.IDLE,
      },
    });
    await vi.advanceTimersByTimeAsync(1499);
    expect(ws.close).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(ws.close).toHaveBeenCalledExactlyOnceWith(1000, "assistant-end");
  });
  it("waits the full playback grace when farewell completes near the deadline", async () => {
    await end("再見");
    await vi.advanceTimersByTimeAsync(14000);
    await emit({
      serverContent: {
        modelTurn: {
          parts: [
            { inlineData: { data: Buffer.alloc(48000).toString("base64") } },
          ],
        },
        turnComplete: true,
        interactionStatus: InteractionStatus.IDLE,
      },
    });
    await vi.advanceTimersByTimeAsync(1749);
    expect(ws.close).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(ws.close).toHaveBeenCalledExactlyOnceWith(1000, "assistant-end");
  });
  it("does not start grace for IN_PROGRESS and waits full grace after IDLE", async () => {
    await end("再見");
    await emit({
      serverContent: {
        modelTurn: { parts: [{ inlineData: { data: farewell(500) } }] },
        turnComplete: true,
        interactionStatus: InteractionStatus.IN_PROGRESS,
      },
    });
    await vi.advanceTimersByTimeAsync(2000);
    expect(ws.close).not.toHaveBeenCalled();
    await emit({
      serverContent: {
        turnComplete: true,
        interactionStatus: InteractionStatus.IDLE,
      },
    });
    await vi.advanceTimersByTimeAsync(1499);
    expect(ws.close).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(ws.close).toHaveBeenCalledExactlyOnceWith(1000, "assistant-end");
  });
  it("starts grace when a turn without interactionStatus spoke the farewell", async () => {
    await end("再見");
    // gemini-3.8-live completes the tool turn before it speaks.
    await emit({ serverContent: { turnComplete: true } });
    await vi.advanceTimersByTimeAsync(2000);
    expect(ws.close).not.toHaveBeenCalled();
    await emit({
      serverContent: {
        modelTurn: { parts: [{ inlineData: { data: farewell(1000) } }] },
        turnComplete: true,
      },
    });
    await vi.advanceTimersByTimeAsync(1749);
    expect(ws.close).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(ws.close).toHaveBeenCalledExactlyOnceWith(1000, "assistant-end");
  });
  it("keeps the 15 second deadline for a silent turnComplete without interactionStatus", async () => {
    await end("再見");
    await emit({ serverContent: { turnComplete: true } });
    await vi.advanceTimersByTimeAsync(2000);
    expect(ws.close).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(12999);
    expect(ws.close).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(ws.close).toHaveBeenCalledExactlyOnceWith(1000, "assistant-end");
  });
  it("does not start grace for an interrupted IDLE turn", async () => {
    await end("再見");
    await emit({
      serverContent: {
        interrupted: true,
        turnComplete: true,
        interactionStatus: InteractionStatus.IDLE,
      },
    });
    await vi.advanceTimersByTimeAsync(2000);
    expect(ws.close).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(13000);
    expect(ws.close).toHaveBeenCalledExactlyOnceWith(1000, "assistant-end");
  });
  it("bounds an accepted end with no farewell turn to 15 seconds", async () => {
    await end("沒事了");
    await vi.advanceTimersByTimeAsync(14999);
    expect(ws.close).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(ws.close).toHaveBeenCalledExactlyOnceWith(1000, "assistant-end");
  });
  it("clears ending timers when the provider closes", async () => {
    await end("結束語音");
    connect.mock.calls[0][0].callbacks.onclose({});
    expect(ws.close).toHaveBeenCalledExactlyOnceWith(1000, "assistant-end");
    expect(vi.getTimerCount()).toBe(0);
  });
  it.each(["farewell", "deadline"])(
    "preserves the assistant-end %s timer on route context updates",
    async (boundary) => {
      await end("結束語音");
      if (boundary === "farewell")
        await emit({
          serverContent: {
            turnComplete: true,
            interactionStatus: InteractionStatus.IDLE,
          },
        });
      const timerCount = vi.getTimerCount();
      expect(await bridge.setRouteContext({ routeToken: "new-route" })).toEqual(
        {
          ok: false,
          reason: "ROUTE_CONTEXT_UNAVAILABLE",
        },
      );
      expect(ws.close).not.toHaveBeenCalled();
      expect(connect).toHaveBeenCalledOnce();
      expect(session.close).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(timerCount);
      await vi.advanceTimersByTimeAsync(boundary === "farewell" ? 1499 : 14999);
      expect(ws.close).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(ws.close).toHaveBeenCalledExactlyOnceWith(1000, "assistant-end");
    },
  );
  it("cleans assistant-end timers on bridge.close", async () => {
    await end("先這樣");
    expect(events().some((e) => e.type === "session.ending")).toBe(true);
    await emit({
      serverContent: {
        turnComplete: true,
        interactionStatus: InteractionStatus.IDLE,
      },
    });
    bridge.close();
    await vi.advanceTimersByTimeAsync(20000);
    expect(ws.close).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("candidate control server guards", () => {
  let onmessage: (m: any) => void;
  let ws: WebSocket;
  let session: ReturnType<typeof makeSession>;
  let bridge: Awaited<ReturnType<typeof createLiveBridge>>;
  const tokenRoute = {
    ...walkRoute,
    navigationId: "direct-nav",
    routeVersion: 1,
    routeToken: "first-token",
  };
  const envelope = {
    schemaVersion: 1,
    navigationId: "direct-nav",
    routeVersion: 1,
    route: tokenRoute,
    canonicalRequest: { requireElevator: true },
  };
  const messages = () =>
    vi
      .mocked(ws.send)
      .mock.calls.filter((c) => typeof c[0] === "string")
      .map((c) => JSON.parse(c[0] as string));
  const utter = (text: string) =>
    onmessage({
      serverContent: { inputTranscription: { text, finished: true } },
    });
  const tool = (
    name: string,
    args: Parameters<AgentToolExecutor>[1] = name === "planAccessibleRoute"
      ? { startNavigation: true }
      : {},
  ) =>
    onmessage({
      toolCall: {
        functionCalls: [{ id: Math.random().toString(), name, args }],
      },
    });
  const settle = async () => {
    await vi.waitFor(() => expect(session.sendToolResponse).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 0));
  };
  beforeEach(async () => {
    vi.clearAllMocks();
    session = makeSession();
    ws = makeWs();
    connect.mockImplementation(async ({ callbacks }) => {
      onmessage = callbacks.onmessage;
      return session;
    });
    readNavigationTokenStrict.mockResolvedValue({
      status: "ok",
      value: envelope,
    });
    vi.mocked(executeLocalTool).mockResolvedValue(
      JSON.stringify({
        ok: true,
        routes: [
          tokenRoute,
          { ...tokenRoute, routeId: "r2", routeToken: "second-token" },
        ],
      }),
    );
    bridge = await createLiveBridge({ ws, userId: "u" });
    await bridge.voiceReady;
  });
  afterEach(() => bridge.close());
  it("direct plans emit tool_result before real nav.start before model response, same-token echo is inert", async () => {
    const order: string[] = [];
    vi.mocked(ws.send).mockImplementation(((raw: any) => {
      if (typeof raw === "string") order.push(JSON.parse(raw).type);
    }) as any);
    session.sendToolResponse.mockImplementation(() => order.push("model"));
    utter("帶我去醫院");
    tool("planAccessibleRoute");
    await settle();
    expect(order.indexOf("tool_result")).toBeLessThan(
      order.indexOf("nav.start"),
    );
    expect(order.indexOf("nav.start")).toBeLessThan(order.indexOf("model"));
    expect(JSON.stringify(session.sendToolResponse.mock.calls)).toContain(
      "navigationStarted",
    );
    expect(await bridge.armRouteToken("first-token")).toBe(true);
    expect(getRouteByToken).not.toHaveBeenCalled();
  });
  it("resumes an unpublished ADOPTED next version by replacing before resume_ok", async () => {
    const nextRoute = {
      ...tokenRoute,
      routeVersion: 2,
      routeToken: "adopted-token",
    };
    const snapshot = {
      navigationId: "direct-nav",
      userId: "u",
      routeVersion: 2,
      routeToken: "adopted-token",
      currentStepIndex: 0,
      onVehicle: false,
      latestPosition: null,
      updatedAt: Date.now(),
    };
    getNavigationSnapshot.mockResolvedValue(snapshot);
    getRouteByToken.mockResolvedValue(nextRoute);
    getNavigationEnvelopeByToken.mockResolvedValue({
      ...envelope,
      routeVersion: 2,
      route: nextRoute,
    });
    getAdoptedCandidateReplacement.mockResolvedValue({
      navigationId: "direct-nav",
      previousRouteVersion: 1,
      routeVersion: 2,
      routeToken: "adopted-token",
      route: nextRoute,
      steps: [],
      instructions: [],
      warnings: [],
      currentStepIndex: 0,
      replayed: false,
    });
    await bridge.resumeNavigation({
      type: "nav.resume",
      navigationId: "direct-nav",
      routeVersion: 1,
      routeToken: "first-token",
      lastKnownStepIndex: 0,
    });
    const events = messages();
    expect(
      events
        .filter(
          (m) => m.type === "nav.route_replaced" || m.type === "nav.resume_ok",
        )
        .map((m) => m.type),
    ).toEqual(["nav.route_replaced", "nav.resume_ok"]);
    expect(events.find((m) => m.type === "nav.route_replaced")).toMatchObject({
      previousRouteVersion: 1,
      routeVersion: 2,
      routeToken: "adopted-token",
      route: nextRoute,
    });
    expect(
      events.find((m) => m.type === "nav.route_replaced").steps.length,
    ).toBeGreaterThan(0);
    expect(getAdoptedCandidateReplacement).toHaveBeenCalledWith(
      snapshot,
      "first-token",
      1,
    );
  });
  it.each(["pending", "version jump"])(
    "fails closed for an unproven resume mismatch: %s",
    async (kind) => {
      getNavigationSnapshot.mockResolvedValue({
        navigationId: "direct-nav",
        userId: "u",
        routeVersion: kind === "pending" ? 2 : 3,
        routeToken: "new-token",
        currentStepIndex: 0,
        onVehicle: false,
        latestPosition: null,
        updatedAt: Date.now(),
      });
      getAdoptedCandidateReplacement.mockResolvedValue(null);
      await bridge.resumeNavigation({
        type: "nav.resume",
        navigationId: "direct-nav",
        routeVersion: 1,
        routeToken: "first-token",
        lastKnownStepIndex: 0,
      });
      expect(
        messages().some(
          (m) => m.type === "nav.route_replaced" || m.type === "nav.resume_ok",
        ),
      ).toBe(false);
      expect(messages().find((m) => m.type === "nav.resume_failed").code).toBe(
        "ROUTE_VERSION_MISMATCH",
      );
    },
  );
  it("the same direct tool call ID can auto-start at most once", async () => {
    utter("導航到醫院");
    const call = {
      id: "single-direct-action",
      name: "planAccessibleRoute",
      args: { startNavigation: true },
    };
    onmessage({ toolCall: { functionCalls: [call] } });
    await settle();
    session.sendToolResponse.mockClear();
    onmessage({ toolCall: { functionCalls: [{ ...call }] } });
    await settle();
    expect(messages().filter((m) => m.type === "nav.start")).toHaveLength(1);
    expect(executeLocalTool).toHaveBeenCalledOnce();
    expect(JSON.stringify(session.sendToolResponse.mock.calls)).toContain(
      "DUPLICATE_TOOL_CALL",
    );
  });
  it("untranscribed PCM does not prevent direct navigation or candidate registry installation", async () => {
    const pending = deferred<string>();
    vi.mocked(executeLocalTool).mockReturnValueOnce(pending.promise);
    utter("帶我去醫院");
    tool("planAccessibleRoute");
    await vi.waitFor(() => expect(executeLocalTool).toHaveBeenCalledOnce());
    const pcm = Buffer.alloc(3200);
    for (let index = 0; index < pcm.length; index += 2)
      pcm.writeInt16LE(1000, index);
    bridge.sendAudio(pcm);
    pending.resolve(
      JSON.stringify({
        ok: true,
        routes: [
          tokenRoute,
          { ...tokenRoute, routeId: "r2", routeToken: "second-token" },
        ],
      }),
    );
    await settle();
    expect(
      messages().find((message) => message.type === "tool_result").result,
    ).toMatchObject({ ok: true });
    expect(messages().some((message) => message.type === "nav.start")).toBe(
      true,
    );
    expect(readNavigationTokenStrict).toHaveBeenCalledOnce();
    expect(
      messages().filter((message) => message.type === "nav.start"),
    ).toHaveLength(1);
    session.sendToolResponse.mockClear();
    utter("換第二條");
    tool("proposeNavigationCandidate", { candidateNumber: 2 });
    await settle();
    expect(
      JSON.parse(
        session.sendToolResponse.mock.calls[0][0].functionResponses[0].response
          .output,
      ),
    ).toMatchObject({ ok: true, candidateNumber: 2 });
  });

  it("a plan overtaken by UI selection cannot install its candidate registry", async () => {
    const pending = deferred<any>();
    vi.mocked(executeLocalTool).mockReturnValueOnce(pending.promise);
    utter("有哪些路線");
    tool("planAccessibleRoute");
    await vi.waitFor(() => expect(executeLocalTool).toHaveBeenCalled());
    getRouteByToken.mockResolvedValue(tokenRoute);
    getNavigationEnvelopeByToken.mockResolvedValue(envelope);
    await bridge.armRouteToken("ui-token");
    pending.resolve(
      JSON.stringify({
        ok: true,
        routes: [
          tokenRoute,
          { ...tokenRoute, routeToken: "second-token", routeId: "r2" },
        ],
      }),
    );
    await settle();
    session.sendToolResponse.mockClear();
    utter("換第二條");
    tool("proposeNavigationCandidate", { candidateNumber: 2 });
    await settle();
    expect(JSON.stringify(session.sendToolResponse.mock.calls)).toContain(
      "CANDIDATE_UNAVAILABLE",
    );
  });
  it("UI arming updates used candidates and excludes its active token", async () => {
    utter("有哪些路線");
    tool("planAccessibleRoute");
    await settle();
    getRouteByToken.mockResolvedValue({
      ...tokenRoute,
      routeToken: "second-token",
    });
    getNavigationEnvelopeByToken.mockResolvedValue(envelope);
    await bridge.armRouteToken("second-token");
    session.sendToolResponse.mockClear();
    utter("換第二條");
    tool("proposeNavigationCandidate", { candidateNumber: 2 });
    await settle();
    expect(JSON.stringify(session.sendToolResponse.mock.calls)).toContain(
      "CANDIDATE_UNAVAILABLE",
    );
  });
  it.each(["interrupted", "tool cancellation"])(
    "invalidates a pending plan on %s despite allowing untranscribed PCM",
    async (boundary) => {
      const pending = deferred<string>();
      vi.mocked(executeLocalTool).mockReturnValueOnce(pending.promise);
      utter("目前位置到臺中車站");
      onmessage({
        toolCall: {
          functionCalls: [
            { id: "cancel-planning", name: "planAccessibleRoute", args: {} },
          ],
        },
      });
      await vi.waitFor(() => expect(executeLocalTool).toHaveBeenCalledOnce());
      const options: Parameters<AgentToolExecutor>[4] =
        vi.mocked(executeLocalTool).mock.calls[0][4];
      expect(options?.isCurrent?.()).toBe(true);
      onmessage(
        boundary === "interrupted"
          ? { serverContent: { interrupted: true } }
          : { toolCallCancellation: { ids: ["cancel-planning"] } },
      );
      expect(options?.isCurrent?.()).toBe(false);
      pending.resolve(JSON.stringify({ ok: true, routes: [tokenRoute] }));
      onmessage({
        toolCall: {
          functionCalls: [
            {
              id: "queue-barrier",
              name: "getActiveNavigationContext",
              args: {},
            },
          ],
        },
      });
      await vi.waitFor(() =>
        expect(
          messages().some(
            (message) =>
              message.type === "tool_result" &&
              message.name === "getActiveNavigationContext",
          ),
        ).toBe(true),
      );
      expect(
        messages().some(
          (message) =>
            message.type === "tool_result" &&
            message.name === "planAccessibleRoute" &&
            message.result?.ok === true,
        ),
      ).toBe(false);
      expect(messages().some((message) => message.type === "nav.start")).toBe(
        false,
      );
    },
  );

  it("executor isCurrent expires as soon as a newer transcript arrives", async () => {
    const pending = deferred<any>();
    vi.mocked(executeLocalTool).mockReturnValueOnce(pending.promise);
    utter("導航到醫院");
    tool("planAccessibleRoute");
    await vi.waitFor(() => expect(executeLocalTool).toHaveBeenCalled());
    const context: Parameters<AgentToolExecutor>[4] =
      vi.mocked(executeLocalTool).mock.calls[0][4];
    expect(context?.isCurrent?.()).toBe(true);
    utter("比較路線");
    expect(context?.isCurrent?.()).toBe(false);
    pending.resolve(JSON.stringify({ ok: true, routes: [tokenRoute] }));
    await settle();
    expect(messages().some((m) => m.type === "nav.start")).toBe(false);
  });
  it("a newer utterance during client location wait prevents planner execution", async () => {
    utter("導航到醫院");
    tool("planAccessibleRoute", { origin: "current_location" });
    await vi.waitFor(() =>
      expect(messages().some((m) => m.type === "location.request")).toBe(true),
    );
    utter("比較路線");
    bridge.updatePosition({ latitude: 25, longitude: 121 });
    await settle();
    expect(executeLocalTool).not.toHaveBeenCalled();
  });
  it("publishes ADOPTED when a new utterance arrives during durable adoption", async () => {
    utter("導航到醫院");
    tool("planAccessibleRoute");
    await settle();
    session.sendToolResponse.mockClear();
    utter("換第二條");
    tool("proposeNavigationCandidate", { candidateNumber: 2 });
    await settle();
    const proposal = JSON.parse(
      session.sendToolResponse.mock.calls[0][0].functionResponses[0].response
        .output,
    );
    switchNavigationCandidate.mockImplementationOnce(async (input) => {
      const route = {
        ...tokenRoute,
        routeToken: "replacement",
        routeVersion: 2,
      };
      const data = {
        navigationId: "direct-nav",
        previousRouteVersion: 1,
        routeVersion: 2,
        routeToken: "replacement",
        route,
        steps: [],
        instructions: [],
        warnings: [],
        currentStepIndex: 0,
        replayed: false,
      };
      expect(input.prepare(data, { ...envelope, route, routeVersion: 2 })).toBe(
        true,
      );
      expect(input.isAuthorized()).toBe(true);
      utter("下一個問題");
      expect(input.isAuthorized()).toBe(false);
      expect(input.isNavigationCurrent()).toBe(true);
      input.adopt(data, { ...envelope, route, routeVersion: 2 });
      return { status: "adopted", data };
    });
    session.sendToolResponse.mockClear();
    tool("confirmNavigationCandidateSwitch", {
      proposalId: proposal.proposalId,
    });
    await settle();
    expect(
      messages().filter((m) => m.type === "nav.route_replaced"),
    ).toHaveLength(1);
  });
  it("retries a deferred off-route reroute after reconciliation rolls back", async () => {
    utter("導航到醫院");
    tool("planAccessibleRoute");
    await settle();
    session.sendToolResponse.mockClear();

    utter("換第二條");
    tool("proposeNavigationCandidate", { candidateNumber: 2 });
    await settle();
    const proposed = JSON.parse(
      session.sendToolResponse.mock.calls[0][0].functionResponses[0].response
        .output,
    );

    let reconciled: ((status: string) => void) | undefined;
    switchNavigationCandidate.mockImplementationOnce(async (input) => {
      reconciled = input.onReconciled;
      return {
        status: "reconciling",
        reason: "NAVIGATION_STATE_RECONCILING",
      };
    });
    session.sendToolResponse.mockClear();
    tool("confirmNavigationCandidateSwitch", {
      proposalId: proposed.proposalId,
    });
    await settle();

    vi.useFakeTimers();
    try {
      const far = { latitude: 26, longitude: 122 };
      for (let index = 0; index < 3; index++) {
        bridge.updatePosition(far);
        await vi.advanceTimersByTimeAsync(500);
      }
      expect(
        messages().some((message) => message.type === "nav.offroute"),
      ).toBe(true);
      expect(rerouteAccessibleRoute).not.toHaveBeenCalled();
      expect(reconciled).toBeTypeOf("function");

      reconciled?.("ROLLED_BACK");
      await vi.advanceTimersByTimeAsync(0);
      expect(rerouteAccessibleRoute).toHaveBeenCalledWith(
        expect.objectContaining({ reason: "OFF_ROUTE", currentPosition: far }),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("missing comparison metrics and accessibility evidence are explicit null", async () => {
    vi.mocked(executeLocalTool).mockResolvedValue(
      JSON.stringify({
        ok: true,
        routes: [
          tokenRoute,
          {
            ...tokenRoute,
            routeId: "r2",
            routeToken: "second-token",
            totalMinutes: undefined,
            transferCount: undefined,
            accessibilityHighlights: undefined,
          },
        ],
      }),
    );
    utter("導航到醫院");
    tool("planAccessibleRoute");
    await settle();
    session.sendToolResponse.mockClear();
    utter("換第二條");
    tool("proposeNavigationCandidate", { candidateNumber: 2 });
    await settle();
    const output = JSON.parse(
      session.sendToolResponse.mock.calls[0][0].functionResponses[0].response
        .output,
    );
    expect(output).toMatchObject({
      totalMinutes: null,
      transferCount: null,
      accessibilityHighlights: null,
      difference: {
        minutes: null,
        transfers: null,
        accessibility: { current: [], candidate: null },
      },
    });
  });
  it("planning-only requests do not arm a route for a later start call", async () => {
    utter("怎麼去醫院");
    tool("planAccessibleRoute", { startNavigation: false });
    tool("startNavigation");
    await settle();
    expect(messages().some((m) => m.type === "nav.start")).toBe(false);
  });
  it("first token missing never selects second", async () => {
    vi.mocked(executeLocalTool).mockResolvedValue(
      JSON.stringify({
        ok: true,
        routes: [
          { ...tokenRoute, routeToken: undefined },
          { ...tokenRoute, routeToken: "second" },
        ],
      }),
    );
    utter("導航到醫院");
    tool("planAccessibleRoute");
    await settle();
    expect(readNavigationTokenStrict).not.toHaveBeenCalled();
    expect(messages().some((m) => m.type === "nav.start")).toBe(false);
    expect(JSON.stringify(session.sendToolResponse.mock.calls)).toContain(
      "navigationStarted",
    );
  });
  it("queued older transcript cannot authorize after newer transcript arrival", async () => {
    utter("導航到醫院");
    tool("planAccessibleRoute");
    utter("比較路線");
    await settle();
    expect(messages().some((m) => m.type === "nav.start")).toBe(false);
  });
  it("late canonical read loses to UI cancel", async () => {
    const pending = deferred<any>();
    readNavigationTokenStrict.mockReturnValue(pending.promise);
    utter("導航到醫院");
    tool("planAccessibleRoute");
    await vi.waitFor(() =>
      expect(readNavigationTokenStrict).toHaveBeenCalled(),
    );
    bridge.cancelNav();
    pending.resolve({ status: "ok", value: envelope });
    await settle();
    expect(messages().some((m) => m.type === "nav.start")).toBe(false);
  });
  it("can propose another available route without requiring a candidate number", async () => {
    tool("planAccessibleRoute");
    await settle();
    session.sendToolResponse.mockClear();
    utter("這條不適合我，換個方案吧");
    tool("proposeNavigationCandidate", {});
    await settle();
    const proposal = JSON.parse(
      session.sendToolResponse.mock.calls[0][0].functionResponses[0].response
        .output,
    );
    expect(proposal).toMatchObject({
      ok: true,
      candidateNumber: 2,
      proposalId: expect.any(String),
    });
    expect(switchNavigationCandidate).not.toHaveBeenCalled();
  });
  it("proposal does not mutate; same-user-turn model confirmation commits once", async () => {
    utter("導航到醫院");
    tool("planAccessibleRoute");
    await settle();
    session.sendToolResponse.mockClear();
    utter("換第二條");
    tool("proposeNavigationCandidate", { candidateNumber: 2 });
    await settle();
    expect(switchNavigationCandidate).not.toHaveBeenCalled();
    const outputs = session.sendToolResponse.mock.calls.flatMap(
      (c) => c[0].functionResponses,
    );
    const proposal = JSON.parse(outputs[0].response.output as string);
    expect(proposal.proposalId).toEqual(expect.any(String));
    expect(JSON.stringify(outputs)).not.toContain("second-token");
    switchNavigationCandidate.mockResolvedValue({
      status: "failed",
      reason: "fixture",
    });
    tool("confirmNavigationCandidateSwitch", {
      proposalId: proposal.proposalId,
    });
    tool("confirmNavigationCandidateSwitch", {
      proposalId: proposal.proposalId,
    });
    await vi.waitFor(() =>
      expect(switchNavigationCandidate).toHaveBeenCalledTimes(1),
    );
  });
  it("Live schema is extended without mutating the actual shared catalogue", async () => {
    const catalog = await vi.importActual<
      typeof import("../agent/tool-catalog")
    >("../agent/tool-catalog");
    const shared = catalog.buildGeminiTools("u", false);
    const original = JSON.stringify(shared);
    vi.mocked(buildGeminiTools).mockReturnValueOnce(shared);
    bridge.close();
    bridge = await createLiveBridge({ ws, userId: "u" });
    await bridge.voiceReady;
    const config = connect.mock.calls.at(-1)![0].config;
    const declaration = config.tools
      .flatMap((t: any) => t.functionDeclarations ?? [])
      .find((d: any) => d.name === "planAccessibleRoute");
    expect(
      declaration.parametersJsonSchema.properties.startNavigation,
    ).toMatchObject({ type: "boolean", default: false });
    expect(JSON.stringify(shared)).toBe(original);
    expect(original).not.toContain('"startNavigation"');
  });
  it("keeps a proposal through intervening conversation and more than 120 seconds", async () => {
    tool("planAccessibleRoute");
    await settle();
    session.sendToolResponse.mockClear();
    tool("proposeNavigationCandidate", { candidateNumber: 2 });
    await settle();
    const { proposalId } = JSON.parse(
      session.sendToolResponse.mock.calls[0][0].functionResponses[0].response
        .output,
    );
    utter("這段路的景色怎麼樣？");
    await new Promise((r) => setTimeout(r, 0));
    const clock = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 180_000);
    try {
      switchNavigationCandidate.mockResolvedValueOnce({
        status: "failed",
        reason: "fixture",
      });
      session.sendToolResponse.mockClear();
      tool("confirmNavigationCandidateSwitch", { proposalId });
      await settle();
      expect(switchNavigationCandidate).toHaveBeenCalledOnce();
    } finally {
      clock.mockRestore();
    }
  });
  it.each(["new text", "tool cancellation"])(
    "invalidates in-flight switch on %s",
    async (boundary) => {
      tool("planAccessibleRoute");
      await settle();
      session.sendToolResponse.mockClear();
      tool("proposeNavigationCandidate", { candidateNumber: 2 });
      await settle();
      const { proposalId } = JSON.parse(
        session.sendToolResponse.mock.calls[0][0].functionResponses[0].response
          .output,
      );
      const pending = deferred<any>();
      switchNavigationCandidate.mockReturnValueOnce(pending.promise);
      onmessage({
        toolCall: {
          functionCalls: [
            {
              id: "pending-switch",
              name: "confirmNavigationCandidateSwitch",
              args: { proposalId },
            },
          ],
        },
      });
      await vi.waitFor(() =>
        expect(switchNavigationCandidate).toHaveBeenCalledOnce(),
      );
      const input = switchNavigationCandidate.mock.calls[0][0];
      expect(input.isAuthorized()).toBe(true);
      if (boundary === "new text") utter("先不要動");
      else onmessage({ toolCallCancellation: { ids: ["pending-switch"] } });
      expect(input.isAuthorized()).toBe(false);
      pending.resolve({ status: "failed", reason: "STALE_SELECTION" });
      await new Promise((r) => setTimeout(r, 0));
      expect(messages().some((m) => m.type === "nav.route_replaced")).toBe(
        false,
      );
    },
  );
  it.each(["new text", "tool cancellation"])(
    "finishes a committed stop locally despite %s while persistence settles",
    async (boundary) => {
      tool("planAccessibleRoute");
      await settle();
      onmessage({ serverContent: { turnComplete: true } });
      const persistedStop = deferred<string>();
      markNavigationStopped.mockReturnValueOnce(persistedStop.promise);
      onmessage({
        toolCall: {
          functionCalls: [
            { id: "committing-stop", name: "stopNavigation", args: {} },
          ],
        },
      });
      await vi.waitFor(() =>
        expect(markNavigationStopped).toHaveBeenCalledWith("direct-nav", "u"),
      );
      expect(messages().some((m) => m.type === "nav.stop")).toBe(false);
      if (boundary === "new text") utter("謝謝，順便告訴我天氣");
      else onmessage({ toolCallCancellation: { ids: ["committing-stop"] } });
      persistedStop.resolve("stopped");
      await vi.waitFor(() =>
        expect(messages().filter((m) => m.type === "nav.stop")).toHaveLength(1),
      );
      tool("getActiveNavigationContext", {});
      await vi.waitFor(() => {
        const result = messages().find(
          (m) =>
            m.type === "tool_result" && m.name === "getActiveNavigationContext",
        );
        expect(result?.result).toMatchObject({ active: false });
      });
    },
  );
  it.each([
    "lookup fails before stop",
    "lookup fails after stop",
    "lookup succeeds after stop",
  ])(
    "settles the stopped route while an uncommitted selection changes: %s",
    async (boundary) => {
      tool("planAccessibleRoute");
      await settle();
      onmessage({ serverContent: { turnComplete: true } });
      const persistedStop = deferred<string>();
      markNavigationStopped.mockReturnValueOnce(persistedStop.promise);
      onmessage({
        toolCall: {
          functionCalls: [
            { id: "stop-before-selection", name: "stopNavigation", args: {} },
          ],
        },
      });
      await vi.waitFor(() =>
        expect(markNavigationStopped).toHaveBeenCalledWith("direct-nav", "u"),
      );
      const lookup = deferred<any>();
      const selectedRoute = {
        ...tokenRoute,
        routeId: "selected-route",
        navigationId: "selected-nav",
        routeToken: "selected-token",
      };
      getRouteByToken.mockReturnValueOnce(lookup.promise);
      getNavigationEnvelopeByToken.mockResolvedValueOnce({
        ...envelope,
        navigationId: "selected-nav",
        route: selectedRoute,
      });
      const selection = bridge.armRouteToken("selected-token").then(
        (armed) => ({ armed }),
        (error: Error) => ({ error: error.message }),
      );
      if (boundary === "lookup fails before stop") {
        lookup.reject(new Error("route lookup unavailable"));
        expect(await selection).toEqual({ error: "route lookup unavailable" });
      }
      persistedStop.resolve("stopped");
      await vi.waitFor(() =>
        expect(messages().filter((m) => m.type === "nav.stop")).toHaveLength(1),
      );
      if (boundary === "lookup fails after stop") {
        lookup.reject(new Error("route lookup unavailable"));
        expect(await selection).toEqual({ error: "route lookup unavailable" });
      } else if (boundary === "lookup succeeds after stop") {
        lookup.resolve(selectedRoute);
        expect(await selection).toEqual({ armed: true });
        bridge.startNavigation();
        onmessage({ serverContent: { turnComplete: true } });
      }
      tool("getActiveNavigationContext", {});
      await vi.waitFor(() => {
        const result = messages().find(
          (m) =>
            m.type === "tool_result" && m.name === "getActiveNavigationContext",
        );
        expect(result?.result).toMatchObject({
          active: boundary === "lookup succeeds after stop",
        });
      });
    },
  );
  it("does not stop a newer route when an older durable stop finishes", async () => {
    tool("planAccessibleRoute");
    await settle();
    onmessage({ serverContent: { turnComplete: true } });
    const persistedStop = deferred<string>();
    markNavigationStopped.mockReturnValueOnce(persistedStop.promise);
    onmessage({
      toolCall: {
        functionCalls: [
          { id: "old-route-stop", name: "stopNavigation", args: {} },
        ],
      },
    });
    await vi.waitFor(() =>
      expect(markNavigationStopped).toHaveBeenCalledWith("direct-nav", "u"),
    );
    const newerRoute = {
      ...tokenRoute,
      routeId: "newer-route",
      navigationId: "newer-nav",
      routeToken: "newer-token",
    };
    getRouteByToken.mockResolvedValueOnce(newerRoute);
    getNavigationEnvelopeByToken.mockResolvedValueOnce({
      ...envelope,
      navigationId: "newer-nav",
      route: newerRoute,
    });
    expect(await bridge.armRouteToken("newer-token")).toBe(true);
    bridge.startNavigation();
    const responsesBefore = session.sendToolResponse.mock.calls.length;
    persistedStop.resolve("stopped");
    await vi.waitFor(() =>
      expect(session.sendToolResponse.mock.calls.length).toBeGreaterThan(
        responsesBefore,
      ),
    );
    expect(messages().some((m) => m.type === "nav.stop")).toBe(false);
    onmessage({ serverContent: { turnComplete: true } });
    tool("getActiveNavigationContext", {});
    await vi.waitFor(() => {
      const result = messages().find(
        (m) =>
          m.type === "tool_result" && m.name === "getActiveNavigationContext",
      );
      expect(result?.result).toMatchObject({ active: true });
    });
  });
  it.each(["new text", "tool cancellation"])(
    "prevents direct start after a late canonical read on %s",
    async (boundary) => {
      const pending = deferred<any>();
      readNavigationTokenStrict.mockReturnValueOnce(pending.promise);
      onmessage({
        toolCall: {
          functionCalls: [
            {
              id: "pending-direct",
              name: "planAccessibleRoute",
              args: { startNavigation: true },
            },
          ],
        },
      });
      await vi.waitFor(() =>
        expect(readNavigationTokenStrict).toHaveBeenCalledOnce(),
      );
      if (boundary === "new text") utter("先不要動");
      else onmessage({ toolCallCancellation: { ids: ["pending-direct"] } });
      pending.resolve({ status: "ok", value: envelope });
      await new Promise((r) => setTimeout(r, 0));
      expect(messages().some((m) => m.type === "nav.start")).toBe(false);
    },
  );
});
