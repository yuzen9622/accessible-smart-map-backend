import { WebSocket } from "ws";
import { randomUUID } from "crypto";
import {
  FunctionCall,
  FunctionDeclaration,
  FunctionResponse,
  LiveConnectConfig,
  LiveServerMessage,
  Modality,
  Session,
} from "@google/genai";
import { googleGenAi } from "../../config/ai";
import { AGENT_TEMPERATURE } from "../../config/ai/config";
import { buildGeminiTools } from "../agent/tool-catalog";
import { executeLocalTool } from "../ai/agent-tools";
import { buildVoiceSystemPrompt } from "./voice-prompt";
import { normalizeVoiceTranscript } from "./transcript-normalizer";
import { correctUserTranscript } from "./transcript-corrector";
import { withCurrentDate } from "../../config/ai/chat-prompt";
import {
  getNavigationEnvelopeByToken,
  getRouteByToken,
} from "../accessible-route/route-token.service";
import { rerouteAccessibleRoute } from "../accessible-route/reroute.service";
import {
  deleteNavigationSnapshot,
  getNavigationSnapshot,
  storeNavigationSnapshot,
} from "../accessible-route/navigation-state.repository";
import { getMemorySettings, loadMemories } from "../ai/memory.service";
import { getTransitAlerts } from "../transit/alert.service";
import { onAlertSnapshotUpdate } from "../transit/alert.store";
import { keyRelevantToContext } from "../transit/alert.gateway";
import { NavigationSession, type NavEffect } from "./navigation-session";
import { scanRemainingCorridor } from "./corridor-monitor";
import type { RerouteReason } from "../accessible-route/accessible-route.types";
import type { NavPosition } from "./navigation.schema";
import {
  NavAdvisoryMessageSchema,
  NavResumeFailedMessageSchema,
  VoiceRerouteOutboundMessageSchema,
  type NavAdvisoryMessage,
  type NavResumeFailedMessage,
  type NavResumeMessage,
  type VoiceRerouteOutboundMessage,
} from "./voice.ws.schema";

const MAX_BUFFERED_BYTES = 1024 * 1024;
const ERROR_SUMMARY_MAX_CHARS = 200;
const INPUT_AUDIO_MIME_TYPE = "audio/pcm;rate=16000";
const POSITION_MIN_INTERVAL_MS = 500;
const REROUTE_COOLDOWN_MS = 30_000;
const CORRIDOR_SCAN_MIN_INTERVAL_MS = 20_000;
const SNAPSHOT_MIN_INTERVAL_MS = 5_000;
const TURN_TIMEOUT_MS = 15_000;
const TURN_TIMEOUT_STRIKES = 2;

type ActiveNavigation = {
  routeToken: string;
  navigationId: string;
  routeVersion: number;
  generation: number;
  /** From the canonical request; decides whether an outage is blocking. */
  requireElevator: boolean;
};

type RerouteGenerationState = {
  inFlight: boolean;
  lastStartedAt: number;
  clientRequestId?: string;
};

type AlertEffect = NavEffect & { rerouteReason: RerouteReason | null };

type VoiceState = "connecting" | "ready" | "unavailable";

type NavSnapshot = {
  generation: number;
  navigationId: string;
  routeVersion: number;
};

type LiveTurnState =
  "IDLE" | "USER_INPUT" | "TOOL_PENDING" | "AWAIT_MODEL" | "MODEL_OUTPUT";

const NAV_FUNCTIONS: FunctionDeclaration[] = [
  {
    name: "startNavigation",
    description: "開始已由使用者在畫面選定的無障礙路線導航",
    parametersJsonSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: "stopNavigation",
    description: "停止目前的逐步導航",
    parametersJsonSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: "repeatNavStep",
    description: "重播目前導航步驟",
    parametersJsonSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: "getActiveNavigationContext",
    description:
      "取得目前導航的步驟、目的地，以及目前或下一段大眾運輸資料；解析『那班公車』『下一段』『目的地』等指涉時使用",
    parametersJsonSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
];

/**
 * Resolves the Live session sampling temperature. Defaults to the shared
 * AGENT_TEMPERATURE (0, matching the text agent) and falls back to it for
 * empty, non-numeric, or out-of-range GEMINI_LIVE_TEMPERATURE values so a bad
 * env can never send NaN into the Live connect call.
 *
 * @returns A finite temperature in [0, 2].
 */
function parseLiveTemperature(): number {
  const raw = process.env.GEMINI_LIVE_TEMPERATURE;
  if (raw == null || raw.trim() === "") return AGENT_TEMPERATURE;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0 || n > 2) return AGENT_TEMPERATURE;
  return n;
}

/**
 * Resolves an optional output-synthesis language code from
 * GEMINI_LIVE_LANGUAGE_CODE. Returns undefined when unset or when the value
 * fails a coarse BCP-47 format check, so a typo degrades to "no speechConfig"
 * (current behavior) rather than a runtime Live connect failure.
 *
 * @returns A validated language code, or undefined to omit speechConfig.
 */
function parseLiveLanguageCode(): string | undefined {
  const raw = process.env.GEMINI_LIVE_LANGUAGE_CODE?.trim();
  if (!raw) return undefined;
  if (!/^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,4})*$/.test(raw)) return undefined;
  return raw;
}

export interface LiveBridgeOptions {
  ws: WebSocket;
  userId: string;
  userLocation?: { latitude: number; longitude: number };
}

export interface LiveBridge {
  sendAudio(data: Buffer): void;
  /** Resolves true only when the route is armed and ready to start. */
  armRouteToken(routeToken: string): Promise<boolean>;
  resumeNavigation(message: NavResumeMessage): Promise<void>;
  startNavigation(): void;
  updatePosition(position: NavPosition): void;
  cancelNav(): void;
  endSession(): void;
  close(): void;
  /**
   * Settles when the Gemini bootstrap has either connected or degraded.
   * Navigation never waits on it; it exists so tests can be deterministic.
   */
  readonly voiceReady: Promise<void>;
}

