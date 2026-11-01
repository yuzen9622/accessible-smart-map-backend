vi.mock("../../adapters/voice-synthesis.adapter", () => ({
  synthesizeVoice: vi
    .fn()
    .mockResolvedValue({ pcm: Buffer.alloc(1920, 4), sampleRate: 24000 }),
}));
import { synthesizeVoice } from "../../adapters/voice-synthesis.adapter";
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
vi.mock("./route-operation", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./route-operation")>();
  return {
    ...actual,
    loadVoiceRoutingPreferences: vi.fn(
      async (_userId, preferences) => preferences ?? {},
    ),
    resolveRouteOperation: vi.fn(),
  };
});
import { createLiveBridge, type LiveBridge } from "./live-bridge";

import {
  resolveRouteOperation,
  unclearRouteOperation,
} from "./route-operation";
const authorize = (action: "start" | "stop" | "end_voice" | "none") => {
  vi.mocked(resolveRouteOperation).mockResolvedValue({
    ...unclearRouteOperation(),
    action,
    evidence: "test utterance",
  });
};
const authorizePlan = (startNavigation: boolean, origin: string) => {
  vi.mocked(resolveRouteOperation).mockResolvedValue({
    ...unclearRouteOperation(),
    action: "plan",
    evidence: "test utterance",
    startNavigation,
    plans: [
      {
        origin,
        destination: "臺大醫院",
        travelMode: "walk",
        transitPreference: null,
      },
    ],
  });
};
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
    .mock.calls.map(([frame]) => frame)
    .filter((frame): frame is string => typeof frame === "string")
    .map((frame) => JSON.parse(frame));
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
    vi.mocked(synthesizeVoice)
      .mockReset()
      .mockResolvedValue({ pcm: Buffer.alloc(1920, 4), sampleRate: 24000 });
    authorize("none");
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
      authorize("start");
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
    expect(synthesizeVoice).toHaveBeenCalledTimes(1);
    expect(session.sendClientContent).not.toHaveBeenCalled();
  });

  it("accepts a new detected user command while the startup acknowledgement is speaking", async () => {
    await bridge.armRouteToken(route.routeToken);
    bridge.startNavigation();
    expect(synthesizeVoice).toHaveBeenCalledTimes(1);
    expect(session.sendClientContent).not.toHaveBeenCalled();
    const initialSignal = vi.mocked(synthesizeVoice).mock.calls[0][1].signal;
    authorize("stop");
    await transcript("停止導航");
    expect(initialSignal.aborted).toBe(true);
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
    expect(synthesizeVoice).not.toHaveBeenCalled();
    callbacks.onmessage({ serverContent: { turnComplete: true } });
    await vi.waitFor(() => expect(synthesizeVoice).toHaveBeenCalledTimes(1));
    expect(session.sendClientContent).not.toHaveBeenCalled();
    const firstStep = frames().find((frame) => frame.type === "nav.start")
      .steps[0].instruction;
    expect(vi.mocked(synthesizeVoice).mock.calls[0][0]).toBe(firstStep);
  });

  it("keeps trusted speech pending despite stale Live completion or interruption", async () => {
    let finish!: (audio: { pcm: Buffer; sampleRate: 24000 }) => void;
    vi.mocked(synthesizeVoice).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    await bridge.armRouteToken(route.routeToken);
    bridge.startNavigation();
    const [spoken, options] = vi.mocked(synthesizeVoice).mock.calls[0];
    callbacks.onmessage({ serverContent: { generationComplete: true } });
    callbacks.onmessage({ serverContent: { interrupted: true } });
    callbacks.onmessage({ serverContent: { turnComplete: true } });
    expect(options.signal.aborted).toBe(false);
    expect(frames().some((frame) => frame.type === "turn.complete")).toBe(
      false,
    );
    expect(
      vi.mocked(ws.send).mock.calls.some(([frame]) => Buffer.isBuffer(frame)),
    ).toBe(false);
    finish({ pcm: Buffer.alloc(1920, 4), sampleRate: 24000 });
    await vi.waitFor(() =>
      expect(frames()).toContainEqual({
        type: "transcript",
        role: "model",
        text: spoken,
      }),
    );
    await vi.waitFor(() =>
      expect(frames()).toContainEqual({ type: "turn.complete" }),
    );
    expect(
      vi.mocked(ws.send).mock.calls.some(([frame]) => Buffer.isBuffer(frame)),
    ).toBe(true);
    expect(session.sendClientContent).not.toHaveBeenCalled();
  });

  it("requires a current user utterance before a model start decision", async () => {
    await bridge.armRouteToken(route.routeToken);
    expect(await tool("startNavigation")).toMatchObject({
      ok: false,
      reason: "OPERATION_NOT_REQUESTED",
    });
    expect(frames().some((f) => f.type === "nav.start")).toBe(false);
  });

  it("accepts a natural stop decision despite subsequent raw PCM", async () => {
    await bridge.armRouteToken(route.routeToken);
    bridge.startNavigation();
    callbacks.onmessage({ serverContent: { turnComplete: true } });
    authorize("stop");
    await transcript("我到了，這段就不用再帶路了喔");
    noise();
    expect(await tool("stopNavigation")).toMatchObject({ ok: true });
    expect(io.stop).toHaveBeenCalledWith(route.navigationId, "natural-actions");
    expect(frames().some((f) => f.type === "nav.stop")).toBe(true);
  });

  it("ends on a semantic model decision rather than an end-phrase whitelist", async () => {
    authorize("end_voice");
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

  it("starts a semantically authorized plan without lexical intent or PCM gating", async () => {
    authorizePlan(true, "current_location");
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

  it("includes committed navigation state in the direct plan response without exposing its token", async () => {
    authorizePlan(true, "current_location");
    await transcript("請帶我到臺大醫院並開始導航");
    const result = await tool("planAccessibleRoute", {
      origin: "current_location",
      destination: "臺大醫院",
      startNavigation: true,
    });
    expect(result.navigationStarted).toBe(true);
    expect(result.activeNavigation).toEqual({
      active: true,
      currentStep: { index: 0, legType: "WALK" },
    });
    expect(JSON.stringify(result.activeNavigation)).not.toContain(
      route.routeToken,
    );
    expect(result.activeNavigation).not.toHaveProperty("navigationId");
    await bridge.setRouteContext({ routeToken: route.routeToken });
    expect(io.connect).toHaveBeenCalledTimes(1);
    expect(await tool("getActiveNavigationContext")).toMatchObject({
      ...result.activeNavigation,
      currentStep: {
        ...result.activeNavigation.currentStep,
        instruction: expect.any(String),
      },
      destination: "臺大醫院",
    });
    expect(session.sendClientContent).not.toHaveBeenCalled();
  });

  it("logs navigation response facts without locations or tokens and records SDK send return afterwards", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    try {
      authorizePlan(true, "current_location");
      await transcript("請帶我到臺大醫院並開始導航");
      await tool("planAccessibleRoute", {
        origin: "current_location",
        destination: "臺大醫院",
        startNavigation: true,
      });
      const sentIndex = info.mock.calls.findIndex(
        ([label]) => label === "[voice] live send",
      );
      const returnedIndex = info.mock.calls.findIndex(
        ([label]) => label === "[voice] live send returned",
      );
      const sent = JSON.parse(String(info.mock.calls[sentIndex][1]));
      const returned = JSON.parse(String(info.mock.calls[returnedIndex][1]));
      expect(sent).toMatchObject({
        navigationActive: true,
        currentStepIndex: 0,
        currentLegType: "WALK",
        calls: [
          {
            name: "planAccessibleRoute",
            resultOk: true,
            navigationStarted: true,
            hasActiveNavigation: true,
          },
        ],
      });
      expect(returned).toEqual({ sequence: sent.sequence, epoch: sent.epoch });
      expect(info.mock.invocationCallOrder[returnedIndex]).toBeGreaterThan(
        session.sendToolResponse.mock.invocationCallOrder[0],
      );
      const logged = JSON.stringify(info.mock.calls);
      for (const privateValue of [
        route.routeToken,
        route.navigationId,
        "臺大醫院",
        '"latitude"',
        '"longitude"',
        "向前走",
      ])
        expect(logged).not.toContain(privateValue);
    } finally {
      info.mockRestore();
    }
  });

  it("reports inactive navigation when a direct plan cannot commit", async () => {
    io.readToken.mockResolvedValueOnce({ status: "missing" });
    authorizePlan(true, "current_location");
    await transcript("請帶我到臺大醫院並開始導航");
    const result = await tool("planAccessibleRoute", {
      origin: "current_location",
      destination: "臺大醫院",
      startNavigation: true,
    });
    expect(result).toMatchObject({
      navigationStarted: false,
      activeNavigation: { active: false },
    });
    expect(frames().some((f) => f.type === "nav.start")).toBe(false);
  });

  it("returns the executed navigation state through start, repeat, and stop results", async () => {
    await bridge.armRouteToken(route.routeToken);
    authorize("start");
    await transcript("現在開始導航");
    const started = await tool("startNavigation");
    expect(started.ok).toBe(true);
    expect(started.activeNavigation).toEqual({
      active: true,
      currentStep: { index: 0, legType: "WALK" },
    });
    vi.mocked(resolveRouteOperation).mockResolvedValue({
      ...unclearRouteOperation(),
      action: "delegate",
      delegateKind: "step",
      delegatedTools: ["repeatNavStep"],
      stepAction: "repeat",
      evidence: "再說一次",
    });
    await transcript("請再說一次目前的導航指示");
    expect(await tool("repeatNavStep")).toMatchObject({
      ok: true,
      activeNavigation: started.activeNavigation,
    });
    authorize("stop");
    await transcript("停止導航");
    expect(await tool("stopNavigation")).toMatchObject({
      ok: true,
      activeNavigation: { active: false },
    });
    expect(frames().filter((f) => f.type === "nav.start")).toHaveLength(1);
    expect(frames().filter((f) => f.type === "nav.stop")).toHaveLength(1);
    expect(session.sendClientContent).not.toHaveBeenCalled();
  });

  it("executes a details-classified replay once without advancing navigation", async () => {
    await bridge.armRouteToken(route.routeToken);
    authorize("start");
    await transcript("開始導航");
    await tool("startNavigation");
    callbacks.onmessage({ serverContent: { turnComplete: true } });
    await vi.waitFor(() =>
      expect(frames().filter((f) => f.type === "turn.complete")).toHaveLength(
        2,
      ),
    );
    vi.mocked(synthesizeVoice).mockClear();
    const previousSteps = frames().filter((f) => f.type === "nav.step");
    vi.mocked(resolveRouteOperation).mockResolvedValue({
      ...unclearRouteOperation(),
      action: "details",
      evidence: "再說一次目前的導航指示",
    });
    await transcript("請再說一次目前的導航指示");
    const result = await tool("repeatNavStep");
    expect(result).toMatchObject({
      ok: true,
      activeNavigation: { active: true, currentStep: { index: 0 } },
    });
    expect(await tool("repeatNavStep")).toMatchObject({
      ok: false,
      reason: "OPERATION_NOT_REQUESTED",
    });
    expect(
      frames().filter(
        (f) => f.type === "tool_call" && f.name === "repeatNavStep",
      ),
    ).toHaveLength(1);
    expect(frames().filter((f) => f.type === "nav.step")).toEqual(
      previousSteps,
    );
    callbacks.onmessage({ serverContent: { turnComplete: true } });
    await vi.waitFor(() => expect(synthesizeVoice).toHaveBeenCalledTimes(1));
    expect(vi.mocked(synthesizeVoice).mock.calls[0][0]).toBe(
      frames().find((f) => f.type === "nav.start").steps[0].instruction,
    );
    expect(session.sendClientContent).not.toHaveBeenCalled();
  });

  it.each(["none", "clarify", "advance"] as const)(
    "does not authorize replay from %s intent",
    async (intent) => {
      await bridge.armRouteToken(route.routeToken);
      authorize("start");
      await transcript("開始導航");
      await tool("startNavigation");
      vi.mocked(resolveRouteOperation).mockResolvedValue(
        intent === "advance"
          ? {
              ...unclearRouteOperation(),
              action: "delegate",
              delegateKind: "step",
              stepAction: "advance",
              delegatedTools: ["advanceNavStep"],
              evidence: "下一步",
            }
          : {
              ...unclearRouteOperation(),
              action: intent,
              evidence: "目前資訊",
            },
      );
      await transcript("目前資訊");
      expect(await tool("repeatNavStep")).toMatchObject({
        ok: false,
        reason: "OPERATION_NOT_REQUESTED",
      });
      expect(
        frames().some(
          (f) => f.type === "tool_call" && f.name === "repeatNavStep",
        ),
      ).toBe(false);
    },
  );

  it("keeps advance unauthorized when the request is classified as details", async () => {
    vi.mocked(resolveRouteOperation).mockResolvedValue({
      ...unclearRouteOperation(),
      action: "details",
      evidence: "目前步驟",
    });
    await transcript("說明目前步驟");
    expect(await tool("advanceNavStep")).toMatchObject({
      ok: false,
      reason: "OPERATION_NOT_REQUESTED",
    });
    expect(
      frames().some(
        (f) => f.type === "tool_call" && f.name === "advanceNavStep",
      ),
    ).toBe(false);
  });

  it.each(["step", "generation"] as const)(
    "rejects a pending details replay after its navigation %s changes",
    async (change) => {
      const movingRoute = {
        ...route,
        legs: [
          {
            ...route.legs[0],
            polyline: [
              [121, 25],
              [121.0005, 25],
              [121.001, 25],
            ],
            steps: [
              ...route.legs[0].steps,
              {
                ...route.legs[0].steps[0],
                relativeDirection: "RIGHT",
                location: [121.0005, 25],
                instruction: "右轉後繼續",
              },
            ],
          },
        ],
      };
      io.route.mockResolvedValue(movingRoute);
      io.envelope.mockResolvedValue({ ...envelope, route: movingRoute });
      await bridge.armRouteToken(route.routeToken);
      authorize("start");
      await transcript("開始導航");
      await tool("startNavigation");
      let finish!: (
        value: Awaited<ReturnType<typeof resolveRouteOperation>>,
      ) => void;
      vi.mocked(resolveRouteOperation).mockReturnValueOnce(
        new Promise((resolve) => {
          finish = resolve;
        }),
      );
      await transcript("請再說一次目前的導航指示");
      const pending = tool("repeatNavStep");
      await vi.waitFor(() =>
        expect(resolveRouteOperation).toHaveBeenCalledTimes(2),
      );
      if (change === "generation") bridge.cancelNav();
      else {
        bridge.updatePosition({
          latitude: 25,
          longitude: 121.0005,
          accuracy: 3,
        });
        expect(
          frames()
            .filter((f) => f.type === "nav.step")
            .at(-1).currentStepIndex,
        ).toBeGreaterThan(0);
      }
      finish({
        ...unclearRouteOperation(),
        action: "details",
        evidence: "目前的導航指示",
      });
      expect(await pending).toMatchObject({ ok: false });
      expect(
        frames().some(
          (f) => f.type === "tool_call" && f.name === "repeatNavStep",
        ),
      ).toBe(false);
    },
  );

  it("returns inactive state instead of inventing a step when repeat has no active navigation", async () => {
    vi.mocked(resolveRouteOperation).mockResolvedValue({
      ...unclearRouteOperation(),
      action: "delegate",
      delegateKind: "step",
      delegatedTools: ["repeatNavStep"],
      stepAction: "repeat",
      evidence: "再說一次",
    });
    await transcript("再說一次目前步驟");
    expect(await tool("repeatNavStep")).toMatchObject({
      ok: false,
      reason: "NO_ACTIVE_NAVIGATION",
      activeNavigation: { active: false },
    });
    expect(synthesizeVoice).not.toHaveBeenCalled();
  });

  it("returns the new indoor step after advance and inactive state after arrival", async () => {
    const indoor = {
      ...route,
      legs: [],
      venueLegs: {
        departure: {
          venueId: "nutc-sanmin",
          venueVersion: 1,
          mode: "wheelchair",
          fromPlaceId: "info-2606",
          toPlaceId: "info-2301",
          distanceM: 60,
          durationS: 120,
          elevatorRides: 1,
          stairFlights: 0,
          path: { coordinates: [], buildingIds: [], levelRefs: [] },
          segments: [],
          steps: ["從2606出發", "搭電梯到3樓", "抵達2301"].map(
            (instruction, index) => ({
              type:
                index === 0 ? "depart" : index === 1 ? "elevator" : "arrive",
              instruction,
              distanceM: 10,
              durationS: 10,
              buildingId: "info",
              levelRef: "6F",
              pathStart: 0,
              pathEnd: 0,
            }),
          ),
        },
      },
    };
    io.route.mockResolvedValue(indoor);
    io.envelope.mockResolvedValue({
      ...envelope,
      route: indoor,
      venueLegs: indoor.venueLegs,
    });
    await bridge.armRouteToken(route.routeToken);
    authorize("start");
    await transcript("開始帶路");
    await tool("startNavigation");
    vi.mocked(resolveRouteOperation).mockResolvedValue({
      ...unclearRouteOperation(),
      action: "delegate",
      delegateKind: "step",
      delegatedTools: ["advanceNavStep"],
      stepAction: "advance",
      evidence: "到了",
    });
    await transcript("到了，下一步");
    expect(await tool("advanceNavStep")).toEqual({
      ok: true,
      activeNavigation: {
        active: true,
        currentStep: { index: 1, legType: "VENUE" },
      },
    });
    await transcript("到了，再下一步");
    expect(await tool("advanceNavStep")).toMatchObject({
      ok: true,
      activeNavigation: { active: false },
    });
  });

  it.each([undefined, false])(
    "keeps a semantic preview non-navigating when model flag is %s",
    async (startNavigation) => {
      authorizePlan(false, "A");
      await transcript("請先看看去臺大醫院的路線，不要導航");
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

  it("forwards a natural greeting with background audio when Live omits transcription finished", async () => {
    callbacks.onmessage({
      serverContent: { inputTranscription: { text: "你好，今天過得怎麼樣？" } },
    });
    noise();
    const pcm = Buffer.alloc(1920, 7);
    callbacks.onmessage({
      serverContent: {
        modelTurn: {
          parts: [{ inlineData: { data: pcm.toString("base64") } }],
        },
        outputTranscription: { text: "嗨！想聊聊天，或需要我幫忙找路都可以。" },
      },
    });
    await vi.waitFor(() =>
      expect(frames()).toContainEqual({
        type: "transcript",
        role: "model",
        text: "嗨！想聊聊天，或需要我幫忙找路都可以。",
      }),
    );
    expect(
      vi
        .mocked(ws.send)
        .mock.calls.some(
          ([frame]) => Buffer.isBuffer(frame) && frame.equals(pcm),
        ),
    ).toBe(true);
    expect(resolveRouteOperation).not.toHaveBeenCalled();
    expect(io.execute).not.toHaveBeenCalled();
    expect(synthesizeVoice).not.toHaveBeenCalled();
  });

  it("does not wait for route classification to answer ordinary conversation", async () => {
    vi.mocked(resolveRouteOperation).mockImplementation(
      () => new Promise(() => {}),
    );
    await transcript("跟我聊聊天吧");
    callbacks.onmessage({
      serverContent: {
        outputTranscription: { text: "可以呀，你想聊什麼？" },
        turnComplete: true,
      },
    });
    await vi.waitFor(() =>
      expect(frames()).toContainEqual({
        type: "transcript",
        role: "model",
        text: "可以呀，你想聊什麼？",
      }),
    );
    expect(resolveRouteOperation).not.toHaveBeenCalled();
    expect(frames()).toContainEqual({ type: "turn.complete" });
  });

  it.each([
    "路線找到了，大約兩分鐘，你可以先看看。",
    "到醫院大概兩分鐘，路線已經顯示在地圖上囉。",
  ])(
    "lets the model compose the preview answer from its real tool result: %s",
    async (answer) => {
      authorizePlan(false, "A");
      await transcript("先幫我看去臺大醫院的路線");
      expect(
        (
          await tool("planAccessibleRoute", {
            origin: "A",
            destination: "臺大醫院",
          })
        ).ok,
      ).toBe(true);
      const pcm = Buffer.alloc(1920, 9);
      callbacks.onmessage({
        serverContent: {
          modelTurn: {
            parts: [{ inlineData: { data: pcm.toString("base64") } }],
          },
          outputTranscription: { text: answer },
        },
      });
      callbacks.onmessage({ serverContent: { turnComplete: true } });
      await vi.waitFor(() =>
        expect(frames()).toContainEqual({
          type: "transcript",
          role: "model",
          text: answer,
        }),
      );
      expect(
        vi
          .mocked(ws.send)
          .mock.calls.some(
            ([frame]) => Buffer.isBuffer(frame) && frame.equals(pcm),
          ),
      ).toBe(true);
      expect(resolveRouteOperation).toHaveBeenCalledTimes(1);
      expect(synthesizeVoice).not.toHaveBeenCalled();
      expect(frames().some((f) => f.type === "nav.start")).toBe(false);
    },
  );

  it("does not execute tools or inject scripted replies merely because a spoken request completed", async () => {
    vi.useFakeTimers();
    try {
      authorizePlan(true, "A");
      await transcript("帶我到醫院，現在開始導航");
      callbacks.onmessage({
        serverContent: { generationComplete: true, turnComplete: true },
      });
      await vi.advanceTimersByTimeAsync(10000);
      expect(resolveRouteOperation).not.toHaveBeenCalled();
      expect(io.execute).not.toHaveBeenCalled();
      expect(session.sendClientContent).not.toHaveBeenCalled();
      expect(synthesizeVoice).not.toHaveBeenCalled();
      expect(frames().some((frame) => frame.type === "nav.start")).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("answers an uncancelled queued blocking tool after newer input without executing it", async () => {
    let finishRead!: (result: string) => void;
    io.execute.mockReturnValueOnce(
      new Promise<string>((resolve) => {
        finishRead = resolve;
      }),
    );
    await transcript("請告訴我目前路線細節");
    callbacks.onmessage({
      toolCall: {
        functionCalls: [{ id: "read-first", name: "getAirQuality", args: {} }],
      },
    });
    await vi.waitFor(() => expect(io.execute).toHaveBeenCalledTimes(1));
    authorize("stop");
    callbacks.onmessage({
      toolCall: {
        functionCalls: [
          { id: "queued-stop", name: "stopNavigation", args: {} },
        ],
      },
    });
    callbacks.onmessage({
      serverContent: {
        inputTranscription: { text: "等等，先不要操作", finished: true },
      },
    });
    finishRead(JSON.stringify({ ok: true, instructions: [] }));
    await vi.waitFor(() =>
      expect(session.sendToolResponse).toHaveBeenCalledTimes(2),
    );
    const responses = session.sendToolResponse.mock.calls.flatMap(
      ([batch]) => batch.functionResponses,
    );
    expect(
      JSON.parse(
        responses.find((response: any) => response.id === "queued-stop")
          .response.output,
      ),
    ).toMatchObject({ ok: false, reason: "STALE_SELECTION" });
    expect(io.stop).not.toHaveBeenCalled();
    expect(resolveRouteOperation).not.toHaveBeenCalled();
    expect(frames().some((frame) => frame.type === "nav.stop")).toBe(false);
  });

  it("queues a navigation announcement until the current natural answer finishes", async () => {
    await bridge.armRouteToken(route.routeToken);
    bridge.startNavigation();
    await vi.waitFor(() =>
      expect(frames()).toContainEqual({ type: "turn.complete" }),
    );
    vi.mocked(synthesizeVoice).mockClear();
    await transcript("這條路上有什麼可以看的？");
    callbacks.onmessage({
      serverContent: {
        outputTranscription: { text: "沿途可以留意車站附近的街景，" },
      },
    });
    await vi.waitFor(() =>
      expect(frames()).toContainEqual({
        type: "transcript",
        role: "model",
        text: "沿途可以留意車站附近的街景，",
      }),
    );
    bridge.updatePosition({
      latitude: 25,
      longitude: 121.001,
      accuracy: 5,
    });
    expect(synthesizeVoice).not.toHaveBeenCalled();
    callbacks.onmessage({
      serverContent: {
        outputTranscription: { text: "到了之後也能再聊附近的地點。" },
      },
    });
    await vi.waitFor(() =>
      expect(frames()).toContainEqual({
        type: "transcript",
        role: "model",
        text: "到了之後也能再聊附近的地點。",
      }),
    );
    expect(synthesizeVoice).not.toHaveBeenCalled();
    callbacks.onmessage({ serverContent: { turnComplete: true } });
    await vi.waitFor(() => expect(synthesizeVoice).toHaveBeenCalledTimes(1));
    expect(resolveRouteOperation).not.toHaveBeenCalled();
  });

  it.each(["臺北 車站", "台北車站"])(
    "uses verified endpoints for equivalent place spelling: %s",
    async (origin) => {
      vi.mocked(resolveRouteOperation).mockResolvedValue({
        ...unclearRouteOperation(),
        action: "plan",
        evidence: "開車",
        changes: { ...unclearRouteOperation().changes, mode: "normal" },
        plans: [
          {
            origin: "台北車站",
            destination: "臺北市政府",
            travelMode: "drive",
            transitPreference: null,
          },
        ],
      });
      await transcript("從台北車站開車到臺北市政府，先看路線");
      const result = await tool("planAccessibleRoute", {
        origin,
        destination: "台北 市政府",
        travelMode: "drive",
      });
      expect(result.ok).toBe(true);
      expect(io.execute.mock.calls[0][1]).toMatchObject({
        origin: "台北車站",
        destination: "臺北市政府",
        travelMode: "drive",
      });
    },
  );

  it("rejects a genuinely different destination and returns the authorized trip to the model", async () => {
    authorizePlan(false, "A");
    await transcript("請先幫我看去臺大醫院的路線");
    const result = await tool("planAccessibleRoute", {
      origin: "A",
      destination: "松山車站",
    });
    expect(result).toMatchObject({
      ok: false,
      reason: "OPERATION_NOT_REQUESTED",
      allowedOperation: { plans: [{ origin: "A", destination: "臺大醫院" }] },
    });
    expect(io.execute).not.toHaveBeenCalled();
    expect(synthesizeVoice).not.toHaveBeenCalled();
  });

  it("terminates an uncancelled call when a new interrupted utterance overtakes its authorization", async () => {
    let authorizePending!: (
      value: Awaited<ReturnType<typeof resolveRouteOperation>>,
    ) => void;
    vi.mocked(resolveRouteOperation).mockReturnValueOnce(
      new Promise((resolve) => {
        authorizePending = resolve;
      }),
    );
    await transcript("現在開始導航");
    callbacks.onmessage({
      toolCall: {
        functionCalls: [
          { id: "pending-start", name: "startNavigation", args: {} },
        ],
      },
    });
    await vi.waitFor(() =>
      expect(resolveRouteOperation).toHaveBeenCalledTimes(1),
    );
    callbacks.onmessage({
      serverContent: {
        interrupted: true,
        inputTranscription: { text: "等等", finished: true },
      },
    });
    authorizePending({
      ...unclearRouteOperation(),
      action: "start",
      evidence: "開始導航",
    });
    await vi.waitFor(() =>
      expect(session.sendToolResponse).toHaveBeenCalledTimes(1),
    );
    const response =
      session.sendToolResponse.mock.calls[0][0].functionResponses[0];
    expect(response.id).toBe("pending-start");
    expect(JSON.parse(response.response.output)).toMatchObject({
      ok: false,
      reason: "STALE_SELECTION",
    });
    expect(frames().some((frame) => frame.type === "nav.start")).toBe(false);
  });

  it("preserves completed tool outcomes when a later call in the batch is interrupted", async () => {
    let finishRead!: (result: string) => void;
    io.execute.mockReturnValueOnce(
      new Promise<string>((resolve) => {
        finishRead = resolve;
      }),
    );
    authorize("stop");
    await transcript("停止導航，再查一下空氣品質");
    callbacks.onmessage({
      toolCall: {
        functionCalls: [
          { id: "committed-stop", name: "stopNavigation", args: {} },
          { id: "read-pending", name: "getAirQuality", args: {} },
          { id: "read-not-started", name: "getAirQuality", args: {} },
        ],
      },
    });
    await vi.waitFor(() => expect(io.execute).toHaveBeenCalledTimes(1));
    callbacks.onmessage({
      serverContent: {
        interrupted: true,
        inputTranscription: { text: "先等等", finished: true },
      },
    });
    finishRead(JSON.stringify({ ok: true, aqi: 35 }));
    await vi.waitFor(() =>
      expect(session.sendToolResponse).toHaveBeenCalledTimes(1),
    );
    const responses =
      session.sendToolResponse.mock.calls[0][0].functionResponses;
    expect(
      JSON.parse(
        responses.find((r: any) => r.id === "committed-stop").response.output,
      ),
    ).toMatchObject({ ok: true });
    expect(
      JSON.parse(
        responses.find((r: any) => r.id === "read-pending").response.output,
      ),
    ).toMatchObject({
      ok: false,
      reason: "STALE_SELECTION",
      error: expect.any(String),
    });
    expect(
      JSON.parse(
        responses.find((r: any) => r.id === "read-not-started").response.output,
      ),
    ).toMatchObject({ ok: false, reason: "STALE_SELECTION" });
    expect(io.execute).toHaveBeenCalledTimes(1);
  });

  it("responds once to an uncancelled tool arriving in the interrupted message itself", async () => {
    await transcript("先不要操作");
    callbacks.onmessage({
      serverContent: { interrupted: true },
      toolCall: {
        functionCalls: [
          { id: "interrupted-call", name: "stopNavigation", args: {} },
        ],
      },
    });
    await vi.waitFor(() =>
      expect(session.sendToolResponse).toHaveBeenCalledTimes(1),
    );
    const response =
      session.sendToolResponse.mock.calls[0][0].functionResponses[0];
    expect(response.id).toBe("interrupted-call");
    expect(JSON.parse(response.response.output)).toMatchObject({
      ok: false,
      reason: "STALE_SELECTION",
    });
    expect(resolveRouteOperation).not.toHaveBeenCalled();
    expect(io.stop).not.toHaveBeenCalled();
  });

  const prepareTwoPreviewCandidates = async (selectSecond = false) => {
    const second = {
      ...route,
      routeId: "alternate-route",
      routeToken: "alternate-token",
      navigationId: "alternate-nav",
    };
    io.execute.mockResolvedValue(
      JSON.stringify({
        ok: true,
        routes: [route, second],
        selectedRouteId: route.routeId,
      }),
    );
    io.route.mockImplementation(async (token) =>
      token === second.routeToken ? second : route,
    );
    io.envelope.mockImplementation(async (token) => ({
      ...envelope,
      route: token === second.routeToken ? second : route,
      navigationId:
        token === second.routeToken ? second.navigationId : route.navigationId,
    }));
    authorizePlan(false, "A");
    await transcript("先規劃去臺大醫院的路線");
    expect(
      (
        await tool("planAccessibleRoute", {
          origin: "A",
          destination: "臺大醫院",
        })
      ).ok,
    ).toBe(true);
    await bridge.armRouteToken(
      selectSecond ? second.routeToken : route.routeToken,
    );
    return second;
  };

  it.each([
    {
      name: "selected id",
      args: { candidateId: route.routeId },
      second: false,
    },
    { name: "selected ordinal", args: { candidateNumber: 1 }, second: false },
    {
      name: "nullable optionals",
      args: { candidateNumber: null, candidateId: null },
      second: false,
    },
    {
      name: "stale model candidate after manual choice",
      args: { candidateNumber: 1, candidateId: route.routeId },
      second: true,
    },
  ])(
    "starts the UI selection for an unqualified start with $name",
    async ({ args, second: selectedSecond }) => {
      const second = await prepareTwoPreviewCandidates(selectedSecond);
      authorize("start");
      await transcript("開始導航");
      expect(await tool("startNavigation", args)).toMatchObject({ ok: true });
      expect(
        frames().find((frame) => frame.type === "nav.start"),
      ).toMatchObject({
        routeToken: selectedSecond ? second.routeToken : route.routeToken,
      });
      expect(io.execute).toHaveBeenCalledTimes(1);
    },
  );

  it.each([
    {
      name: "ordinal to id",
      request: { candidateNumber: 2 },
      args: { candidateId: "alternate-route" },
    },
    {
      name: "id to ordinal",
      request: { candidateId: "alternate-route" },
      args: { candidateNumber: 2 },
    },
    {
      name: "ordinal to both identifiers",
      request: { candidateNumber: 2 },
      args: { candidateNumber: 2, candidateId: "alternate-route" },
    },
    {
      name: "null optional identifiers",
      request: { candidateNumber: 2 },
      args: { candidateNumber: null, candidateId: null },
    },
  ])(
    "accepts equivalent explicit candidate selection: $name",
    async ({ request, args }) => {
      const second = await prepareTwoPreviewCandidates();
      vi.mocked(resolveRouteOperation).mockResolvedValue({
        ...unclearRouteOperation(),
        action: "start",
        evidence: "第二條",
        ...request,
      });
      await transcript("用第二條路線開始導航");
      expect(await tool("startNavigation", args)).toMatchObject({ ok: true });
      expect(
        frames().find((frame) => frame.type === "nav.start"),
      ).toMatchObject({ routeToken: second.routeToken });
      expect(io.execute).toHaveBeenCalledTimes(1);
    },
  );

  it.each([
    { candidateNumber: 1 },
    { candidateId: route.routeId },
    { candidateNumber: 2, candidateId: route.routeId },
  ])(
    "rejects a different or internally conflicting explicit candidate: %j",
    async (args) => {
      await prepareTwoPreviewCandidates();
      vi.mocked(resolveRouteOperation).mockResolvedValue({
        ...unclearRouteOperation(),
        action: "start",
        evidence: "第二條",
        candidateNumber: 2,
      });
      await transcript("用第二條路線開始導航");
      expect(await tool("startNavigation", args)).toMatchObject({
        ok: false,
        reason: "OPERATION_NOT_REQUESTED",
        constraintViolation: "CANDIDATE_MISMATCH",
        allowedOperation: { action: "start", startNavigation: true },
      });
      expect(frames().some((frame) => frame.type === "nav.start")).toBe(false);
      expect(io.execute).toHaveBeenCalledTimes(1);
    },
  );

  const unspecifiedTrip = () => ({
    ...unclearRouteOperation(),
    action: "plan" as const,
    evidence: "規劃",
    plans: [
      {
        origin: "台北車站",
        destination: "淡水捷運站",
        travelMode: "drive" as const,
        transitPreference: null,
      },
    ],
  });

  it.each(["normal", "elderly", "wheelchair", "visual_impaired"] as const)(
    "permits a new transit trip without explicit transport despite previous driving preference: %s",
    async (mode) => {
      bridge.close();
      bridge = await createLiveBridge({
        ws,
        userId: "natural-actions",
        routingPreferences: {
          mode,
          travelMode: "drive",
          avoidStairs: true,
          requireElevator: true,
        },
      });
      await bridge.voiceReady;
      vi.mocked(resolveRouteOperation).mockResolvedValue(unspecifiedTrip());
      await transcript("幫我規劃臺北車站到淡水捷運站的路線");
      expect(
        await tool("planAccessibleRoute", {
          origin: "臺北車站",
          destination: "淡水捷運站",
          travelMode: "transit",
        }),
      ).toMatchObject({ ok: true });
      expect(io.execute.mock.calls[0][1]).toMatchObject({
        mode,
        travelMode: "transit",
        avoidStairs: true,
        requireElevator: true,
      });
      expect(frames().some((frame) => frame.type === "nav.start")).toBe(false);
      expect(synthesizeVoice).not.toHaveBeenCalled();
    },
  );

  it.each([
    { mode: "wheelchair", travelMode: "drive" },
    { mode: "wheelchair", travelMode: "motorcycle" },
    { mode: "visual_impaired", travelMode: "drive" },
    { mode: "visual_impaired", travelMode: "motorcycle" },
  ] as const)(
    "rejects an inferred self-driving tool for protected mode: $mode/$travelMode",
    async ({ mode, travelMode }) => {
      bridge.close();
      bridge = await createLiveBridge({
        ws,
        userId: "natural-actions",
        routingPreferences: {
          mode,
          travelMode: "transit",
          avoidStairs: true,
          requireElevator: true,
        },
      });
      await bridge.voiceReady;
      vi.mocked(resolveRouteOperation).mockResolvedValue(unspecifiedTrip());
      await transcript("幫我規劃臺北車站到淡水捷運站的路線");
      const result = await tool("planAccessibleRoute", {
        origin: "台北車站",
        destination: "淡水捷運站",
        travelMode,
      });
      expect(result).toMatchObject({
        ok: false,
        constraintViolation: "ACCESSIBILITY_TRAVEL_MODE_CONFLICT",
        allowedOperation: {
          preferences: { mode, avoidStairs: true, requireElevator: true },
          supportedTravelModes: ["transit", "walk"],
        },
      });
      expect(io.execute).not.toHaveBeenCalled();
      expect(frames().some((frame) => frame.type === "nav.start")).toBe(false);
    },
  );

  it("keeps an explicitly requested driving mode binding despite a model transit choice", async () => {
    vi.mocked(resolveRouteOperation).mockResolvedValue({
      ...unspecifiedTrip(),
      changes: {
        ...unclearRouteOperation().changes,
        mode: "normal",
        travelMode: "drive",
      },
      changeEvidence: {
        ...unclearRouteOperation().changeEvidence,
        travelMode: "開車",
      },
    });
    await transcript("從台北車站開車到淡水捷運站");
    const result = await tool("planAccessibleRoute", {
      origin: "台北車站",
      destination: "淡水捷運站",
      travelMode: "transit",
    });
    expect(result).toMatchObject({
      ok: false,
      constraintViolation: "PLAN_ARGUMENT_MISMATCH",
      allowedOperation: { travelModeConstraint: "explicit" },
    });
    expect(io.execute).not.toHaveBeenCalled();
  });

  it("keeps each comparison option binding without an extra transit plan", async () => {
    const op = unspecifiedTrip();
    vi.mocked(resolveRouteOperation).mockResolvedValue({
      ...op,
      action: "compare",
      changes: { ...op.changes, mode: "normal" },
      plans: [...op.plans, { ...op.plans[0], travelMode: "motorcycle" }],
    });
    await transcript("比較開車和騎機車到淡水捷運站");
    const result = await tool("planAccessibleRoute", {
      origin: "台北車站",
      destination: "淡水捷運站",
      travelMode: "transit",
    });
    expect(result).toMatchObject({
      ok: false,
      constraintViolation: "PLAN_ARGUMENT_MISMATCH",
      allowedOperation: { travelModeConstraint: "comparison" },
    });
    expect(io.execute).not.toHaveBeenCalled();
  });

  it.each(["drive", "transit", "motorcycle"] as const)(
    "binds an explicit travel preference over an inconsistent inferred plan: %s",
    async (travelMode) => {
      const op = unspecifiedTrip();
      vi.mocked(resolveRouteOperation).mockResolvedValue({
        ...op,
        changes: { ...op.changes, mode: "normal", travelMode: "drive" },
        changeEvidence: { ...op.changeEvidence, travelMode: "開車" },
        plans: [{ ...op.plans[0], travelMode: "transit" }],
      });
      await transcript("從台北車站開車到淡水捷運站");
      const result = await tool("planAccessibleRoute", {
        origin: "台北車站",
        destination: "淡水捷運站",
        travelMode,
      });
      expect(result.ok).toBe(travelMode === "drive");
      if (travelMode === "drive")
        expect(io.execute.mock.calls[0][1]).toMatchObject({
          travelMode: "drive",
        });
      else expect(io.execute).not.toHaveBeenCalled();
    },
  );

  it.each([
    { mode: "normal", actualTravel: "transit", explicitTravel: null, ok: true },
    {
      mode: "wheelchair",
      actualTravel: "transit",
      explicitTravel: null,
      ok: true,
    },
    {
      mode: "wheelchair",
      actualTravel: "drive",
      explicitTravel: null,
      ok: false,
    },
    {
      mode: "normal",
      actualTravel: "transit",
      explicitTravel: "drive",
      ok: false,
    },
  ] as const)(
    "applies transport constraint sources to discovery routing: %j",
    async ({ mode, actualTravel, explicitTravel, ok }) => {
      bridge.close();
      bridge = await createLiveBridge({
        ws,
        userId: "natural-actions",
        routingPreferences: {
          mode,
          travelMode: "drive",
          avoidStairs: true,
          requireElevator: true,
        },
      });
      await bridge.voiceReady;
      vi.mocked(resolveRouteOperation).mockResolvedValue({
        ...unclearRouteOperation(),
        action: "delegate",
        delegateKind: "discovery",
        evidence: "醫院",
        delegatedTools: ["planAccessibleRoute"],
        changes: {
          ...unclearRouteOperation().changes,
          travelMode: explicitTravel,
        },
        changeEvidence: {
          ...unclearRouteOperation().changeEvidence,
          travelMode: explicitTravel ? "開車" : "",
        },
      });
      await transcript(
        explicitTravel
          ? "找最近的醫院，開車過去"
          : "找最近的醫院，告訴我怎麼去",
      );
      expect(
        (
          await tool("planAccessibleRoute", {
            origin: "A",
            destination: "臺大醫院",
            travelMode: actualTravel,
          })
        ).ok,
      ).toBe(ok);
      if (ok)
        expect(io.execute.mock.calls[0][1]).toMatchObject({
          mode,
          travelMode: actualTravel,
          avoidStairs: true,
          requireElevator: true,
        });
      else expect(io.execute).not.toHaveBeenCalled();
      expect(frames().some((frame) => frame.type === "nav.start")).toBe(false);
    },
  );
});
