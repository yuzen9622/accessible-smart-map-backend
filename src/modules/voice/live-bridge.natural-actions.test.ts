import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";

const io = vi.hoisted(() => ({
  connect: vi.fn(),
  execute: vi.fn(),
  route: vi.fn(),
  envelope: vi.fn(),
  readToken: vi.fn(),
  stop: vi.fn(),
  store: vi.fn(),
  remove: vi.fn(),
}));
vi.mock("../../config/ai", () => ({
  googleGenAi: { live: { connect: io.connect } },
}));
vi.mock("../ai/agent-tools", () => ({ executeLocalTool: io.execute }));
vi.mock("../accessible-route/route-token.service", () => ({
  getRouteByToken: io.route,
  getNavigationEnvelopeByToken: io.envelope,
  isNavigationEnvelope: (v: any) =>
    v?.schemaVersion === 1 && !!v.route && !!v.canonicalRequest,
}));
vi.mock("../accessible-route/navigation-state.repository", () => ({
  readNavigationTokenStrict: io.readToken,
  getAdoptedCandidateReplacement: vi.fn(),
  storeNavigationSnapshot: io.store,
  deleteNavigationSnapshot: io.remove,
  markNavigationStopped: io.stop,
  getNavigationSnapshot: vi.fn(),
  beginNavigationResume: vi.fn(),
  commitNavigationResume: vi.fn(),
  releaseNavigationResume: vi.fn(),
}));
vi.mock("../accessible-route/candidate-route-switch.service", () => ({
  switchNavigationCandidate: vi.fn(),
}));
vi.mock("../accessible-route/reroute.service", () => ({
  rerouteAccessibleRoute: vi.fn(),
}));
vi.mock("../ai/memory.service", () => ({
  getMemorySettings: vi.fn(async () => ({ memoryEnabled: false })),
  loadMemories: vi.fn(async () => []),
}));
vi.mock("./transcript-corrector", () => ({
  correctUserTranscript: vi.fn(async (text: string) => text),
}));
vi.mock("./corridor-monitor", () => ({
  scanRemainingCorridor: vi.fn(async () => []),
}));
vi.mock("../transit/alert.service", () => ({
  getTransitAlerts: vi.fn(async () => []),
}));
import { createLiveBridge, type LiveBridge } from "./live-bridge";

const route = {
  routeId: "natural-route",
  routeToken: "natural-token",
  navigationId: "natural-nav",
  routeVersion: 1,
  routeName: "輪椅路線",
  totalMinutes: 2,
  transferCount: 0,
  accessibilityHighlights: [],
  legs: [
    {
      type: "WALK",
      from: "A",
      to: "臺大醫院",
      distanceM: 100,
      minutesEst: 2,
      polyline: [
        [121, 25],
        [121.001, 25],
      ],
      a11yFacilities: [],
      steps: [
        {
          relativeDirection: "DEPART",
          absoluteDirection: null,
          streetName: "路",
          bogusName: false,
          area: false,
          distanceM: 100,
          location: [121, 25],
          instruction: "向前走",
        },
      ],
    },
  ],
};
const envelope = {
  schemaVersion: 1,
  navigationId: route.navigationId,
  routeVersion: 1,
  route,
  canonicalRequest: {
    origin: "A",
    destination: "臺大醫院",
    mode: "walk",
    wheelchair: true,
  },
};
let bridge: LiveBridge;
let callbacks: any;
let connectOptions: any;
let ws: WebSocket;
let session: ReturnType<typeof makeSession>;
function makeSession() {
  return {
    sendRealtimeInput: vi.fn(),
    sendClientContent: vi.fn(),
    sendToolResponse: vi.fn(),
    close: vi.fn(),
  };
}
function frames() {
  return vi
    .mocked(ws.send)
    .mock.calls.map(([frame]) => JSON.parse(String(frame)));
}
async function transcript(text: string) {
  callbacks.onmessage({
    serverContent: { inputTranscription: { text, finished: true } },
  });
  await vi.waitFor(() =>
    expect(frames().some((f) => f.type === "transcript" && f.final)).toBe(true),
  );
}
async function tool(name: string, args: Record<string, unknown> = {}) {
  const count = session.sendToolResponse.mock.calls.length;
  callbacks.onmessage({
    toolCall: { functionCalls: [{ id: `call-${count}`, name, args }] },
  });
  await vi.waitFor(() =>
    expect(session.sendToolResponse).toHaveBeenCalledTimes(count + 1),
  );
  return JSON.parse(
    session.sendToolResponse.mock.calls[count][0].functionResponses[0].response
      .output,
  );
}
function noise() {
  const pcm = Buffer.alloc(3200);
  for (let i = 0; i < pcm.length; i += 2) pcm.writeInt16LE(1000, i);
  bridge.sendAudio(pcm);
}

