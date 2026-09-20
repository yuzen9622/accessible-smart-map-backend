import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";

const {
  connect,
  getRouteByToken,
  getNavigationEnvelopeByToken,
  rerouteAccessibleRoute,
  getMemorySettings,
  loadMemories,
  storeNavigationSnapshot,
  getNavigationSnapshot,
  deleteNavigationSnapshot,
  getTransitAlerts,
  scanRemainingCorridor,
} = vi.hoisted(() => ({
  connect: vi.fn(),
  getRouteByToken: vi.fn(),
  getNavigationEnvelopeByToken: vi.fn(),
  rerouteAccessibleRoute: vi.fn(),
  getMemorySettings: vi.fn().mockResolvedValue({ memoryEnabled: false }),
  loadMemories: vi.fn().mockResolvedValue([]),
  storeNavigationSnapshot: vi.fn(),
  getNavigationSnapshot: vi.fn(),
  deleteNavigationSnapshot: vi.fn(),
  getTransitAlerts: vi.fn(),
  scanRemainingCorridor: vi.fn(),
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
vi.mock("../accessible-route/navigation-state.repository", () => ({
  storeNavigationSnapshot,
  getNavigationSnapshot,
  deleteNavigationSnapshot,
}));
vi.mock("../ai/memory.service", () => ({ getMemorySettings, loadMemories }));
vi.mock("./transcript-corrector", () => ({
  correctUserTranscript: vi.fn(async (t: string) => t),
}));
vi.mock("../transit/alert.service", () => ({ getTransitAlerts }));
vi.mock("./corridor-monitor", () => ({ scanRemainingCorridor }));

import { executeLocalTool } from "../ai/agent-tools";
import { createLiveBridge } from "./live-bridge";
import { NavigationSession } from "./navigation-session";
import { clearAlertStore, upsertAlertSnapshot } from "../transit/alert.store";

const ALERT_KEY = "bus:city:Taipei";
const TURN_TIMEOUT_MS = 15_000;

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

type LiveCallbacks = {
  onmessage?: (message: unknown) => void;
  onerror?: (e: { message: string }) => void;
  onclose?: () => void;
};
type LiveSessionStub = ReturnType<typeof makeSession>;
type TransitAlertResultStub = ReturnType<typeof alertsResult>;

const start = [121, 25] as [number, number];
const end = [121.001, 25] as [number, number];

/** WALK + BUS 307 with no tdxCity/cityCode, so the alert key is bus:city:Taipei. */
const transitRoute = {
  routeId: "r",
  routeName: "bus route",
  totalMinutes: 5,
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
  ],
} as any;

const nonBlockingAlert = {
  alertId: "a1",
  title: "部分路段調整",
  description: "",
};
const blockingAlert = {
  alertId: "a2",
  title: "307 路線全線停駛",
  description: "",
};

const alertsResult = (alerts: unknown[]) => ({
  ok: true as const,
  mode: "bus" as const,
  matchedAt: new Date().toISOString(),
  alerts,
});

const framesOf = (ws: WebSocket) =>
  vi
    .mocked(ws.send)
    .mock.calls.map(([value]) => value)
    .filter((value): value is string => typeof value === "string")
    .map((value) => JSON.parse(value));

const advisoriesOf = (ws: WebSocket) =>
  framesOf(ws).filter((frame) => frame.type === "nav.advisory");

describe("live bridge navigation with degraded or absent voice", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearAlertStore();
    getRouteByToken.mockResolvedValue(transitRoute);
    getNavigationEnvelopeByToken.mockResolvedValue({
      navigationId: "nav-1",
      routeVersion: 1,
      canonicalRequest: { requireElevator: false },
    });
    getTransitAlerts.mockResolvedValue(alertsResult([]));
    scanRemainingCorridor.mockResolvedValue([]);
    connect.mockResolvedValue(makeSession());
  });

  afterEach(() => {
    clearAlertStore();
  });

  /** Arms the transit route and starts navigation over the non-voice entry point. */
  const startNavigated = async (ws: WebSocket) => {
    const bridge = await createLiveBridge({
      ws,
      userId: "u",
      userLocation: { latitude: 25, longitude: 121 },
    });
    await bridge.voiceReady;
    await bridge.armRouteToken("cap");
    bridge.startNavigation();
    return bridge;
  };

  it("resolves the bridge and keeps the socket open when live.connect rejects", async () => {
    connect.mockRejectedValue(new Error("gemini down"));
    const ws = makeWs();

    const bridge = await createLiveBridge({ ws, userId: "u" });
    await bridge.voiceReady;

    expect(ws.close).not.toHaveBeenCalled();
    expect(framesOf(ws)).toContainEqual({
      type: "error",
      code: "LIVE_CONNECT_FAILED",
    });
    bridge.close();
  });

  it("starts navigation over startNavigation() with no voice session", async () => {
    connect.mockRejectedValue(new Error("gemini down"));
    const ws = makeWs();

    const bridge = await startNavigated(ws);

    expect(framesOf(ws).some((f) => f.type === "nav.start")).toBe(true);
    expect(storeNavigationSnapshot).toHaveBeenCalled();
    bridge.close();
  });

  it("broadcasts transit advisories with warning severity when voice is unavailable", async () => {
    connect.mockRejectedValue(new Error("gemini down"));
    getTransitAlerts.mockResolvedValue(alertsResult([nonBlockingAlert]));
    const ws = makeWs();

    const bridge = await startNavigated(ws);
    await vi.waitFor(() => expect(advisoriesOf(ws)).toHaveLength(1));

    const advisory = advisoriesOf(ws)[0];
    expect(advisory.navigationId).toBe("nav-1");
    expect(advisory.routeVersion).toBe(1);
    expect(advisory.advisories[0].severity).toBe("warning");
    expect(advisory.advisories[0].action).toBe("none");
    bridge.close();
  });

  it("reroutes on a blocking alert with no voice session", async () => {
    connect.mockRejectedValue(new Error("gemini down"));
    getTransitAlerts.mockResolvedValue(alertsResult([blockingAlert]));
    rerouteAccessibleRoute.mockResolvedValue({
      ok: true,
      data: {
        navigationId: "nav-1",
        previousRouteVersion: 1,
        routeVersion: 2,
        routeToken: "replacement",
        route: transitRoute,
        instructions: [],
        steps: [],
        warnings: [],
        currentStepIndex: 0,
        replayed: false,
      },
    });
    const ws = makeWs();

    const bridge = await startNavigated(ws);
    await vi.waitFor(() => expect(advisoriesOf(ws)).toHaveLength(1));

    expect(rerouteAccessibleRoute).toHaveBeenCalled();
    const types = framesOf(ws).map((f) => f.type);
    expect(types).toContain("nav.rerouting");
    expect(types).toContain("nav.route_replaced");
    expect(advisoriesOf(ws)[0].advisories[0].action).toBe("reroute_applied");
    bridge.close();
  });

  it("downgrades reroute_applied to reroute_suggested when the reroute fails", async () => {
    connect.mockRejectedValue(new Error("gemini down"));
    getTransitAlerts.mockResolvedValue(alertsResult([blockingAlert]));
    rerouteAccessibleRoute.mockResolvedValue({
      ok: false,
      status: 500,
      error: "x",
    });
    const ws = makeWs();

    const bridge = await startNavigated(ws);
    await vi.waitFor(() => expect(advisoriesOf(ws)).toHaveLength(1));

    expect(advisoriesOf(ws)[0].advisories[0].action).toBe("reroute_suggested");
    bridge.close();
  });

  it("downgrades reroute_applied to reroute_suggested when the reroute throws", async () => {
    connect.mockRejectedValue(new Error("gemini down"));
    getTransitAlerts.mockResolvedValue(alertsResult([blockingAlert]));
    rerouteAccessibleRoute.mockRejectedValue(new Error("boom"));
    const ws = makeWs();

    const bridge = await startNavigated(ws);
    await vi.waitFor(() => expect(advisoriesOf(ws)).toHaveLength(1));

    expect(framesOf(ws).map((f) => f.type)).toContain("nav.reroute_failed");
    expect(advisoriesOf(ws)[0].advisories[0].action).toBe("reroute_suggested");
    bridge.close();
  });

  it("deduplicates the same alert id within the TTL without voice", async () => {
    connect.mockRejectedValue(new Error("gemini down"));
    getTransitAlerts.mockResolvedValue(alertsResult([nonBlockingAlert]));
    const ws = makeWs();

    const bridge = await startNavigated(ws);
    await vi.waitFor(() => expect(advisoriesOf(ws)).toHaveLength(1));

    upsertAlertSnapshot(ALERT_KEY, [], "mqtt");
    await vi.waitFor(() =>
      expect(getTransitAlerts.mock.calls.length).toBeGreaterThan(1),
    );
    upsertAlertSnapshot(ALERT_KEY, [], "mqtt");
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(advisoriesOf(ws)).toHaveLength(1);
    bridge.close();
  });

  it("reacts to alert store updates with no Gemini session at all", async () => {
    connect.mockRejectedValue(new Error("gemini down"));
    const ws = makeWs();
    const bridge = await startNavigated(ws);
    await vi.waitFor(() => expect(getTransitAlerts).toHaveBeenCalled());
    getTransitAlerts.mockClear();
    getTransitAlerts.mockResolvedValue(alertsResult([nonBlockingAlert]));

    upsertAlertSnapshot(ALERT_KEY, [], "mqtt");

    await vi.waitFor(() => expect(advisoriesOf(ws)).toHaveLength(1));
    bridge.close();
  });

  it("folds an alert burst into a single in-flight transit check", async () => {
    connect.mockRejectedValue(new Error("gemini down"));
    const ws = makeWs();
    const bridge = await startNavigated(ws);
    await vi.waitFor(() => expect(getTransitAlerts).toHaveBeenCalled());
    getTransitAlerts.mockClear();

    const gate = deferred<TransitAlertResultStub>();
    getTransitAlerts.mockReturnValue(gate.promise);
    for (let i = 0; i < 5; i++) upsertAlertSnapshot(ALERT_KEY, [], "mqtt");

    expect(getTransitAlerts).toHaveBeenCalledOnce();

    getTransitAlerts.mockResolvedValue(alertsResult([]));
    gate.resolve(alertsResult([]));
    await vi.waitFor(() => expect(getTransitAlerts).toHaveBeenCalledTimes(2));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(getTransitAlerts).toHaveBeenCalledTimes(2);
    bridge.close();
  });

  it("drains queued speech instead of growing it when voice is unavailable", async () => {
    connect.mockRejectedValue(new Error("gemini down"));
    const onTurnComplete = vi.spyOn(
      NavigationSession.prototype,
      "onTurnComplete",
    );
    const takeNextSpeech = vi.spyOn(
      NavigationSession.prototype,
      "takeNextSpeech",
    );
    getTransitAlerts.mockResolvedValue(alertsResult([nonBlockingAlert]));
    const ws = makeWs();

    const bridge = await startNavigated(ws);
    await vi.waitFor(() => expect(advisoriesOf(ws)).toHaveLength(1));

    getTransitAlerts.mockResolvedValue(
      alertsResult([{ alertId: "a3", title: "另一則調整", description: "" }]),
    );
    upsertAlertSnapshot(ALERT_KEY, [], "mqtt");
    await vi.waitFor(() => expect(advisoriesOf(ws)).toHaveLength(2));

    expect(onTurnComplete.mock.calls.length).toBeGreaterThanOrEqual(3);
    expect(takeNextSpeech.mock.results.at(-1)?.value).toBeNull();

    onTurnComplete.mockRestore();
    takeNextSpeech.mockRestore();
    bridge.close();
  });

  it("releases an in-flight speech line when the session dies mid-turn", async () => {
    const session = makeSession();
    let onclose: (() => void) | undefined;
    connect.mockImplementation(
      async ({ callbacks }: { callbacks: LiveCallbacks }) => {
        onclose = callbacks.onclose;
        return session;
      },
    );
    const takeNextSpeech = vi.spyOn(
      NavigationSession.prototype,
      "takeNextSpeech",
    );
    const ws = makeWs();

    const bridge = await startNavigated(ws);
    expect(session.sendClientContent).toHaveBeenCalled();

    onclose?.();

    getTransitAlerts.mockResolvedValue(alertsResult([nonBlockingAlert]));
    upsertAlertSnapshot(ALERT_KEY, [], "mqtt");
    await vi.waitFor(() => expect(advisoriesOf(ws)).toHaveLength(1));

    expect(takeNextSpeech.mock.results.at(-1)?.value).toBeNull();
    takeNextSpeech.mockRestore();
    bridge.close();
  });

  it("keeps the alert pipeline alive after the live session closes mid-navigation", async () => {
    let onclose: (() => void) | undefined;
    connect.mockImplementation(
      async ({ callbacks }: { callbacks: LiveCallbacks }) => {
        onclose = callbacks.onclose;
        return makeSession();
      },
    );
    const ws = makeWs();
    const bridge = await startNavigated(ws);

    onclose?.();
    expect(ws.close).not.toHaveBeenCalled();

    getTransitAlerts.mockResolvedValue(alertsResult([nonBlockingAlert]));
    upsertAlertSnapshot(ALERT_KEY, [], "mqtt");

    await vi.waitFor(() => expect(advisoriesOf(ws)).toHaveLength(1));
    bridge.close();
  });

  it("keeps the socket open when the model turn times out repeatedly", async () => {
    vi.useFakeTimers();
    try {
      const session = makeSession();
      connect.mockResolvedValue(session);
      const ws = makeWs();
      const bridge = await startNavigated(ws);
      expect(session.sendClientContent).toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(TURN_TIMEOUT_MS * 2 + 100);

      expect(ws.close).not.toHaveBeenCalled();
      expect(framesOf(ws)).toContainEqual({
        type: "error",
        code: "LIVE_SESSION_ENDED",
      });

      getTransitAlerts.mockResolvedValue(alertsResult([nonBlockingAlert]));
      upsertAlertSnapshot(ALERT_KEY, [], "mqtt");
      await vi.advanceTimersByTimeAsync(50);
      expect(advisoriesOf(ws)).toHaveLength(1);
      bridge.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it("degrades instead of throwing when sendClientContent fails", async () => {
    const session = makeSession();
    session.sendClientContent.mockImplementation(() => {
      throw new Error("dead");
    });
    connect.mockResolvedValue(session);
    const ws = makeWs();

    const bridge = await startNavigated(ws);
    expect(() =>
      bridge.updatePosition({ latitude: 25, longitude: 121, accuracy: 5 }),
    ).not.toThrow();

    expect(ws.close).not.toHaveBeenCalled();
    expect(framesOf(ws)).toContainEqual({
      type: "error",
      code: "LIVE_SESSION_ENDED",
    });
    bridge.close();
  });

  it("degrades on session onerror without closing the socket", async () => {
    let onerror: ((e: { message: string }) => void) | undefined;
    connect.mockImplementation(
      async ({ callbacks }: { callbacks: LiveCallbacks }) => {
        onerror = callbacks.onerror;
        return makeSession();
      },
    );
    const ws = makeWs();
    const bridge = await startNavigated(ws);

    onerror?.({ message: "x" });

    expect(ws.close).not.toHaveBeenCalled();
    expect(framesOf(ws)).toContainEqual({
      type: "error",
      code: "LIVE_SESSION_ENDED",
    });

    getTransitAlerts.mockResolvedValue(alertsResult([nonBlockingAlert]));
    upsertAlertSnapshot(ALERT_KEY, [], "mqtt");
    await vi.waitFor(() => expect(advisoriesOf(ws)).toHaveLength(1));
    bridge.close();
  });

  it("serves navigation while the Gemini handshake is still pending", async () => {
    const session = makeSession();
    const pendingConnect = deferred<LiveSessionStub>();
    connect.mockReturnValue(pendingConnect.promise);
    const ws = makeWs();

    const bridge = await createLiveBridge({
      ws,
      userId: "u",
      userLocation: { latitude: 25, longitude: 121 },
    });
    await bridge.armRouteToken("cap");
    bridge.startNavigation();

    expect(framesOf(ws).some((f) => f.type === "nav.start")).toBe(true);
    expect(session.sendClientContent).not.toHaveBeenCalled();

    pendingConnect.resolve(session);
    await bridge.voiceReady;

    expect(session.sendClientContent).toHaveBeenCalled();
    bridge.close();
  });

  it("does not execute stopNavigation when Gemini closes during queued tool calls and preserves navigation", async () => {
    let onmessage: ((message: unknown) => void) | undefined;
    let onclose: (() => void) | undefined;
    const session = makeSession();
    connect.mockImplementation(
      async ({ callbacks }: { callbacks: LiveCallbacks }) => {
        onmessage = callbacks.onmessage;
        onclose = callbacks.onclose;
        return session;
      },
    );

    const slowToolGate = deferred<string>();
    vi.mocked(executeLocalTool).mockImplementation(() => slowToolGate.promise);

    const ws = makeWs();
    const bridge = await startNavigated(ws);
    expect(framesOf(ws).some((f) => f.type === "nav.start")).toBe(true);

    // Enqueue message 1: calls a slow local tool
    onmessage?.({
      toolCall: {
        functionCalls: [{ id: "call-slow", name: "findA11yPlaces", args: {} }],
      },
    });

    // Enqueue message 2: calls stopNavigation, queued behind message 1
    onmessage?.({
      toolCall: {
        functionCalls: [{ id: "call-stop", name: "stopNavigation", args: {} }],
      },
    });

    // While message 1 is awaiting executeLocalTool, Gemini session closes
    onclose?.();

    // Now resolve the slow tool call
    slowToolGate.resolve(JSON.stringify({ places: [] }));
    await new Promise((resolve) => setTimeout(resolve, 50));

    // Verify stopNavigation was NOT called (no nav.stop event emitted)
    expect(framesOf(ws).some((f) => f.type === "nav.stop")).toBe(false);

    // Verify navigation and Alert pipeline are not interrupted
    getTransitAlerts.mockResolvedValue(alertsResult([nonBlockingAlert]));
    upsertAlertSnapshot(ALERT_KEY, [], "mqtt");
    await vi.waitFor(() => expect(advisoriesOf(ws)).toHaveLength(1));

    const advisory = advisoriesOf(ws)[0];
    expect(advisory.navigationId).toBe("nav-1");
    expect(advisory.routeVersion).toBe(1);

    bridge.close();
  });

  it("does not execute stopNavigation when Gemini closes during the preceding tool call in the same batch", async () => {
    let onmessage: ((message: unknown) => void) | undefined;
    let onclose: (() => void) | undefined;
    const session = makeSession();
    connect.mockImplementation(
      async ({ callbacks }: { callbacks: LiveCallbacks }) => {
        onmessage = callbacks.onmessage;
        onclose = callbacks.onclose;
        return session;
      },
    );

    const slowToolGate = deferred<string>();
    vi.mocked(executeLocalTool).mockImplementation(() => slowToolGate.promise);

    const ws = makeWs();
    const bridge = await startNavigated(ws);

    // Enqueue single message with multiple tool calls in batch
    onmessage?.({
      toolCall: {
        functionCalls: [
          { id: "call-slow", name: "findA11yPlaces", args: {} },
          { id: "call-stop", name: "stopNavigation", args: {} },
        ],
      },
    });

    // While first tool call is running, Gemini session closes
    onclose?.();

    // Now resolve the slow tool call
    slowToolGate.resolve(JSON.stringify({ places: [] }));
    await new Promise((resolve) => setTimeout(resolve, 50));

    // Verify stopNavigation was NOT called
    expect(framesOf(ws).some((f) => f.type === "nav.stop")).toBe(false);

    // Alert pipeline still works
    getTransitAlerts.mockResolvedValue(alertsResult([nonBlockingAlert]));
    upsertAlertSnapshot(ALERT_KEY, [], "mqtt");
    await vi.waitFor(() => expect(advisoriesOf(ws)).toHaveLength(1));

    bridge.close();
  });
});