/**
 * Truncates an error message to a bounded length and strips values that could
 * identify a user (precise coordinates, long token-like strings).
 *
 * @param message The raw error message.
 * @returns A bounded, de-identified summary safe for server logs.
 */
function summarizeError(message?: string): string {
  const text = (message ?? "unknown error")
    .replace(/-?\d{1,3}\.\d{3,}/g, (m) => Number(m).toFixed(2))
    .replace(/[A-Za-z0-9_-]{25,}/g, "[redacted]");
  return text.slice(0, ERROR_SUMMARY_MAX_CHARS);
}

/**
 * Opens a Gemini Live API session bound to one authenticated WebSocket
 * connection: upstream PCM16/16kHz audio flows into the session, downstream
 * audio/transcripts/tool events flow back to the client, and model tool calls
 * are executed locally and returned to the session.
 *
 * @param options The client socket, authenticated user id, and optional location.
 * @returns A bridge handle for forwarding audio and closing the session.
 */
export async function createLiveBridge(
  options: LiveBridgeOptions,
): Promise<LiveBridge> {
  const { ws, userId, userLocation } = options;
  let session: Session | null = null;
  let voiceState: VoiceState = "connecting";
  let memoryEnabled = false;
  let closedByGateway = false;
  let disposed = false;
  let cumulativeTokens = 0;
  let liveState: LiveTurnState = "IDLE";
  let navSpeaking = false;
  let turnTimeout: ReturnType<typeof setTimeout> | null = null;
  let turnTimeoutStrikes = 0;
  let positionTimer: ReturnType<typeof setTimeout> | null = null;
  let lastPositionProcessedAt = 0;
  let latestPosition: NavPosition | null = userLocation ?? null;
  let userTranscriptBuffer = "";
  let utteranceSeq = 0;
  let currentUtteranceId: string | null = null;
  let armGen = 0;
  /**
   * Bumped whenever voice degrades. Messages queued under an older epoch are
   * dropped instead of replayed: a tool call the model emitted before the
   * session died must never reach navigation state after it.
   */
  let voiceEpoch = 0;
  let messageQueue = Promise.resolve();
  let pendingToolMessages = 0;
  let navSession = new NavigationSession();
  let activeNavigation: ActiveNavigation | null = null;
  let navigationGeneration = 0;
  let lastSnapshotPersistedAt = 0;
  const rerouteStateByGeneration = new Map<number, RerouteGenerationState>();
  let corridorScanInFlight = false;
  let corridorScanDirty = false;
  let transitAlertCheckInFlight = false;
  let transitAlertCheckDirty = false;
  let lastCorridorScanAt = 0;
  let corridorScanTimer: ReturnType<typeof setTimeout> | null = null;
  let pendingCriticalRerouteReason: RerouteReason | null = null;
  let pendingRouteArm: {
    armGeneration: number;
  } | null = null;
  let pendingResumeNavigationId: string | null = null;

  const sendJson = (payload: unknown): void => {
    if (!disposed && ws.readyState === WebSocket.OPEN)
      ws.send(JSON.stringify(payload));
  };

  const sendRerouteJson = (payload: VoiceRerouteOutboundMessage): void => {
    sendJson(VoiceRerouteOutboundMessageSchema.parse(payload));
  };

  const sendAdvisoryJson = (payload: NavAdvisoryMessage): void => {
    sendJson(NavAdvisoryMessageSchema.parse(payload));
  };

  /**
   * Drops the scan throttle so a new route is evaluated immediately. Advisory
   * dedup state lives in the NavigationSession and is cleared with it.
   * `corridorScanInFlight` is deliberately untouched — only the scan's own
   * `finally` may clear it, or two scans would overlap.
   */
  const resetCorridorState = (): void => {
    corridorScanDirty = false;
    lastCorridorScanAt = 0;
    if (corridorScanTimer) {
      clearTimeout(corridorScanTimer);
      corridorScanTimer = null;
    }
    pendingCriticalRerouteReason = null;
  };

  const sendResumeFailed = (payload: NavResumeFailedMessage): void => {
    sendJson(NavResumeFailedMessageSchema.parse(payload));
  };

  /**
   * Clears the speech pipeline when nothing will ever play it. The leading
   * onTurnComplete() is mandatory: takeNextSpeech() returns null while
   * currentSpeechText is set, so a line cut off mid-turn would otherwise wedge
   * the queue shut and enqueueSpeech() would start concatenating every later
   * line onto one unbounded string once SPEECH_QUEUE_MAX is reached.
   */
  const drainNavigationSpeech = (): void => {
    navSession.onTurnComplete();
    while (navSession.takeNextSpeech()) navSession.onTurnComplete();
  };

  /**
   * Ends voice playback without touching navigation. One-way and idempotent:
   * the Gemini session is not re-established on this connection. The client
   * socket is deliberately left open — alerts and reroutes keep flowing.
   */
  const markVoiceUnavailable = (
    code: "LIVE_CONNECT_FAILED" | "LIVE_SESSION_ENDED",
  ): void => {
    if (disposed || voiceState === "unavailable") return;
    voiceState = "unavailable";
    voiceEpoch++;
    const ending = session;
    session = null;
    navSpeaking = false;
    turnTimeoutStrikes = 0;
    clearTurnTimeout();
    liveState = "IDLE";
    try {
      ending?.close();
    } catch (err) {
      console.warn(
        "[voice] live session close failed:",
        summarizeError(err instanceof Error ? err.message : String(err)),
      );
    }
    sendJson({ type: "error", code });
    drainNavigationSpeech();
  };

  /**
   * Mirrors turn-by-turn progress to Redis so a backgrounded or disconnected
   * client can resume mid-route. Throttled on ordinary position ticks and
   * forced on the transitions worth losing nothing over.
   */
  const persistNavigationSnapshot = (force = false): void => {
    const navigation = activeNavigation;
    if (disposed || !navigation) return;
    const state = navSession.getSnapshotState();
    if (!state) return;
    const now = Date.now();
    if (!force && now - lastSnapshotPersistedAt < SNAPSHOT_MIN_INTERVAL_MS)
      return;
    lastSnapshotPersistedAt = now;
    void storeNavigationSnapshot({
      navigationId: navigation.navigationId,
      userId,
      routeToken: navigation.routeToken,
      routeVersion: navigation.routeVersion,
      currentStepIndex: state.currentStepIndex,
      onVehicle: state.onVehicle,
      latestPosition: latestPosition
        ? {
            latitude: latestPosition.latitude,
            longitude: latestPosition.longitude,
            ...(latestPosition.heading === undefined
              ? {}
              : { heading: latestPosition.heading }),
          }
        : null,
      updatedAt: now,
    });
  };

  const applyEffect = (effect: NavEffect): void => {
    for (const event of effect.events) sendJson(event);
    if (
      effect.events.some(
        (e) =>
          e.type === "nav.arrived" ||
          (e.type === "nav.stop" &&
            (e.reason === "arrived" ||
              e.reason === "user_voice" ||
              e.reason === "user_ui" ||
              e.reason === "session_end")),
      )
    ) {
      const idsToDelete = new Set<string>();
      if (activeNavigation?.navigationId)
        idsToDelete.add(activeNavigation.navigationId);
      if (pendingResumeNavigationId) idsToDelete.add(pendingResumeNavigationId);
      armGen++;
      navigationGeneration++;
      pruneRerouteState();
      pendingRouteArm = null;
      pendingResumeNavigationId = null;
      activeNavigation = null;
      lastSnapshotPersistedAt = 0;
      resetCorridorState();
      // A deliberate end must not leave a snapshot a later reconnect could
      // resume from; an unannounced disconnect leaves it to expire on its TTL.
      for (const id of idsToDelete) {
        void Promise.resolve(deleteNavigationSnapshot(id, userId)).catch(
          () => {},
        );
      }
    }
  };

  /**
   * The single path every alert source takes: escalate to a reroute when the
   * effect demands one, downgrade `reroute_applied` to `reroute_suggested`
   * when the reroute could not actually run, broadcast the advisory, then let
   * speech drain. Transit alerts and corridor findings must never diverge.
   *
   * `snapshot` is the navigation the effect was computed against. A reroute we
   * performed ourselves legitimately supersedes it; any other replacement
   * means this advisory describes a route the user has already left.
   */
  const dispatchAlertEffect = async (
    effect: AlertEffect,
    snapshot: NavSnapshot,
  ): Promise<void> => {
    if (disposed) return;
    let canReroute = false;
    if (effect.rerouteReason) {
      if (!latestPosition) {
        pendingCriticalRerouteReason = effect.rerouteReason;
      } else {
        canReroute = await rerouteForReason(
          effect.rerouteReason,
          latestPosition,
        );
      }
    }
    if (disposed) return;
    if (!canReroute && !isCurrentReroute(snapshot)) return;
    const navigation = activeNavigation;
    if (!navigation) return;
    for (const event of effect.events) {
      if (event.type !== "nav.advisory") continue;
      sendAdvisoryJson({
        type: "nav.advisory",
        navigationId: navigation.navigationId,
        routeVersion: navigation.routeVersion,
        advisories: event.advisories.map((a) =>
          a.action === "reroute_applied" && !canReroute
            ? { ...a, action: "reroute_suggested" as const }
            : a,
        ),
      });
    }
    driveNavigationSpeech();
  };

  const checkCurrentTransitAlerts = async (
    sourceStoreKey?: string,
  ): Promise<void> => {
    if (disposed) return;
    const transitCtx = navSession.getCurrentTransitAlertContext();
    if (!transitCtx) return;
    if (sourceStoreKey && !keyRelevantToContext(sourceStoreKey, transitCtx)) {
      return;
    }
    // A TDX MQTT burst fans out to one callback per message. Without this the
    // same key would launch concurrent getTransitAlerts() calls; fold them into
    // the in-flight one plus at most one catch-up pass.
    if (transitAlertCheckInFlight) {
      transitAlertCheckDirty = true;
      return;
    }
    transitAlertCheckInFlight = true;
    transitAlertCheckDirty = false;
    const snapshot: NavSnapshot = {
      generation: navigationGeneration,
      navigationId: activeNavigation?.navigationId ?? "",
      routeVersion: activeNavigation?.routeVersion ?? 0,
    };
    try {
      const result = await getTransitAlerts(transitCtx);
      if (disposed || !isCurrentReroute(snapshot)) return;
      if (result.ok && result.alerts.length > 0) {
        await dispatchAlertEffect(
          navSession.onTransitAlerts(result.alerts),
          snapshot,
        );
      }
    } catch (err) {
      console.warn("[voice] transit alert check failed", err);
    } finally {
      transitAlertCheckInFlight = false;
      if (transitAlertCheckDirty && !disposed) {
        transitAlertCheckDirty = false;
        // Re-read the live context rather than replaying the stale store key.
        void checkCurrentTransitAlerts();
      }
    }
  };

  // Alert delivery is bound to the client connection, not to voice: a bridge
  // with no Gemini session must still detect, broadcast and reroute on alerts.
  const unsubscribeAlerts = onAlertSnapshotUpdate((key: string) => {
    if (disposed) return;
    void checkCurrentTransitAlerts(key);
    void runCorridorScan();
  });

  const clearTurnTimeout = (): void => {
    if (turnTimeout) clearTimeout(turnTimeout);
    turnTimeout = null;
  };

  const startTurnTimeout = (): void => {
    clearTurnTimeout();
    turnTimeout = setTimeout(() => {
      if (disposed || !navSpeaking || liveState === "IDLE") return;
      turnTimeoutStrikes++;
      console.warn(
        "[voice] navigation turn timed out",
        JSON.stringify({ strikes: turnTimeoutStrikes }),
      );
      if (turnTimeoutStrikes >= TURN_TIMEOUT_STRIKES) {
        // A stuck model turn is a voice-quality failure. Navigation, alerts and
        // the client socket all survive it; only playback stops. The Gemini
        // session really is closed here, so LIVE_SESSION_ENDED is accurate and
        // no new frame type is needed.
        markVoiceUnavailable("LIVE_SESSION_ENDED");
        return;
      }
      startTurnTimeout();
    }, TURN_TIMEOUT_MS);
  };

  const driveNavigationSpeech = (): void => {
    if (disposed) return;
    if (voiceState === "unavailable") {
      drainNavigationSpeech();
      return;
    }
    if (!session || ws.readyState !== WebSocket.OPEN) return;
    if (liveState !== "IDLE" || navSpeaking || pendingToolMessages > 0) return;
    const text = navSession.takeNextSpeech();
    if (!text) return;
    try {
      session.sendClientContent({
        turns: `請逐字唸出以下導航指引，不得增減內容：${text}`,
        turnComplete: true,
      });
    } catch (err) {
      // A dead Live socket must not throw out through updatePosition() or the
      // alert pipeline. Degrade instead; markVoiceUnavailable() releases the
      // line we just took.
      console.error(
        "[voice] sendClientContent failed:",
        summarizeError(err instanceof Error ? err.message : String(err)),
      );
      markVoiceUnavailable("LIVE_SESSION_ENDED");
      return;
    }
    navSpeaking = true;
    liveState = "AWAIT_MODEL";
    startTurnTimeout();
  };

  /**
   * Drops reroute bookkeeping for generations that are neither current nor
   * still settling, so a superseded generation can never gate a newer one.
   */
  const pruneRerouteState = (): void => {
    for (const [generation, state] of rerouteStateByGeneration) {
      if (!state.inFlight && generation !== navigationGeneration) {
        rerouteStateByGeneration.delete(generation);
      }
    }
  };

  const isCurrentReroute = (snapshot: {
    generation: number;
    navigationId: string;
    routeVersion: number;
  }): boolean =>
    !disposed &&
    navigationGeneration === snapshot.generation &&
    activeNavigation?.generation === snapshot.generation &&
    activeNavigation?.navigationId === snapshot.navigationId &&
    activeNavigation.routeVersion === snapshot.routeVersion;

  const rerouteForReason = async (
    reason: RerouteReason,
    triggerPosition: NavPosition | null = latestPosition,
  ): Promise<boolean> => {
    const navigation = activeNavigation;
    const now = Date.now();
    if (
      disposed ||
      !navigation ||
      navigation.generation !== navigationGeneration ||
      !triggerPosition
    ) {
      if (reason !== "OFF_ROUTE") {
        pendingCriticalRerouteReason = reason;
      }
      return false;
    }
    const ownState = rerouteStateByGeneration.get(navigation.generation);
    if (ownState?.inFlight) {
      if (reason !== "OFF_ROUTE") {
        pendingCriticalRerouteReason = reason;
      }
      return false;
    }
    if (
      reason === "OFF_ROUTE" &&
      ownState &&
      now - ownState.lastStartedAt < REROUTE_COOLDOWN_MS
    ) {
      return false;
    }
    const clientRequestId = ownState?.clientRequestId ?? randomUUID();
    rerouteStateByGeneration.set(navigation.generation, {
      inFlight: true,
      lastStartedAt: now,
      clientRequestId,
    });
    const snapshot = {
      generation: navigation.generation,
      navigationId: navigation.navigationId,
      routeVersion: navigation.routeVersion,
    };
    const rerouteRequest = {
      routeToken: navigation.routeToken,
      currentPosition: triggerPosition,
      previousRouteVersion: navigation.routeVersion,
      reason,
      clientRequestId,
    };
    sendRerouteJson({
      type: "nav.rerouting",
      navigationId: navigation.navigationId,
      previousRouteVersion: rerouteRequest.previousRouteVersion,
      clientRequestId: rerouteRequest.clientRequestId,
      reason,
    });
    try {
      const result = await rerouteAccessibleRoute(rerouteRequest);
      if (!isCurrentReroute(snapshot)) return false;
      if (!result.ok) {
        sendRerouteJson({
          type: "nav.reroute_failed",
          navigationId: navigation.navigationId,
          previousRouteVersion: rerouteRequest.previousRouteVersion,
          code: result.status,
          message: result.error,
          retryable: result.status === 429 || result.status >= 500,
        });
        return false;
      }
      const replacement = new NavigationSession();
      const armed = replacement.armRoute(result.data.route);
      const started = replacement.start(latestPosition ?? undefined);
      const startEvent = started.events.find(
        (event) => event.type === "nav.start",
      );
      if (
        !armed.ok ||
        !started.ok ||
        !startEvent ||
        startEvent.type !== "nav.start"
      ) {
        if (!isCurrentReroute(snapshot)) return false;
        sendRerouteJson({
          type: "nav.reroute_failed",
          navigationId: navigation.navigationId,
          previousRouteVersion: rerouteRequest.previousRouteVersion,
          code: "NAV_ROUTE_INVALID",
          message: "替代路線無法啟動",
          retryable: false,
        });
        return false;
      }
      if (!isCurrentReroute(snapshot)) return false;
      const replacementGeneration = ++navigationGeneration;
      rerouteStateByGeneration.set(replacementGeneration, {
        inFlight: false,
        lastStartedAt: now,
      });
      navSession = replacement;
      activeNavigation = {
        routeToken: result.data.routeToken,
        navigationId: result.data.navigationId,
        routeVersion: result.data.routeVersion,
        generation: replacementGeneration,
        requireElevator: navigation.requireElevator,
      };
      sendRerouteJson({
        type: "nav.route_replaced",
        navigationId: result.data.navigationId,
        previousRouteVersion: result.data.previousRouteVersion,
        routeVersion: result.data.routeVersion,
        routeToken: result.data.routeToken,
        route: result.data.route,
        steps: startEvent.steps,
        warnings: result.data.warnings,
        currentStepIndex: 0,
        reason,
      });
      resetCorridorState();
      persistNavigationSnapshot(true);
      driveNavigationSpeech();
    } catch (err) {
      if (isCurrentReroute(snapshot)) {
        sendRerouteJson({
          type: "nav.reroute_failed",
          navigationId: navigation.navigationId,
          previousRouteVersion: rerouteRequest.previousRouteVersion,
          code: "REROUTE_FAILED",
          message: summarizeError(
            err instanceof Error ? err.message : String(err),
          ),
          retryable: true,
        });
      }
      // Falling through to the trailing `return true` would tell the caller the
      // route was replaced when it was not, leaving advisories on
      // `reroute_applied`.
      return false;
    } finally {
      const settled = rerouteStateByGeneration.get(snapshot.generation);
      if (settled) settled.inFlight = false;
      pruneRerouteState();
    }
    return true;
  };

  const rerouteAfterOffRoute = async (): Promise<void> => {
    void (await rerouteForReason("OFF_ROUTE"));
  };

  /**
   * The only way navigation starts. Reached from the WS `nav.start` frame and
   * from the Gemini `startNavigation` tool call, so both produce identical
   * state, persistence and alert scheduling.
   */
  const startNavigation = (): { ok: boolean } => {
    if (disposed) return { ok: false };
    if (positionTimer) {
      clearTimeout(positionTimer);
      positionTimer = null;
    }
    const effect = navSession.start(latestPosition ?? undefined);
    applyEffect(effect);
    if (effect.ok) {
      persistNavigationSnapshot(true);
      void checkCurrentTransitAlerts();
      void runCorridorScan();
      driveNavigationSpeech();
    }
    return { ok: effect.ok };
  };

  /**
   * Scans the corridor ahead, broadcasts advisories and triggers a
   * reason-carrying reroute when a blocking event is found. Throttling,
   * mutual exclusion and generation binding all live here, so callers may
   * trigger unconditionally.
   */
  const runCorridorScan = async (): Promise<void> => {
    const navigation = activeNavigation;
    if (
      disposed ||
      !navigation ||
      navigation.generation !== navigationGeneration
    )
      return;
    const now = Date.now();
    if (
      corridorScanInFlight ||
      now - lastCorridorScanAt < CORRIDOR_SCAN_MIN_INTERVAL_MS
    ) {
      corridorScanDirty = true;
      if (!corridorScanTimer && !corridorScanInFlight) {
        const delay = Math.max(
          100,
          CORRIDOR_SCAN_MIN_INTERVAL_MS - (now - lastCorridorScanAt),
        );
        corridorScanTimer = setTimeout(() => {
          corridorScanTimer = null;
          void runCorridorScan();
        }, delay);
      }
      return;
    }
    const corridor = navSession.getRemainingCorridor();
    if (!corridor) return;

    corridorScanInFlight = true;
    lastCorridorScanAt = now;
    corridorScanDirty = false;
    const scanGeneration = navigation.generation;
    try {
      const findings = await scanRemainingCorridor(corridor);
      if (disposed || navigationGeneration !== scanGeneration) return;
      if (!findings.length) return;
      await dispatchAlertEffect(
        navSession.onCorridorFindings(findings, {
          requireElevator: navigation.requireElevator,
        }),
        {
          generation: scanGeneration,
          navigationId: navigation.navigationId,
          routeVersion: navigation.routeVersion,
        },
      );
    } catch (err) {
      console.warn("[voice] corridor scan failed", err);
    } finally {
      corridorScanInFlight = false;
      if (corridorScanDirty && !disposed && activeNavigation) {
        corridorScanDirty = false;
        if (!corridorScanTimer) {
          corridorScanTimer = setTimeout(() => {
            corridorScanTimer = null;
            void runCorridorScan();
          }, CORRIDOR_SCAN_MIN_INTERVAL_MS);
        }
      }
    }
  };

  const forwardAudio = (base64Data: string): void => {
    if (ws.readyState !== WebSocket.OPEN) return;
    if (ws.bufferedAmount > MAX_BUFFERED_BYTES) {
      console.warn(
        "[voice] dropping downstream audio frame",
        JSON.stringify({ bufferedAmount: ws.bufferedAmount }),
      );
      return;
    }
    ws.send(Buffer.from(base64Data, "base64"), { binary: true });
  };

  const handleToolCalls = async (
    functionCalls: FunctionCall[],
    msgEpoch: number,
  ): Promise<void> => {
    // Re-read through a call: voice can degrade across any await below, and a
    // tool from a dead session must not reach startNavigation/stopNavigation.
    const voiceCurrent = (): boolean =>
      !disposed && voiceState === "ready" && msgEpoch === voiceEpoch;
    const functionResponses: FunctionResponse[] = [];
    for (const call of functionCalls) {
      if (!voiceCurrent()) return;
      const name = call.name ?? "";
      if (navSpeaking) {
        functionResponses.push({
          id: call.id,
          name,
          response: { error: "navigation speech turn cannot execute tools" },
        });
        continue;
      }
      sendJson({ type: "tool_call", name });
      const startedAt = Date.now();
      let ok = true;
      let response: Record<string, unknown>;
      let toolResult: unknown;
      try {
        let result: string;
        if (name === "startNavigation") {
          const { ok: started } = startNavigation();
          result = JSON.stringify({
            ok: started,
            message: started ? "已開始導航" : "尚未選擇路線",
          });
        } else if (name === "stopNavigation") {
          applyEffect(navSession.stop("user_voice"));
          armGen++;
          pendingRouteArm = null;
          navigationGeneration++;
          pruneRerouteState();
          activeNavigation = null;
          result = JSON.stringify({ ok: true, message: "已停止導航" });
        } else if (name === "repeatNavStep") {
          applyEffect(navSession.repeatCurrent());
          result = JSON.stringify({ ok: true, message: "將重播目前步驟" });
        } else if (name === "getActiveNavigationContext") {
          result = JSON.stringify(navSession.getConversationContext());
        } else {
          result = await executeLocalTool(
            name,
            (call.args ?? {}) as Record<string, unknown>,
            latestPosition ?? userLocation,
            userId,
            {
              allowMemoryWrite: memoryEnabled,
            },
          );
        }
        response = { output: result };
        try {
          toolResult = JSON.parse(result);
        } catch {
          toolResult = { result };
        }
      } catch (err) {
        ok = false;
        response = {
          error: summarizeError(
            err instanceof Error ? err.message : String(err),
          ),
        };
      }
      if (!voiceCurrent()) return;
      const durationMs = Date.now() - startedAt;
      console.log(
        "[voice] tool",
        JSON.stringify({
          tool: name,
          ok,
          durationMs,
          ...(ok ? {} : { error: response.error }),
        }),
      );
      sendJson({
        type: "tool_result",
        name,
        ok,
        durationMs,
        result: toolResult,
        args: call.args ?? {},
      });
      functionResponses.push({ id: call.id, name, response });
    }
    if (voiceCurrent() && session)
      session.sendToolResponse({ functionResponses });
  };

  /**
   * Closes the current user utterance. The final text is emitted synchronously
   * with the raw (uncorrected) transcript so it can never land after the model
   * transcript of the turn it belongs to — homophone correction needs an LLM
   * round-trip (up to 2.5s) and used to push this frame into the middle of the
   * model's output stream. The corrected text follows later as a separate
   * `transcript.correction` frame carrying the same `utteranceId`.
   */
  const finalizeUserTranscript = (): void => {
    const raw = userTranscriptBuffer.trim();
    const utteranceId = currentUtteranceId;
    userTranscriptBuffer = "";
    currentUtteranceId = null;
    if (!raw || !utteranceId) return;
    sendJson({
      type: "transcript",
      role: "user",
      text: raw,
      final: true,
      utteranceId,
    });
    void correctUserTranscript(raw)
      .then((corrected) => {
        if (disposed) return;
        const cleaned = corrected.trim();
        if (!cleaned || cleaned === raw) return;
        sendJson({
          type: "transcript.correction",
          role: "user",
          text: cleaned,
          utteranceId,
        });
      })
      .catch((err) => {
        console.warn(
          "[voice] transcript correction failed:",
          summarizeError(err instanceof Error ? err.message : String(err)),
        );
      });
  };

  const handleServerMessage = async (
    message: LiveServerMessage,
    msgEpoch: number,
  ): Promise<void> => {
    // The queue can hold this message across a degradation; replaying it would
    // drive navigation from a session that no longer exists.
    if (disposed || voiceState !== "ready" || msgEpoch !== voiceEpoch) return;
    const content = message.serverContent;
    if (content) {
      if (content.modelTurn?.parts?.length) {
        liveState = "MODEL_OUTPUT";
        if (userTranscriptBuffer.trim()) finalizeUserTranscript();
      }
      for (const part of content.modelTurn?.parts ?? []) {
        if (part.inlineData?.data) forwardAudio(part.inlineData.data);
      }
      if (content.inputTranscription) {
        if (content.inputTranscription.text) {
          liveState = "USER_INPUT";
          const piece = normalizeVoiceTranscript(
            content.inputTranscription.text,
          );
          if (!currentUtteranceId) currentUtteranceId = `u${++utteranceSeq}`;
          userTranscriptBuffer += piece;
          sendJson({
            type: "transcript",
            role: "user",
            text: piece,
            final: false,
            utteranceId: currentUtteranceId,
          });
        }
        if (content.inputTranscription.finished) finalizeUserTranscript();
      }
      if (content.outputTranscription?.text) {
        sendJson({
          type: "transcript",
          role: "model",
          text: normalizeVoiceTranscript(content.outputTranscription.text),
        });
      }
      if (content.interrupted) {
        if (userTranscriptBuffer.trim()) finalizeUserTranscript();
        navSession.onInterrupted();
        navSpeaking = false;
        clearTurnTimeout();
        liveState = "USER_INPUT";
        sendJson({ type: "interrupted" });
      }
    }
    if (message.toolCall?.functionCalls?.length) {
      if (content?.interrupted) return;
      liveState = "TOOL_PENDING";
      await handleToolCalls(message.toolCall.functionCalls, msgEpoch);
      if (!disposed && voiceState === "ready" && msgEpoch === voiceEpoch)
        liveState = "AWAIT_MODEL";
    } else if (content?.turnComplete && !content.interrupted) {
      if (userTranscriptBuffer.trim()) finalizeUserTranscript();
      if (navSpeaking) navSession.onTurnComplete();
      navSpeaking = false;
      turnTimeoutStrikes = 0;
      clearTurnTimeout();
      liveState = "IDLE";
      sendJson({ type: "turn.complete" });
      driveNavigationSpeech();
    }
    if (message.usageMetadata?.totalTokenCount != null) {
      cumulativeTokens += message.usageMetadata.totalTokenCount;
      console.log("[voice] usage", JSON.stringify({ cumulativeTokens }));
    }
  };

  // Read through a call so control-flow analysis cannot narrow `voiceState`
  // across an await: markVoiceUnavailable() may flip it while one is pending.
  const voiceUnavailable = (): boolean => voiceState === "unavailable";

  /**
   * Everything Gemini needs, off the critical path. Never rejects: navigation
   * readiness must not depend on memory lookups or a Live handshake. Anything
   * throwing during bootstrap lands on a settled `unavailable` state, ensuring
   * voiceReady never rejects unhandled and voiceState transitions to "unavailable".
   */
  const bootstrapVoice = async (): Promise<void> => {
    try {
      let memories: Array<{
        _id?: unknown;
        category: string;
        promptText?: string;
        content: string;
      }> = [];
      if (userId) {
        try {
          const settings = await getMemorySettings(userId);
          memoryEnabled = settings.memoryEnabled;
          if (memoryEnabled) {
            memories = await loadMemories(userId, 20);
          }
        } catch (err) {
          console.error(
            "[voice] loadMemories failed:",
            summarizeError(err instanceof Error ? err.message : String(err)),
          );
        }
      }
      if (disposed || voiceUnavailable()) return;

      const liveConfig: LiveConnectConfig = {
        responseModalities: [Modality.AUDIO],
        inputAudioTranscription: {},
        outputAudioTranscription: {},
        systemInstruction: withCurrentDate(
          buildVoiceSystemPrompt(userLocation, memories, { memoryEnabled }),
        ),
        tools: [
          ...buildGeminiTools(userId, memoryEnabled),
          { functionDeclarations: NAV_FUNCTIONS },
        ],
        temperature: parseLiveTemperature(),
      };
      const languageCode = parseLiveLanguageCode();
      if (languageCode) liveConfig.speechConfig = { languageCode };

      const connected = await googleGenAi.live.connect({
        model: process.env.GEMINI_LIVE_MODEL ?? "gemini-3.1-flash-live-preview",
        config: liveConfig,
        callbacks: {
          onmessage: (message: LiveServerMessage) => {
            const hasToolCalls = Boolean(
              message.toolCall?.functionCalls?.length,
            );
            if (hasToolCalls) pendingToolMessages++;
            const msgEpoch = voiceEpoch;
            messageQueue = messageQueue
              .then(() => handleServerMessage(message, msgEpoch))
              .catch((err) => {
                console.error(
                  "[voice] server message handling failed:",
                  summarizeError(
                    err instanceof Error ? err.message : String(err),
                  ),
                );
              })
              .finally(() => {
                if (hasToolCalls)
                  pendingToolMessages = Math.max(0, pendingToolMessages - 1);
              });
          },
          onerror: (e) => {
            console.error(
              "[voice] live session error:",
              summarizeError(e?.message),
            );
            // Errors on the Live socket are terminal for playback but harmless
            // to navigation. Degrade rather than let a later send throw.
            if (!closedByGateway) markVoiceUnavailable("LIVE_SESSION_ENDED");
          },
          onclose: () => {
            // Gemini hanging up must never hang up on the client: navigation
            // and alerts keep running on this same socket.
            if (closedByGateway) return;
            markVoiceUnavailable("LIVE_SESSION_ENDED");
          },
        },
      });

      if (disposed || voiceUnavailable()) {
        try {
          connected.close();
        } catch {
          /* already gone */
        }
        return;
      }
      session = connected;
      voiceState = "ready";
      driveNavigationSpeech();
    } catch (err) {
      console.error(
        "[voice] live connect failed:",
        summarizeError(err instanceof Error ? err.message : String(err)),
      );
      markVoiceUnavailable("LIVE_CONNECT_FAILED");
    }
  };

  const voiceReady = bootstrapVoice();

  return {
    sendAudio(data: Buffer): void {
      if (disposed || !session) return;
      liveState = "USER_INPUT";
      session?.sendRealtimeInput({
        audio: {
          data: data.toString("base64"),
          mimeType: INPUT_AUDIO_MIME_TYPE,
        },
      });
    },
    async armRouteToken(routeToken: string): Promise<boolean> {
      const generation = ++armGen;
      const arm = { armGeneration: generation };
      pendingRouteArm = arm;
      const isCurrentArm = (): boolean =>
        !disposed && arm.armGeneration === armGen && pendingRouteArm === arm;
      try {
        const [route, envelope] = await Promise.all([
          getRouteByToken(routeToken),
          getNavigationEnvelopeByToken(routeToken),
        ]);
        if (!isCurrentArm()) return false;
        if (!route) {
          pendingRouteArm = null;
          // The client asked to replace the route and the replacement is gone.
          // Leaving the previous one armed would let a later nav.start run a
          // route the user already navigated away from, so drop it. cancel()
          // only clears a *started* session, hence the fresh NavigationSession
          // for the armed-but-not-started case.
          applyEffect(navSession.cancel());
          navSession.dispose();
          navSession = new NavigationSession();
          activeNavigation = null;
          navigationGeneration++;
          pruneRerouteState();
          resetCorridorState();
          applyEffect({
            ok: false,
            events: [
              {
                type: "nav.error",
                code: "NAV_ROUTE_INVALID",
                message: "路線已過期，請重新規劃",
              },
            ],
          });
          return false;
        }
        const committedGeneration = ++navigationGeneration;
        pruneRerouteState();
        pendingRouteArm = null;
        applyEffect(navSession.armRoute(route));
        activeNavigation = envelope
          ? {
              routeToken,
              navigationId: envelope.navigationId,
              routeVersion: envelope.routeVersion,
              generation: committedGeneration,
              requireElevator:
                envelope.canonicalRequest?.requireElevator ?? false,
            }
          : null;
        resetCorridorState();
        return true;
      } catch (err) {
        if (isCurrentArm()) pendingRouteArm = null;
        throw err;
      }
    },
    startNavigation(): void {
      startNavigation();
    },
    async resumeNavigation(message: NavResumeMessage): Promise<void> {
      if (disposed) return;
      const arm = { armGeneration: ++armGen };
      pendingRouteArm = arm;
      pendingResumeNavigationId = message.navigationId;
      const isCurrentArm = (): boolean =>
        !disposed && arm.armGeneration === armGen && pendingRouteArm === arm;
      const fail = (
        code: NavResumeFailedMessage["code"],
        text: string,
      ): void => {
        if (!isCurrentArm()) return;
        pendingRouteArm = null;
        pendingResumeNavigationId = null;
        sendResumeFailed({
          type: "nav.resume_failed",
          navigationId: message.navigationId,
          code,
          message: text,
          retryable: false,
        });
      };
      try {
        const snapshot = await getNavigationSnapshot(message.navigationId);
        if (!isCurrentArm()) return;
        if (!snapshot) {
          fail("SNAPSHOT_NOT_FOUND", "導航進度已過期，請重新規劃");
          return;
        }
        if (snapshot.userId !== userId) {
          fail("USER_MISMATCH", "導航進度不屬於此帳號");
          return;
        }
        if (
          snapshot.routeVersion !== message.routeVersion ||
          snapshot.routeToken !== message.routeToken
        ) {
          fail("ROUTE_VERSION_MISMATCH", "導航版本已更新，請重新規劃");
          return;
        }
        const [route, envelope] = await Promise.all([
          getRouteByToken(snapshot.routeToken),
          getNavigationEnvelopeByToken(snapshot.routeToken),
        ]);
        if (!isCurrentArm()) return;
        if (
          !route ||
          !envelope ||
          envelope.navigationId !== snapshot.navigationId ||
          envelope.routeVersion !== snapshot.routeVersion
        ) {
          fail("ROUTE_EXPIRED", "路線已過期，請重新規劃");
          return;
        }
        const resumePosition =
          message.currentPosition ?? snapshot.latestPosition ?? undefined;
        const committedGeneration = ++navigationGeneration;
        pruneRerouteState();
        pendingRouteArm = null;
        pendingResumeNavigationId = null;
        if (positionTimer) {
          clearTimeout(positionTimer);
          positionTimer = null;
        }
        const effect = navSession.resume(route, snapshot, resumePosition);
        if (!effect.ok) {
          activeNavigation = null;
          applyEffect(effect);
          fail("ROUTE_EXPIRED", "路線已過期，請重新規劃");
          return;
        }
        if (resumePosition) latestPosition = resumePosition;
        activeNavigation = {
          routeToken: snapshot.routeToken,
          navigationId: snapshot.navigationId,
          routeVersion: snapshot.routeVersion,
          generation: committedGeneration,
          requireElevator: envelope.canonicalRequest?.requireElevator ?? false,
        };
        resetCorridorState();
        applyEffect(effect);
        persistNavigationSnapshot(true);
        void checkCurrentTransitAlerts();
        driveNavigationSpeech();
      } catch (err) {
        if (!isCurrentArm()) return;
        pendingRouteArm = null;
        pendingResumeNavigationId = null;
        console.warn(
          "[voice] nav.resume failed",
          summarizeError(err instanceof Error ? err.message : String(err)),
        );
        sendResumeFailed({
          type: "nav.resume_failed",
          navigationId: message.navigationId,
          code: "SNAPSHOT_NOT_FOUND",
          message: "無法恢復導航，請重新規劃",
          retryable: true,
        });
      }
    },
    updatePosition(position: NavPosition): void {
      if (disposed) return;
      latestPosition = position;
      const now = Date.now();
      const elapsed = now - lastPositionProcessedAt;
      const processLatest = () => {
        positionTimer = null;
        if (disposed || !latestPosition) return;
        lastPositionProcessedAt = Date.now();
        const effect = navSession.onPosition(latestPosition);
        applyEffect(effect);
        persistNavigationSnapshot(
          effect.events.some(
            (event) =>
              event.type === "nav.step" || event.type === "nav.transit",
          ),
        );
        if (effect.events.some((event) => event.type === "nav.offroute")) {
          void rerouteAfterOffRoute();
        }
        if (pendingCriticalRerouteReason) {
          const reason = pendingCriticalRerouteReason;
          pendingCriticalRerouteReason = null;
          void rerouteForReason(reason, latestPosition);
        }
        if (
          effect.events.some(
            (e) => e.type === "nav.transit" || e.type === "nav.start",
          )
        ) {
          void checkCurrentTransitAlerts();
        }
        void runCorridorScan();
        driveNavigationSpeech();
      };
      if (
        lastPositionProcessedAt === 0 ||
        elapsed >= POSITION_MIN_INTERVAL_MS
      ) {
        if (positionTimer) clearTimeout(positionTimer);
        processLatest();
        return;
      }
      if (!positionTimer) {
        positionTimer = setTimeout(
          processLatest,
          POSITION_MIN_INTERVAL_MS - elapsed,
        );
      }
    },
    cancelNav(): void {
      const idsToDelete = new Set<string>();
      if (activeNavigation?.navigationId)
        idsToDelete.add(activeNavigation.navigationId);
      if (pendingResumeNavigationId) idsToDelete.add(pendingResumeNavigationId);
      armGen++;
      navigationGeneration++;
      pruneRerouteState();
      pendingRouteArm = null;
      pendingResumeNavigationId = null;
      if (positionTimer) clearTimeout(positionTimer);
      positionTimer = null;
      resetCorridorState();
      applyEffect(navSession.cancel());
      activeNavigation = null;
      for (const id of idsToDelete) {
        void Promise.resolve(deleteNavigationSnapshot(id, userId)).catch(
          () => {},
        );
      }
    },
    endSession(): void {
      const idsToDelete = new Set<string>();
      if (activeNavigation?.navigationId)
        idsToDelete.add(activeNavigation.navigationId);
      if (pendingResumeNavigationId) idsToDelete.add(pendingResumeNavigationId);
      armGen++;
      navigationGeneration++;
      pruneRerouteState();
      pendingRouteArm = null;
      pendingResumeNavigationId = null;
      resetCorridorState();
      applyEffect(navSession.stop("session_end"));
      for (const id of idsToDelete) {
        void Promise.resolve(deleteNavigationSnapshot(id, userId)).catch(
          () => {},
        );
      }
      closeBridge();
    },
    close(): void {
      closeBridge();
    },
    voiceReady,
  };

  function closeBridge(): void {
    if (disposed) return;
    closedByGateway = true;
    disposed = true;
    unsubscribeAlerts();
    pendingToolMessages = 0;
    armGen++;
    navigationGeneration++;
    rerouteStateByGeneration.clear();
    resetCorridorState();
    pendingRouteArm = null;
    if (positionTimer) clearTimeout(positionTimer);
    positionTimer = null;
    if (corridorScanTimer) {
      clearTimeout(corridorScanTimer);
      corridorScanTimer = null;
    }
    pendingCriticalRerouteReason = null;
    voiceState = "unavailable";
    transitAlertCheckInFlight = false;
    transitAlertCheckDirty = false;
    clearTurnTimeout();
    navSession.dispose();
    activeNavigation = null;
    try {
      session?.close();
    } catch (err) {
      console.warn(
        "[voice] live session close failed:",
        summarizeError(err instanceof Error ? err.message : String(err)),
      );
    }
    session = null;
  }
}