describe("natural-language voice actions — frozen user acceptance", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    io.route.mockResolvedValue(route);
    io.envelope.mockResolvedValue(envelope);
    io.readToken.mockResolvedValue({ status: "ok", value: envelope });
    io.stop.mockResolvedValue("stopped");
    io.store.mockResolvedValue(undefined);
    io.remove.mockResolvedValue(undefined);
    io.execute.mockResolvedValue(
      JSON.stringify({
        ok: true,
        routes: [route],
        selectedRouteId: route.routeId,
      }),
    );
    session = makeSession();
    io.connect.mockImplementation(async (options) => {
      connectOptions = options;
      callbacks = options.callbacks;
      return session;
    });
    ws = {
      readyState: WebSocket.OPEN,
      bufferedAmount: 0,
      send: vi.fn(),
      close: vi.fn(),
    } as unknown as WebSocket;
    bridge = await createLiveBridge({
      ws,
      userId: "natural-actions",
      userLocation: { latitude: 25, longitude: 121 },
    });
    await bridge.voiceReady;
  });
  afterEach(() => bridge?.close());

  it.each([
    "請開始導航，帶我沿著剛才的輪椅路線前往臺大醫院",
    "可以麻煩你現在帶路嗎？",
    "案内を始めてください",
  ])(
    "executes the model's start decision without matching a phrase: %s",
    async (text) => {
      await bridge.armRouteToken(route.routeToken);
      await transcript(text);
      noise();
      expect(await tool("startNavigation")).toMatchObject({ ok: true });
      expect(frames().filter((f) => f.type === "nav.start")).toHaveLength(1);
    },
  );

  it("does not treat continuous raw microphone frames as detected speech that blocks navigation audio", async () => {
    await bridge.armRouteToken(route.routeToken);
    bridge.sendAudio(Buffer.alloc(3200));
    bridge.startNavigation();
    expect(frames().some((frame) => frame.type === "nav.start")).toBe(true);
    expect(session.sendRealtimeInput).toHaveBeenCalled();
    expect(session.sendClientContent).toHaveBeenCalledTimes(1);
  });

  it("accepts a new detected user command while the startup acknowledgement is speaking", async () => {
    await bridge.armRouteToken(route.routeToken);
    bridge.startNavigation();
    expect(session.sendClientContent).toHaveBeenCalledTimes(1);
    await transcript("停止導航");
    callbacks.onmessage({
      toolCall: {
        functionCalls: [
          { id: "stop-during-start", name: "stopNavigation", args: {} },
        ],
      },
    });
    await vi.waitFor(() =>
      expect(io.stop).toHaveBeenCalledWith(
        route.navigationId,
        "natural-actions",
      ),
    );
    expect(frames().some((frame) => frame.type === "nav.stop")).toBe(true);
  });

  it("waits for a detected user turn before narrating navigation", async () => {
    await bridge.armRouteToken(route.routeToken);
    await transcript("我正在說話，請稍等一下");
    bridge.startNavigation();
    expect(session.sendClientContent).not.toHaveBeenCalled();
    callbacks.onmessage({ serverContent: { turnComplete: true } });
    await vi.waitFor(() =>
      expect(session.sendClientContent).toHaveBeenCalledTimes(1),
    );
  });

  it("does not require ASR text to precede a start tool decision", async () => {
    await bridge.armRouteToken(route.routeToken);
    expect(await tool("startNavigation")).toMatchObject({ ok: true });
    expect(frames().some((f) => f.type === "nav.start")).toBe(true);
  });

  it("accepts a natural stop decision despite subsequent raw PCM", async () => {
    await bridge.armRouteToken(route.routeToken);
    bridge.startNavigation();
    callbacks.onmessage({ serverContent: { turnComplete: true } });
    await transcript("我到了，這段就不用再帶路了喔");
    noise();
    expect(await tool("stopNavigation")).toMatchObject({ ok: true });
    expect(io.stop).toHaveBeenCalledWith(route.navigationId, "natural-actions");
    expect(frames().some((f) => f.type === "nav.stop")).toBe(true);
  });

  it("ends on a semantic model decision rather than an end-phrase whitelist", async () => {
    await transcript("今天先聊到這邊，你可以休息了，感謝幫忙");
    noise();
    expect(await tool("endVoiceSession")).toMatchObject({ ok: true });
    expect(frames().some((f) => f.type === "session.ending")).toBe(true);
    expect(io.stop).not.toHaveBeenCalled();
  });

  it("exposes the voice-only semantic start option to the actual model catalogue", () => {
    const declarations = connectOptions.config.tools.flatMap(
      (t: any) => t.functionDeclarations ?? [],
    );
    const plan = declarations.find(
      (t: any) => t.name === "planAccessibleRoute",
    );
    expect(plan.parametersJsonSchema.properties.startNavigation).toMatchObject({
      type: "boolean",
    });
    expect(plan.parametersJsonSchema.required ?? []).not.toContain(
      "startNavigation",
    );
  });

  it("starts after planning only when the model requests it, without lexical intent or PCM gating", async () => {
    await transcript("好，我們現在出發吧，請一路指引我到醫院");
    noise();
    const result = await tool("planAccessibleRoute", {
      origin: "current_location",
      destination: "臺大醫院",
      startNavigation: true,
    });
    expect(result).toMatchObject({ ok: true, navigationStarted: true });
    expect(frames().filter((f) => f.type === "nav.start")).toHaveLength(1);
    expect(io.execute.mock.calls[0][1]).not.toHaveProperty("startNavigation");
  });

  it.each([undefined, false])(
    "does not infer auto-start from transcript keywords when model flag is %s",
    async (startNavigation) => {
      await transcript("帶我去臺大醫院");
      const result = await tool("planAccessibleRoute", {
        origin: "A",
        destination: "臺大醫院",
        ...(startNavigation === undefined ? {} : { startNavigation }),
      });
      expect(result.ok).toBe(true);
      expect(frames().filter((f) => f.type === "nav.start")).toHaveLength(0);
      expect(io.execute.mock.calls[0][1]).not.toHaveProperty("startNavigation");
    },
  );
});
