import { DEFAULT_LANG } from "../../types/lang";
import { NAVIGATION_MESSAGES } from "./navigation-messages";
import {
  RouteConversationContext,
  createRouteAwareExecutor,
} from "../ai/route-context.service";
import type {
  RouteContextInput,
  RouteContextResult,
  RoutingPreferences,
} from "../../types/agent-route";
import { projectToolResult } from "../../utils/agent-route-projection";
import { WebSocket } from "ws";
import { randomUUID } from "crypto";
import {
  AudioTranscriptionConfig,
  FunctionCall,
  FunctionDeclaration,
  FunctionResponse,
  LiveConnectConfig,
  LiveServerMessage,
  InteractionStatus,
  Modality,
  Session,
  StartSensitivity,
} from "@google/genai";
import { googleGenAi } from "../../config/ai";
import {
  getLiveVoiceName,
  getVoiceOutputTrimConfig,
} from "../../config/voice-live";
import { buildGeminiTools } from "../agent/tool-catalog";
import { executeLocalTool } from "../ai/agent-tools";
import {
  buildVoiceSystemPrompt,
  buildNavigationSpeechPrompt,
} from "./voice-prompt";
import type { AgentLanguage } from "../../types/agent";
import { normalizeVoiceTranscript } from "./transcript-normalizer";
import {
  OUTPUT_PCM_BYTES_PER_MS,
  OutputSilenceTrimmer,
  type TurnAudioStats,
  filterModelTranscriptPiece,
} from "./live-output-filter";
import type { AccessibleRoute } from "../../types/route";
import {
  retryCandidateSwitchReconciliation,
  switchNavigationCandidate,
} from "../accessible-route/candidate-route-switch.service";
import { resolveNavigationEnvelope } from "../accessible-route/route-token.service";
import type { RerouteData } from "../accessible-route/accessible-route.types";
import { correctUserTranscript } from "./transcript-corrector";
import { withCurrentDate } from "../../config/ai/chat-prompt";
import {
  getNavigationEnvelopeByToken,
  getRouteByToken,
} from "../accessible-route/route-token.service";
import { rerouteAccessibleRoute } from "../accessible-route/reroute.service";
import {
  deleteNavigationSnapshot,
  markNavigationStopped,
  beginNavigationResume,
  commitNavigationResume,
  releaseNavigationResume,
  readNavigationTokenStrict,
  getAdoptedCandidateReplacement,
  getNavigationSnapshot,
  storeNavigationSnapshot,
} from "../accessible-route/navigation-state.repository";
import { getMemorySettings, loadMemories } from "../ai/memory.service";
import {
  summarizeToolResult,
  type PriorTurn,
} from "../agent/conversation-context";
import { getTransitAlerts } from "../transit/alert.service";
import { onAlertSnapshotUpdate } from "../transit/alert.store";
import { keyRelevantToContext } from "../transit/alert.gateway";
import { NavigationSession, type NavEffect } from "./navigation-session";
import { scanRemainingCorridor } from "./corridor-monitor";
import type { RerouteReason } from "../accessible-route/accessible-route.types";
import type { NavPosition } from "./navigation.schema";
import {
  SessionEndingMessageSchema,
  NavAdvisoryMessageSchema,
  NavResumeFailedMessageSchema,
  VoiceRerouteOutboundMessageSchema,
  type NavAdvisoryMessage,
  type NavResumeFailedMessage,
  type NavResumeMessage,
  type VoiceRerouteOutboundMessage,
} from "./voice.ws.schema";

const LIVE_MODEL = "gemini-3.8-live";
const ASSISTANT_END_PLAYBACK_PAD_MS = 750;
const ASSISTANT_END_MIN_GRACE_MS = 1_500;
const ASSISTANT_END_MAX_GRACE_MS = 8_000;
const ASSISTANT_END_MAX_WAIT_MS = 15_000;

const MAX_BUFFERED_BYTES = 1024 * 1024;
const ERROR_SUMMARY_MAX_CHARS = 200;
const INPUT_AUDIO_MIME_TYPE = "audio/pcm;rate=16000";
const POSITION_MIN_INTERVAL_MS = 500;
const REROUTE_COOLDOWN_MS = 30_000;
const CORRIDOR_SCAN_MIN_INTERVAL_MS = 20_000;
const SNAPSHOT_MIN_INTERVAL_MS = 5_000;
const TURN_TIMEOUT_MS = 15_000;
const LIVE_CONNECT_TIMEOUT_MS = 15_000;
const TURN_TIMEOUT_STRIKES = 2;

// Coordinates stop/resume races across bridge instances in this Node process;
// Redis tombstones provide the durable cross-process boundary.
const localNavigationStopRevisions = new Map<string, number>();
const navigationStopRevision = (navigationId: string): number =>
  localNavigationStopRevisions.get(navigationId) ?? 0;
const bumpNavigationStopRevision = (navigationId: string): void => {
  localNavigationStopRevisions.set(
    navigationId,
    navigationStopRevision(navigationId) + 1,
  );
  if (localNavigationStopRevisions.size > 10_000) {
    const oldest = localNavigationStopRevisions.keys().next().value;
    if (oldest) localNavigationStopRevisions.delete(oldest);
  }
};

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
    name: "proposeNavigationCandidate",
    description: "使用者要求換線時提案；只比較候選，不切換。",
    parametersJsonSchema: {
      type: "object",
      properties: {
        candidateNumber: { type: "integer" },
        candidateId: { type: "string" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "confirmNavigationCandidateSwitch",
    description:
      "依使用者的自然語意決定切換，使用有效 proposalId；明確要求換線時可在提案後直接確認，不需另一句口令。",
    parametersJsonSchema: {
      type: "object",
      properties: { proposalId: { type: "string" } },
      required: ["proposalId"],
      additionalProperties: false,
    },
  },
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
  {
    name: "endVoiceSession",
    description:
      "依自然語意判斷使用者確實希望結束語音時呼叫，不要求固定說法；資訊詢問、引用、否定、回答完問題、工具完成或沉默都不代表結束。呼叫後只說一句簡短道別，不停止導航。",
    parametersJsonSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
];

/**
 * Resolves an optional Live session sampling temperature. Unlike the text
 * agent, Live is left at the model default: at temperature 0 gemini-3.8-live
 * often streams a full transcript with silent audio. Empty, non-numeric, or
 * out-of-range GEMINI_LIVE_TEMPERATURE values also keep the default so a bad
 * env can never send NaN into the Live connect call.
 *
 * @returns A finite temperature in [0, 2], or undefined for the model default.
 */
function parseLiveTemperature(): number | undefined {
  const raw = process.env.GEMINI_LIVE_TEMPERATURE;
  if (raw == null || raw.trim() === "") return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0 || n > 2) return undefined;
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

const INPUT_TRANSCRIPTION_CUSTOM_VOCABULARY = [
  "無障礙智慧地圖",
  "無障礙",
  "捷運",
  "台鐵",
  "高鐵",
  "低地板公車",
  "復康巴士",
  "輪椅",
  "電梯",
  "坡道",
  "導盲磚",
];

/** Biases the display-only ASR transcript without changing Live model reasoning. */
function buildInputAudioTranscription(
  language: AgentLanguage,
): AudioTranscriptionConfig {
  return {
    languageCodes: language === "en" ? ["en-US", "zh-TW"] : ["zh-TW", "en-US"],
    customVocabulary: [...INPUT_TRANSCRIPTION_CUSTOM_VOCABULARY],
  };
}

export interface LiveBridgeOptions {
  language?: AgentLanguage;
  ws: WebSocket;
  userId: string;
  userLocation?: { latitude: number; longitude: number };
  /** Earlier turns of the shared conversation (text → voice switch). */
  history?: PriorTurn[];
  routeContext?: RouteContextInput;
  routingPreferences?: RoutingPreferences;
}

export interface LiveBridge {
  setRouteContext(input: RouteContextInput): Promise<RouteContextResult>;
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
  const { ws, userId, userLocation, history } = options;
  const language = options.language ?? DEFAULT_LANG;
  const messages = NAVIGATION_MESSAGES[language];
  const routeContext = new RouteConversationContext(options.routingPreferences);
  const contextReady =
    options.routeContext !== undefined
      ? routeContext.set(options.routeContext)
      : Promise.resolve();
  const executeVoiceTool = createRouteAwareExecutor(
    routeContext,
    executeLocalTool,
  );
  const conversationHistory: PriorTurn[] = [...(history ?? [])];
  let modelTranscriptBuffer = "";
  let liveTurnId = randomUUID();
  let toolGeneration = 0;
  const cancelledCalls = new Set<string>();
  const executedActionIds = new Set<string>();
  const executedActions = new WeakSet<FunctionCall>();
  const pendingBootstraps = new Set<() => void>();
  let session: Session | null = null;
  let voiceState: VoiceState = "connecting";
  let memoryEnabled = false;
  let closedByGateway = false;
  let disposed = false;
  let cumulativeTokens = 0;
  let liveState: LiveTurnState = "IDLE";
  // Live sends generationComplete once a turn's audio is fully generated, then
  // holds turnComplete until realtime playback of it (hidden tail included)
  // would end. Navigation speech goes out at generationComplete; content sent
  // in that window interrupts only the playback wait, and the old turn's
  // interrupted + turnComplete that follow must not touch the new nav turn.
  let generationFinished = false;
  let preemptedFinishedTurn = false;
  // Only the first interrupted after a preempt is ours; later ones are barge-in.
  let preemptInterruptPending = false;
  let navSpeaking = false;
  let turnTimeout: ReturnType<typeof setTimeout> | null = null;
  let turnTimeoutStrikes = 0;
  let positionTimer: ReturnType<typeof setTimeout> | null = null;
  let lastPositionProcessedAt = 0;
  let latestPosition: NavPosition | null = userLocation ?? null;
  let pendingLocation: { promise: Promise<void>; finish: () => void } | null =
    null;

  const requestClientLocation = (): Promise<void> => {
    if (latestPosition) return Promise.resolve();
    if (pendingLocation) return pendingLocation.promise;
    let finish!: () => void;
    const promise = new Promise<void>((resolve) => {
      const timer = setTimeout(() => finish(), 2_000);
      finish = () => {
        clearTimeout(timer);
        pendingLocation = null;
        resolve();
      };
    });
    pendingLocation = { promise, finish };
    // Older clients may ignore this. The bounded wait still returns a normal
    // tool failure, allowing Gemini to ask for a starting point.
    sendJson({ type: "location.request" });
    return promise;
  };
  let assistantEnding: { audioBytes: number; responded: boolean } | null = null;
  let assistantEndCloseTimer: ReturnType<typeof setTimeout> | null = null;
  let assistantEndDeadlineTimer: ReturnType<typeof setTimeout> | null = null;
  const clearAssistantEndTimers = (): void => {
    if (assistantEndCloseTimer) clearTimeout(assistantEndCloseTimer);
    if (assistantEndDeadlineTimer) clearTimeout(assistantEndDeadlineTimer);
    assistantEndCloseTimer = null;
    assistantEndDeadlineTimer = null;
  };
  const finishAssistantEnd = (): void => {
    clearAssistantEndTimers();
    if (!disposed && ws.readyState === WebSocket.OPEN)
      ws.close(1000, "assistant-end");
  };
  const scheduleAssistantEndClose = (): void => {
    if (!assistantEnding?.responded || assistantEndCloseTimer) return;
    if (assistantEndDeadlineTimer) clearTimeout(assistantEndDeadlineTimer);
    assistantEndDeadlineTimer = null;
    const playbackMs = Math.ceil(
      assistantEnding.audioBytes / OUTPUT_PCM_BYTES_PER_MS,
    );
    const graceMs = Math.min(
      ASSISTANT_END_MAX_GRACE_MS,
      Math.max(
        ASSISTANT_END_MIN_GRACE_MS,
        playbackMs + ASSISTANT_END_PLAYBACK_PAD_MS,
      ),
    );
    assistantEndCloseTimer = setTimeout(finishAssistantEnd, graceMs);
  };
  let userTranscriptBuffer = "";
  let utteranceSeq = 0;
  let currentUtteranceId: string | null = null;
  let armGen = 0;
  let inputArrivalRevision = 0;
  let planGeneration = 0;
  type Candidate = {
    ordinal: number;
    id: string;
    route: AccessibleRoute;
    token?: string;
  };
  let registry: {
    generation: number;
    candidates: Candidate[];
    used: Set<number>;
    selectedOrdinal?: number;
  } | null = null;
  let proposal: {
    id: string;
    candidate: Candidate;
    planGeneration: number;
    navigationGeneration: number;
    armGeneration: number;
    consumed: boolean;
  } | null = null;
  let pendingDirectToken: string | null = null;
  const reconcilingNavigations = new Set<string>();
  /**
   * Bumped whenever voice degrades. Messages queued under an older epoch are
   * dropped instead of replayed: a tool call the model emitted before the
   * session died must never reach navigation state after it.
   */
  let voiceEpoch = 0;
  let messageQueue = Promise.resolve();
  let pendingToolMessages = 0;
  let navSession = new NavigationSession(undefined, language);
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
  let pendingReconciledOffRoute: {
    navigationId: string;
    generation: number;
    position: NavPosition;
  } | null = null;
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
    if (assistantEnding) {
      finishAssistantEnd();
      return;
    }
    clearAssistantEndTimers();
    if (disposed || voiceState === "unavailable") return;
    voiceState = "unavailable";
    pendingLocation?.finish();
    voiceEpoch++;
    for (const cancel of pendingBootstraps) cancel();
    const ending = session;
    session = null;
    navSpeaking = false;
    turnTimeoutStrikes = 0;
    clearTurnTimeout();
    liveState = "IDLE";
    generationFinished = false;
    preemptedFinishedTurn = false;
    preemptInterruptPending = false;
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
        bumpNavigationStopRevision(id);
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
    if (disposed || assistantEnding) return;
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
        turns: buildNavigationSpeechPrompt(text, options.language),
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
    preemptedFinishedTurn = generationFinished;
    preemptInterruptPending = generationFinished;
    generationFinished = false;
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
      navigation &&
      triggerPosition &&
      reason === "OFF_ROUTE" &&
      reconcilingNavigations.has(navigation.navigationId)
    ) {
      pendingReconciledOffRoute = {
        navigationId: navigation.navigationId,
        generation: navigation.generation,
        position: triggerPosition,
      };
      return false;
    }
    if (
      disposed ||
      !navigation ||
      navigation.generation !== navigationGeneration ||
      !triggerPosition ||
      reconcilingNavigations.has(navigation.navigationId)
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
    const currentLegIndex = navSession.getCurrentLegIndex();
    const rerouteRequest = {
      ...(currentLegIndex !== undefined && currentLegIndex > 0
        ? { completedLegIndex: currentLegIndex - 1 }
        : {}),
      routeToken: navigation.routeToken,
      currentPosition: triggerPosition,
      previousRouteVersion: navigation.routeVersion,
      reason,
      clientRequestId,
      language,
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
      const replacement = new NavigationSession(undefined, language);
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
          message: messages.replacementInvalid,
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
        console.warn(
          "[voice] reroute failed",
          summarizeError(err instanceof Error ? err.message : String(err)),
        );
        sendRerouteJson({
          type: "nav.reroute_failed",
          navigationId: navigation.navigationId,
          previousRouteVersion: rerouteRequest.previousRouteVersion,
          code: "REROUTE_FAILED",
          message: messages.rerouteFailed,
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

  const outputTrimmer = new OutputSilenceTrimmer(getVoiceOutputTrimConfig());
  let turnAudioStartedAt: number | null = null;
  let turnBackpressureDrops = 0;
  // One line per answer, so "text but no sound" reports show whether the
  // model sent speech at all and how long it held the turn open.
  const logTurnAudio = (event: string, stats: TurnAudioStats): void => {
    if (turnAudioStartedAt === null) return;
    console.log(
      "[voice] turn audio",
      JSON.stringify({
        event,
        speechMs: Math.round(stats.speechMs),
        keptSilenceMs: Math.round(stats.keptSilenceMs),
        droppedMs: Math.round(stats.droppedMs),
        backpressureDrops: turnBackpressureDrops,
        sinceFirstAudioMs: Date.now() - turnAudioStartedAt,
      }),
    );
  };
  const endTurnAudio = (end: string): void => {
    logTurnAudio(end, outputTrimmer.reset());
    turnAudioStartedAt = null;
    turnBackpressureDrops = 0;
  };
  const forwardAudio = (base64Data: string): void => {
    if (ws.readyState !== WebSocket.OPEN) return;
    turnAudioStartedAt ??= Date.now();
    const decoded = Buffer.from(base64Data, "base64");
    if (!outputTrimmer.accept(decoded)) return;
    if (ws.bufferedAmount > MAX_BUFFERED_BYTES) {
      turnBackpressureDrops++;
      console.warn(
        "[voice] dropping downstream audio frame",
        JSON.stringify({ bufferedAmount: ws.bufferedAmount }),
      );
      return;
    }
    ws.send(decoded, { binary: true });
    if (assistantEnding) assistantEnding.audioBytes += decoded.length;
  };

  const prepareSession = (route: AccessibleRoute) => {
    const prepared = new NavigationSession(undefined, language);
    const armed = prepared.armRoute(route);
    const effect = prepared.start(latestPosition ?? undefined);
    const startEvent = effect.events.find((e) => e.type === "nav.start");
    if (
      !armed.ok ||
      !effect.ok ||
      !startEvent ||
      startEvent.type !== "nav.start"
    ) {
      prepared.dispose();
      return null;
    }
    return { session: prepared, effect, startEvent };
  };
  const replacementEvent = (
    data: RerouteData,
    steps: NonNullable<
      ReturnType<typeof prepareSession>
    >["startEvent"]["steps"],
  ) => ({
    type: "nav.route_replaced" as const,
    navigationId: data.navigationId,
    previousRouteVersion: data.previousRouteVersion,
    routeVersion: data.routeVersion,
    routeToken: data.routeToken,
    route: data.route,
    steps,
    warnings: data.warnings,
    currentStepIndex: 0 as const,
    reason: "MANUAL" as const,
  });

  const handleToolCalls = async (
    functionCalls: FunctionCall[],
    msgEpoch: number,
    toolGen: number,
    arrivalRevision: number,
  ): Promise<void> => {
    if (userTranscriptBuffer.trim()) finalizeUserTranscript();
    const requestCurrent = (): boolean =>
      arrivalRevision === inputArrivalRevision;
    // Re-read through a call: voice can degrade across any await below, and a
    // tool from a dead session must not reach startNavigation/stopNavigation.
    const voiceCurrent = (): boolean =>
      !disposed &&
      voiceState === "ready" &&
      msgEpoch === voiceEpoch &&
      toolGen === toolGeneration;
    // Arm before any tool side effects, regardless of the order within the batch.
    // Keep the first accepted call separate so it still instructs a farewell.
    const endCall = functionCalls.find(
      (call) =>
        call.name === "endVoiceSession" &&
        !(call.id && cancelledCalls.has(call.id)),
    );
    let acceptedEndCall: FunctionCall | undefined;
    if (
      voiceCurrent() &&
      requestCurrent() &&
      !navSpeaking &&
      !assistantEnding &&
      endCall
    ) {
      proposal = null;
      assistantEnding = { audioBytes: 0, responded: false };
      acceptedEndCall = endCall;
      sendJson(
        SessionEndingMessageSchema.parse({
          type: "session.ending",
          reason: "assistant-end",
        }),
      );
      assistantEndDeadlineTimer = setTimeout(
        finishAssistantEnd,
        ASSISTANT_END_MAX_WAIT_MS,
      );
    }
    const functionResponses: FunctionResponse[] = [];
    for (const call of functionCalls) {
      if (!voiceCurrent()) return;
      const name = call.name ?? "";
      const callId = randomUUID();
      const turnId = liveTurnId;
      const cancelled = () => Boolean(call.id && cancelledCalls.has(call.id));
      if (cancelled()) continue;
      if (navSpeaking && !assistantEnding) {
        functionResponses.push({
          id: call.id,
          name,
          response: { error: "navigation speech turn cannot execute tools" },
        });
        continue;
      }
      const startRequested =
        name === "planAccessibleRoute" && call.args?.startNavigation === true;
      const action =
        startRequested ||
        [
          "startNavigation",
          "stopNavigation",
          "proposeNavigationCandidate",
          "confirmNavigationCandidateSwitch",
        ].includes(name);
      if (
        action &&
        (call.id ? executedActionIds.has(call.id) : executedActions.has(call))
      ) {
        functionResponses.push({
          id: call.id,
          name,
          response: {
            output: JSON.stringify({
              ok: false,
              reason: "DUPLICATE_TOOL_CALL",
            }),
          },
        });
        continue;
      }
      if (action && requestCurrent() && !assistantEnding) {
        if (call.id) executedActionIds.add(call.id);
        else executedActions.add(call);
      }
      sendJson({ type: "tool_call", name, callId, turnId });
      const toolArgs = { ...(call.args ?? {}) };
      if (name === "planAccessibleRoute") delete toolArgs.startNavigation;
      const startedAt = Date.now();
      let ok = true;
      let response: Record<string, unknown>;
      let toolResult: unknown;
      let directCommit: (() => boolean) | null = null;
      try {
        let result: Awaited<ReturnType<typeof executeVoiceTool>>;
        if (assistantEnding && name !== "endVoiceSession") {
          result = JSON.stringify({
            ok: false,
            reason: "VOICE_SESSION_ENDING",
          });
        } else if (!requestCurrent()) {
          result = JSON.stringify({ ok: false, reason: "STALE_SELECTION" });
        } else if (name === "proposeNavigationCandidate") {
          proposal = null;
          const candidates = registry?.candidates ?? [];
          const ordinal = call.args?.candidateNumber;
          const id = call.args?.candidateId;
          const candidate = candidates.find(
            (c) =>
              (ordinal === undefined || c.ordinal === ordinal) &&
              (id === undefined || c.id === id) &&
              !registry?.used.has(c.ordinal) &&
              c.token !== activeNavigation?.routeToken,
          );
          if (
            !activeNavigation ||
            !registry ||
            !candidate?.token ||
            reconcilingNavigations.has(activeNavigation.navigationId)
          ) {
            result = JSON.stringify({
              ok: false,
              reason: "CANDIDATE_UNAVAILABLE",
            });
          } else {
            proposal = {
              id: randomUUID(),
              candidate,
              planGeneration: registry.generation,
              navigationGeneration,
              armGeneration: armGen,
              consumed: false,
            };
            const current = (
              registry.candidates.find(
                (c) => c.token === activeNavigation?.routeToken,
              ) ??
              registry.candidates.find(
                (c) => c.ordinal === registry?.selectedOrdinal,
              )
            )?.route;
            result = JSON.stringify({
              ok: true,
              proposalId: proposal.id,
              candidateNumber: candidate.ordinal,
              candidateId: candidate.id,
              totalMinutes: candidate.route.totalMinutes ?? null,
              transferCount: candidate.route.transferCount ?? null,
              accessibilityHighlights:
                candidate.route.accessibilityHighlights ?? null,
              difference: {
                minutes:
                  typeof current?.totalMinutes === "number" &&
                  typeof candidate.route.totalMinutes === "number"
                    ? candidate.route.totalMinutes - current.totalMinutes
                    : null,
                transfers:
                  typeof current?.transferCount === "number" &&
                  typeof candidate.route.transferCount === "number"
                    ? candidate.route.transferCount - current.transferCount
                    : null,
                accessibility: current
                  ? {
                      current: current.accessibilityHighlights ?? null,
                      candidate:
                        candidate.route.accessibilityHighlights ?? null,
                    }
                  : null,
              },
              message:
                "依使用者語意決定是否確認切換；比較或意圖不明時才澄清，缺資料不可猜測。",
            });
          }
        } else if (name === "confirmNavigationCandidateSwitch") {
          const p = proposal;
          const navigation = activeNavigation;
          if (
            !p ||
            p.consumed ||
            p.id !== call.args?.proposalId ||
            p.planGeneration !== registry?.generation ||
            p.navigationGeneration !== navigationGeneration ||
            p.armGeneration !== armGen ||
            !navigation ||
            reconcilingNavigations.has(navigation.navigationId)
          ) {
            result = JSON.stringify({
              ok: false,
              reason: "PROPOSAL_STALE_OR_UNAVAILABLE",
            });
          } else {
            p.consumed = true;
            let prepared: ReturnType<typeof prepareSession> | null = null;
            const isNavigationCurrent = () =>
              !disposed &&
              p.navigationGeneration === navigationGeneration &&
              p.armGeneration === armGen;
            const isAuthorized = () =>
              voiceCurrent() &&
              requestCurrent() &&
              !cancelled() &&
              proposal === p &&
              p.consumed &&
              p.planGeneration === registry?.generation;
            const onReconciled = (status: string): void => {
              // Retry exhaustion leaves the durable marker unresolved. Keep the
              // pending OFF_ROUTE and re-enter recovery instead of waiting for
              // NavigationSession to emit another one-shot off-route event.
              reconcilingNavigations.delete(navigation.navigationId);
              const settled = prepared as ReturnType<typeof prepareSession>;
              if (settled && navSession !== settled.session)
                settled.session.dispose();
              const pending = pendingReconciledOffRoute;
              const currentNavigation = activeNavigation;
              if (
                (status === "ROLLED_BACK" || status === "missing") &&
                pending &&
                currentNavigation &&
                pending.navigationId === currentNavigation.navigationId &&
                pending.generation === navigationGeneration &&
                currentNavigation.generation === navigationGeneration
              ) {
                pendingReconciledOffRoute = null;
                void rerouteForReason(
                  "OFF_ROUTE",
                  latestPosition ?? pending.position,
                );
                return;
              }
              if (
                status === "retry_exhausted" &&
                pending?.navigationId === navigation.navigationId &&
                !disposed
              ) {
                reconcilingNavigations.add(navigation.navigationId);
                const timer = setTimeout(
                  () =>
                    retryCandidateSwitchReconciliation(
                      navigation.navigationId,
                      onReconciled,
                    ),
                  8_000,
                );
                timer.unref?.();
                return;
              }
              if (
                !pending ||
                pending.navigationId === navigation.navigationId
              ) {
                pendingReconciledOffRoute = null;
              }
            };
            const switched = await switchNavigationCandidate({
              activeToken: navigation.routeToken,
              previousVersion: navigation.routeVersion,
              candidateToken: p.candidate.token!,
              proposalId: p.id,
              language,
              snapshot: {
                navigationId: navigation.navigationId,
                userId,
                routeToken: navigation.routeToken,
                routeVersion: navigation.routeVersion,
                currentStepIndex: 0,
                onVehicle: false,
                latestPosition: latestPosition ?? null,
                updatedAt: Date.now(),
              },
              isAuthorized,
              isNavigationCurrent,
              prepare: (data) => {
                prepared = prepareSession(data.route);
                if (!prepared) return false;
                try {
                  VoiceRerouteOutboundMessageSchema.parse(
                    replacementEvent(data, prepared.startEvent.steps),
                  );
                  return true;
                } catch {
                  prepared.session.dispose();
                  prepared = null;
                  return false;
                }
              },
              adopt: (data, envelope) => {
                // A durable ADOPTED decision is irreversible, but a newer UI stop/selection still wins locally.
                if (
                  disposed ||
                  navigationGeneration !== p.navigationGeneration ||
                  armGen !== p.armGeneration ||
                  !prepared
                )
                  return;
                navSession.dispose();
                navSession = prepared.session;
                activeNavigation = {
                  routeToken: data.routeToken,
                  navigationId: data.navigationId,
                  routeVersion: data.routeVersion,
                  generation: ++navigationGeneration,
                  requireElevator:
                    envelope.canonicalRequest.requireElevator ?? false,
                };
                registry?.used.add(p.candidate.ordinal);
                if (registry) registry.selectedOrdinal = p.candidate.ordinal;
                proposal = null;
                resetCorridorState();
                sendRerouteJson(
                  replacementEvent(data, prepared.startEvent.steps),
                );
              },
              onReconciled,
            });
            if (switched.status === "failed")
              (
                prepared as ReturnType<typeof prepareSession>
              )?.session.dispose();
            if (switched.status === "reconciling")
              reconcilingNavigations.add(navigation.navigationId);
            result = JSON.stringify({
              ok: switched.status === "adopted",
              status: switched.status,
              ...(switched.status === "adopted"
                ? {}
                : { reason: switched.reason }),
              message:
                switched.status === "reconciling"
                  ? "導航狀態確認中，尚未宣稱切換。"
                  : undefined,
            });
          }
        } else if (name === "startNavigation") {
          const { ok: started } = startNavigation();
          result = JSON.stringify({
            ok: started,
            message: started ? messages.started : messages.noRoute,
          });
        } else if (name === "endVoiceSession") {
          if (call === acceptedEndCall) {
            acceptedEndCall = undefined;
            result = JSON.stringify({
              ok: true,
              message: "請只用一句簡短道別，不要再提問或提供其他資訊。",
            });
          } else if (assistantEnding) {
            result = JSON.stringify({ ok: true, alreadyEnding: true });
          } else {
            result = JSON.stringify({
              ok: false,
              reason: "STALE_SELECTION",
              message: "結束要求已過時，請依目前狀態繼續對話。",
            });
          }
        } else if (name === "stopNavigation") {
          proposal = null;
          const idsToDelete = new Set<string>();
          if (activeNavigation?.navigationId)
            idsToDelete.add(activeNavigation.navigationId);
          if (pendingResumeNavigationId)
            idsToDelete.add(pendingResumeNavigationId);
          for (const navigationId of idsToDelete)
            bumpNavigationStopRevision(navigationId);
          // Invalidate local work first, then let the Redis stop/resume fence
          // choose a total order before publishing the local nav.stop event.
          armGen++;
          navigationGeneration++;
          pendingRouteArm = null;
          pendingReconciledOffRoute = null;
          const stopGeneration = navigationGeneration;
          const stopTarget = activeNavigation;
          const stopStatuses = await Promise.all(
            [...idsToDelete].map((navigationId) =>
              markNavigationStopped(navigationId, userId),
            ),
          );
          // Once the durable stop was submitted, later speech/cancellation
          // cannot undo it. Settle the matching local navigation, not a newer one.
          if (
            !disposed &&
            navigationGeneration === stopGeneration &&
            activeNavigation === stopTarget
          ) {
            const stopped = navSession.stop("user_voice");
            const emittedStop = stopped.events.some(
              (event) => event.type === "nav.stop",
            );
            // Stop was fenced before the await; do not invalidate newer lookups.
            for (const event of stopped.events) sendJson(event);
            if (!emittedStop && idsToDelete.size > 0) {
              sendJson({ type: "nav.stop", reason: "user_voice" });
            }
            if (
              pendingResumeNavigationId &&
              idsToDelete.has(pendingResumeNavigationId)
            )
              pendingResumeNavigationId = null;
            pruneRerouteState();
            activeNavigation = null;
            lastSnapshotPersistedAt = 0;
            resetCorridorState();
            for (const id of idsToDelete)
              void Promise.resolve(deleteNavigationSnapshot(id, userId)).catch(
                () => {},
              );
          }
          const stopPersisted = stopStatuses.every(
            (status) => status === "stopped",
          );
          result = JSON.stringify({
            ok: idsToDelete.size === 0 || stopPersisted,
            ...(idsToDelete.size > 0 && !stopPersisted
              ? { reason: "NAVIGATION_STOP_PERSISTENCE_FAILED" }
              : {}),
            message:
              idsToDelete.size > 0 && !stopPersisted
                ? language === "en"
                  ? "Navigation stopped on this connection, but the stop could not be saved. Please wait before reconnecting."
                  : "已停止目前連線的導航，但無法保存停止狀態；重新連線前請稍後再試。"
                : messages.stopped,
          });
        } else if (name === "repeatNavStep") {
          applyEffect(navSession.repeatCurrent());
          result = JSON.stringify({ ok: true, message: messages.repeat });
        } else if (name === "getActiveNavigationContext") {
          result = JSON.stringify(navSession.getConversationContext());
        } else {
          if (name === "planAccessibleRoute") {
            proposal = null;
            registry = null;
            planGeneration++;
          }
          const ownPlanGeneration = planGeneration;
          const ownNavigationGeneration = navigationGeneration;
          const ownArmGeneration = armGen;
          if (
            name === "planAccessibleRoute" &&
            call.args?.origin === "current_location" &&
            !latestPosition
          ) {
            await requestClientLocation();
            if (!voiceCurrent()) return;
            if (cancelled()) continue;
          }
          if (name === "planAccessibleRoute" && !requestCurrent()) {
            result = JSON.stringify({
              ok: false,
              reason: "STALE_SELECTION",
            });
          } else
            result = await executeVoiceTool(
              name,
              toolArgs,
              latestPosition ?? userLocation,
              userId,
              {
                language,
                allowMemoryWrite: memoryEnabled,
                isCurrent: () =>
                  voiceCurrent() && requestCurrent() && !cancelled(),
              },
            );
          if (
            name === "planAccessibleRoute" &&
            voiceCurrent() &&
            requestCurrent() &&
            !cancelled() &&
            ownPlanGeneration === planGeneration &&
            ownNavigationGeneration === navigationGeneration &&
            ownArmGeneration === armGen
          ) {
            const raw =
              typeof result === "string"
                ? JSON.parse(result)
                : result.clientResult;
            const routes = (raw as { routes?: AccessibleRoute[] })?.routes;
            if ((raw as { ok?: boolean })?.ok && Array.isArray(routes)) {
              registry = {
                generation: ownPlanGeneration,
                candidates: routes.map((route, index) => ({
                  ordinal: index + 1,
                  id: route.routeId,
                  route,
                  token: route.routeToken,
                })),
                used: new Set(),
              };
              if (startRequested && requestCurrent()) {
                const first = registry.candidates[0];
                const current = () =>
                  voiceCurrent() &&
                  requestCurrent() &&
                  !cancelled() &&
                  ownPlanGeneration === planGeneration &&
                  ownNavigationGeneration === navigationGeneration &&
                  ownArmGeneration === armGen;
                if (first?.token && current()) {
                  pendingDirectToken = first.token;
                  const stored = await readNavigationTokenStrict(first.token);
                  const canonical =
                    stored.status === "ok"
                      ? await resolveNavigationEnvelope(stored.value)
                      : null;
                  if (
                    current() &&
                    canonical &&
                    canonical.route.routeId === first.route.routeId &&
                    canonical.navigationId === first.route.navigationId &&
                    canonical.routeVersion === first.route.routeVersion &&
                    canonical.route.navigationId === canonical.navigationId &&
                    canonical.route.routeVersion === canonical.routeVersion
                  ) {
                    const envelope = canonical;
                    const prepared = prepareSession(envelope.route);
                    if (prepared)
                      directCommit = () => {
                        if (!current()) {
                          prepared.session.dispose();
                          pendingDirectToken = null;
                          return false;
                        }
                        const old = activeNavigation;
                        navSession.dispose();
                        navSession = prepared.session;
                        activeNavigation = {
                          routeToken: first.token!,
                          navigationId: envelope.navigationId,
                          routeVersion: envelope.routeVersion,
                          generation: ++navigationGeneration,
                          requireElevator:
                            envelope.canonicalRequest.requireElevator ?? false,
                        };
                        registry?.used.add(first.ordinal);
                        if (registry) registry.selectedOrdinal = first.ordinal;
                        pendingDirectToken = null;
                        resetCorridorState();
                        applyEffect(prepared.effect);
                        persistNavigationSnapshot(true);
                        if (old && old.navigationId !== envelope.navigationId)
                          void Promise.resolve(
                            deleteNavigationSnapshot(old.navigationId, userId),
                          ).catch(() => {});
                        return true;
                      };
                  }
                  if (!directCommit) pendingDirectToken = null;
                }
              }
            }
          }
        }
        let modelResult: unknown;
        if (typeof result === "string") {
          try {
            toolResult = JSON.parse(result);
          } catch {
            toolResult = { result };
          }
          modelResult = projectToolResult(toolResult).modelResult;
        } else {
          toolResult = result.clientResult;
          modelResult = result.modelResult;
        }
        response = { output: JSON.stringify(modelResult) };
      } catch (err) {
        ok = false;
        response = {
          error: summarizeError(
            err instanceof Error ? err.message : String(err),
          ),
        };
      }
      if (!voiceCurrent()) return;
      if (cancelled()) continue;
      const durationMs = Date.now() - startedAt;
      console.log(
        "[voice] tool",
        JSON.stringify({
          tool: name,
          ok,
          durationMs,
          ...(name === "planAccessibleRoute"
            ? {
                hasLocation: Boolean(latestPosition),
                resultOk:
                  typeof toolResult === "object" &&
                  toolResult !== null &&
                  "ok" in toolResult
                    ? toolResult.ok === true
                    : false,
                failureCode: !ok
                  ? "TOOL_EXECUTION_FAILED"
                  : typeof toolResult === "object" &&
                      toolResult !== null &&
                      "ok" in toolResult &&
                      toolResult.ok === false
                    ? "reason" in toolResult &&
                      typeof toolResult.reason === "string" &&
                      [
                        "LOCATION_REQUIRED",
                        "INVALID_ROUTE_ARGUMENTS",
                        "STALE_SELECTION",
                        "ROUTE_CONTEXT_UNAVAILABLE",
                      ].includes(toolResult.reason)
                      ? toolResult.reason
                      : "ROUTE_PLANNING_FAILED"
                    : undefined,
              }
            : {}),
          ...(ok || name === "planAccessibleRoute"
            ? {}
            : { error: response.error }),
        }),
      );
      sendJson({
        type: "tool_result",
        name,
        callId,
        turnId,
        ok,
        durationMs,
        result: toolResult,
        args: call.args ?? {},
        summary: ok ? summarizeToolResult(toolResult) : "",
      });
      if (startRequested) {
        const navigationStarted = directCommit?.() ?? false;
        let output: Record<string, unknown> = {};
        try {
          output = JSON.parse(String(response.output ?? "{}"));
        } catch {
          /* retain explicit failure below */
        }
        response = {
          output: JSON.stringify({
            ...output,
            navigationStarted,
            ...(navigationStarted
              ? {}
              : {
                  navigationStartReason: "ROUTE_NOT_READY_OR_REQUEST_STALE",
                }),
          }),
        };
      }
      functionResponses.push({ id: call.id, name, response });
    }
    if (voiceCurrent() && session) {
      session.sendToolResponse({ functionResponses });
      if (assistantEnding) assistantEnding.responded = true;
    }
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
    conversationHistory.push({ role: "user", text: raw });
    if (conversationHistory.length > 20) conversationHistory.shift();
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

  const commitModelTranscript = (): void => {
    if (modelTranscriptBuffer.trim()) {
      conversationHistory.push({
        role: "assistant",
        text: modelTranscriptBuffer,
      });
      if (conversationHistory.length > 20) conversationHistory.shift();
    }
    modelTranscriptBuffer = "";
  };

  const handleServerMessage = async (
    message: LiveServerMessage,
    msgEpoch: number,
    msgToolGeneration: number,
    arrivalRevision: number,
  ): Promise<void> => {
    // The queue can hold this message across a degradation; replaying it would
    // drive navigation from a session that no longer exists.
    if (
      disposed ||
      voiceState !== "ready" ||
      msgEpoch !== voiceEpoch ||
      msgToolGeneration !== toolGeneration
    )
      return;
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
        if (content.inputTranscription.text?.trim()) {
          if (navSpeaking && !content.interrupted) {
            endTurnAudio("interrupted");
            generationFinished = false;
            modelTranscriptBuffer = "";
            navSession.onInterrupted();
            navSpeaking = false;
            clearTurnTimeout();
            sendJson({ type: "interrupted" });
          }
          liveState = "USER_INPUT";
          const piece = normalizeVoiceTranscript(
            content.inputTranscription.text,
          );
          if (!currentUtteranceId) {
            currentUtteranceId = `u${++utteranceSeq}`;
            liveTurnId = randomUUID();
          }
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
      const modelPiece = content.outputTranscription?.text
        ? filterModelTranscriptPiece(
            modelTranscriptBuffer,
            content.outputTranscription.text,
          )
        : null;
      if (modelPiece) {
        modelTranscriptBuffer += modelPiece;
        sendJson({
          type: "transcript",
          role: "model",
          text: normalizeVoiceTranscript(modelPiece),
        });
      }
      if (content.interrupted && preemptInterruptPending) {
        preemptInterruptPending = false;
        // Our own navigation content ended a turn whose audio was already
        // complete: keep its answer and leave the new nav turn untouched.
        commitModelTranscript();
        endTurnAudio("preempted");
        if (content.turnComplete) preemptedFinishedTurn = false;
      } else if (content.interrupted) {
        generationFinished = false;
        modelTranscriptBuffer = "";
        endTurnAudio("interrupted");
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
      endTurnAudio("tool-call");
      liveState = "TOOL_PENDING";
      await handleToolCalls(
        message.toolCall.functionCalls,
        msgEpoch,
        msgToolGeneration,
        arrivalRevision,
      );
      if (!disposed && voiceState === "ready" && msgEpoch === voiceEpoch)
        liveState = "AWAIT_MODEL";
    } else if (
      content?.turnComplete &&
      !content.interrupted &&
      preemptedFinishedTurn
    ) {
      preemptedFinishedTurn = false;
      preemptInterruptPending = false;
      commitModelTranscript();
      endTurnAudio("preempted-turn-complete");
      sendJson({ type: "turn.complete" });
    } else if (
      content?.generationComplete &&
      !content.turnComplete &&
      !content.interrupted
    ) {
      generationFinished = true;
      logTurnAudio("generation-complete", outputTrimmer.peek());
      if (navSpeaking) navSession.onTurnComplete();
      navSpeaking = false;
      turnTimeoutStrikes = 0;
      clearTurnTimeout();
      liveState = "IDLE";
      driveNavigationSpeech();
    } else if (content?.turnComplete && !content.interrupted) {
      generationFinished = false;
      commitModelTranscript();
      endTurnAudio("turn-complete");
      if (userTranscriptBuffer.trim()) finalizeUserTranscript();
      if (navSpeaking) navSession.onTurnComplete();
      navSpeaking = false;
      turnTimeoutStrikes = 0;
      clearTurnTimeout();
      liveState = "IDLE";
      sendJson({ type: "turn.complete" });
      // IDLE is explicit; IN_PROGRESS marks a filler turn. gemini-3.8-live
      // sends no status and completes the tool turn before speaking, so
      // without one only a turn that carried the farewell audio counts.
      if (
        content.interactionStatus === InteractionStatus.IDLE ||
        (content.interactionStatus === undefined &&
          (assistantEnding?.audioBytes ?? 0) > 0)
      )
        scheduleAssistantEndClose();
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
  const bootstrapVoice = async (expectedEpoch = voiceEpoch): Promise<void> => {
    let bootstrapTimeout: ReturnType<typeof setTimeout> | undefined;
    let cancel!: () => void;
    const cancelled = new Promise<void>((resolve) => {
      cancel = resolve;
    });
    pendingBootstraps.add(cancel);
    try {
      await Promise.race([
        cancelled,
        (async () => {
          if (expectedEpoch === 0) await contextReady;
          if (disposed || expectedEpoch !== voiceEpoch) return;
          let sessionMemoryEnabled = false;
          let memories: Array<{
            _id?: unknown;
            category: string;
            promptText?: string;
            content: string;
          }> = [];
          if (userId) {
            try {
              const settings = await getMemorySettings(userId);
              sessionMemoryEnabled = settings.memoryEnabled;
              if (disposed || expectedEpoch !== voiceEpoch) return;
              if (sessionMemoryEnabled) {
                memories = await loadMemories(userId, 20);
              }
            } catch (err) {
              console.error(
                "[voice] loadMemories failed:",
                summarizeError(
                  err instanceof Error ? err.message : String(err),
                ),
              );
            }
          }
          if (disposed || voiceUnavailable() || expectedEpoch !== voiceEpoch)
            return;

          memoryEnabled = sessionMemoryEnabled;
          const liveConfig: LiveConnectConfig = {
            responseModalities: [Modality.AUDIO],
            inputAudioTranscription: buildInputAudioTranscription(language),
            outputAudioTranscription: {},
            // Default sensitivity takes the assistant's own speaker echo for
            // barge-in and cuts answers after the first sentence; LOW still
            // stops for a user who actually talks over it.
            realtimeInputConfig: {
              automaticActivityDetection: {
                startOfSpeechSensitivity:
                  StartSensitivity.START_SENSITIVITY_LOW,
              },
            },
            systemInstruction: withCurrentDate(
              buildVoiceSystemPrompt(latestPosition ?? undefined, memories, {
                language: options.language,
                memoryEnabled,
                history: conversationHistory,
              }) + routeContext.prompt,
            ),
            tools: [
              ...buildGeminiTools(userId, memoryEnabled).map((tool) => ({
                ...tool,
                functionDeclarations: tool.functionDeclarations?.map(
                  (declaration) => {
                    if (declaration.name !== "planAccessibleRoute")
                      return declaration;
                    const schema = declaration.parametersJsonSchema as Record<
                      string,
                      unknown
                    >;
                    return {
                      ...declaration,
                      parametersJsonSchema: {
                        ...schema,
                        properties: {
                          ...(schema.properties as Record<string, unknown>),
                          startNavigation: {
                            type: "boolean",
                            description:
                              "使用者確實要求實際帶路時設 true；僅詢問或比較路線時省略或 false，不需固定口令或重複確認。",
                            default: false,
                          },
                        },
                      },
                    };
                  },
                ),
              })),
              { functionDeclarations: NAV_FUNCTIONS },
            ],
          };
          // Native audio follows system instructions, not speechConfig.languageCode.
          // Retain the legacy env setting only when no frontend preference is given.
          const languageCode = options.language
            ? undefined
            : parseLiveLanguageCode();
          const temperature = parseLiveTemperature();
          if (temperature !== undefined) liveConfig.temperature = temperature;
          const voiceName = getLiveVoiceName();
          if (languageCode || voiceName)
            liveConfig.speechConfig = {
              ...(languageCode && { languageCode }),
              ...(voiceName && {
                voiceConfig: { prebuiltVoiceConfig: { voiceName } },
              }),
            };

          const connected = await googleGenAi.live.connect({
            model: LIVE_MODEL,
            config: liveConfig,
            callbacks: {
              onmessage: (message: LiveServerMessage) => {
                if (disposed || expectedEpoch !== voiceEpoch) return;
                if (message.serverContent?.interrupted) toolGeneration++;
                for (const id of message.toolCallCancellation?.ids ?? [])
                  cancelledCalls.add(id);
                const hasToolCalls = Boolean(
                  message.toolCall?.functionCalls?.length,
                );
                if (hasToolCalls) pendingToolMessages++;
                const msgEpoch = expectedEpoch;
                const msgToolGeneration = toolGeneration;
                const hasInputText = Boolean(
                  message.serverContent?.inputTranscription?.text?.trim(),
                );
                const arrivalRevision = hasInputText
                  ? ++inputArrivalRevision
                  : inputArrivalRevision;
                messageQueue = messageQueue
                  .then(() =>
                    handleServerMessage(
                      message,
                      msgEpoch,
                      msgToolGeneration,
                      arrivalRevision,
                    ),
                  )
                  .catch((err) => {
                    console.error(
                      "[voice] server message handling failed:",
                      summarizeError(
                        err instanceof Error ? err.message : String(err),
                      ),
                    );
                  })
                  .finally(() => {
                    if (hasToolCalls && expectedEpoch === voiceEpoch)
                      pendingToolMessages = Math.max(
                        0,
                        pendingToolMessages - 1,
                      );
                  });
              },
              onerror: (e) => {
                if (expectedEpoch !== voiceEpoch || disposed) return;
                console.error(
                  "[voice] live session error:",
                  summarizeError(e?.message),
                );
                // Errors on the Live socket are terminal for playback but harmless
                // to navigation. Degrade rather than let a later send throw.
                if (!closedByGateway)
                  markVoiceUnavailable("LIVE_SESSION_ENDED");
              },
              onclose: (e) => {
                if (expectedEpoch !== voiceEpoch || disposed) return;
                // Gemini hanging up must never hang up on the client: navigation
                // and alerts keep running on this same socket.
                if (closedByGateway) return;
                console.warn(
                  "[voice] live session closed by upstream",
                  JSON.stringify({
                    code: e?.code,
                    reason: summarizeError(e?.reason),
                  }),
                );
                markVoiceUnavailable("LIVE_SESSION_ENDED");
              },
            },
          });

          // A timed-out or superseded handshake can still complete. Close its
          // session before it can write anything into the current voice state.
          if (disposed || voiceUnavailable() || expectedEpoch !== voiceEpoch) {
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
        })(),
        new Promise<never>((_, reject) => {
          bootstrapTimeout = setTimeout(
            () => reject(new Error("Live bootstrap timed out")),
            LIVE_CONNECT_TIMEOUT_MS,
          );
        }),
      ]);
    } catch (err) {
      if (expectedEpoch !== voiceEpoch || disposed) return;
      console.error(
        "[voice] live connect failed:",
        summarizeError(err instanceof Error ? err.message : String(err)),
      );
      markVoiceUnavailable("LIVE_CONNECT_FAILED");
    } finally {
      clearTimeout(bootstrapTimeout);
      pendingBootstraps.delete(cancel);
    }
  };

  const voiceReady = bootstrapVoice();

  return {
    async setRouteContext(
      input: RouteContextInput,
    ): Promise<RouteContextResult> {
      if (assistantEnding) {
        return { ok: false, reason: "ROUTE_CONTEXT_UNAVAILABLE" };
      }
      if (disposed || voiceUnavailable())
        return { ok: false, reason: "ROUTE_CONTEXT_UNAVAILABLE" };
      // The UI echoes the default selection after receiving a plan. Do not cut
      // off that plan's explanation when it already refers to the same route.
      if (
        voiceState === "ready" &&
        input?.routeToken &&
        input.routeToken === routeContext.token
      )
        return routeContext.identity;
      const epoch = ++voiceEpoch;
      for (const cancel of pendingBootstraps) cancel();
      const ending = session;
      session = null;
      voiceState = "connecting";
      messageQueue = Promise.resolve();
      pendingToolMessages = 0;
      toolGeneration++;
      cancelledCalls.clear();
      executedActionIds.clear();
      modelTranscriptBuffer = "";
      userTranscriptBuffer = "";
      currentUtteranceId = null;
      liveTurnId = randomUUID();
      navSession.onInterrupted();
      navSpeaking = false;
      liveState = "IDLE";
      generationFinished = false;
      preemptedFinishedTurn = false;
      preemptInterruptPending = false;
      turnTimeoutStrikes = 0;
      clearTurnTimeout();
      sendJson({ type: "interrupted" });
      try {
        ending?.close();
      } catch {
        /* obsolete connection */
      }
      const selected = await routeContext.set(input);
      if (disposed || epoch !== voiceEpoch)
        return { ok: false, reason: "STALE_SELECTION" };
      await bootstrapVoice(epoch);
      if (disposed) return { ok: false, reason: "STALE_SELECTION" };
      if (voiceUnavailable())
        return { ok: false, reason: "ROUTE_CONTEXT_UNAVAILABLE" };
      if (epoch !== voiceEpoch) return { ok: false, reason: "STALE_SELECTION" };
      return selected;
    },
    sendAudio(data: Buffer): void {
      if (disposed || !session || assistantEnding) return;
      session?.sendRealtimeInput({
        audio: {
          data: data.toString("base64"),
          mimeType: INPUT_AUDIO_MIME_TYPE,
        },
      });
    },
    async armRouteToken(routeToken: string): Promise<boolean> {
      if (
        !disposed &&
        (routeToken === activeNavigation?.routeToken ||
          routeToken === pendingDirectToken)
      ) {
        const selected = registry?.candidates.find(
          (candidate) => candidate.token === routeToken,
        );
        if (selected && registry) {
          registry.selectedOrdinal = selected.ordinal;
          registry.used.add(selected.ordinal);
        }
        return true;
      }
      proposal = null;
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
          navSession = new NavigationSession(undefined, language);
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
                message: messages.routeExpired,
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
        const selected = registry?.candidates.find(
          (candidate) => candidate.token === routeToken,
        );
        if (selected && registry) {
          registry.selectedOrdinal = selected.ordinal;
          registry.used.add(selected.ordinal);
        }
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
      proposal = null;
      const arm = { armGeneration: ++armGen };
      pendingRouteArm = arm;
      pendingResumeNavigationId = message.navigationId;
      const stopRevisionAtStart = navigationStopRevision(message.navigationId);
      const isCurrentArm = (): boolean =>
        !disposed && arm.armGeneration === armGen && pendingRouteArm === arm;
      let resumeAttemptId: string | null = null;
      let resumeFenceAcquired = false;
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
          fail("SNAPSHOT_NOT_FOUND", messages.snapshotExpired);
          return;
        }
        if (snapshot.userId !== userId) {
          fail("USER_MISMATCH", messages.userMismatch);
          return;
        }
        let adoptedReplacement: RerouteData | null = null;
        if (
          snapshot.routeVersion !== message.routeVersion ||
          snapshot.routeToken !== message.routeToken
        ) {
          if (
            snapshot.navigationId === message.navigationId &&
            snapshot.routeVersion === message.routeVersion + 1
          ) {
            adoptedReplacement = await getAdoptedCandidateReplacement(
              snapshot,
              message.routeToken,
              message.routeVersion,
            );
            if (!isCurrentArm()) return;
          }
          if (!adoptedReplacement) {
            fail("ROUTE_VERSION_MISMATCH", messages.versionMismatch);
            return;
          }
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
          fail("ROUTE_EXPIRED", messages.routeExpired);
          return;
        }
        // Validate the replacement against canonical token data before changing local state.
        let resumeReplacement: ReturnType<typeof replacementEvent> | null =
          null;
        if (adoptedReplacement) {
          const prepared = prepareSession(route);
          if (!prepared) {
            fail("ROUTE_EXPIRED", messages.routeExpired);
            return;
          }
          try {
            resumeReplacement = replacementEvent(
              { ...adoptedReplacement, route },
              prepared.startEvent.steps,
            );
            VoiceRerouteOutboundMessageSchema.parse(resumeReplacement);
          } finally {
            prepared.session.dispose();
          }
        }
        resumeAttemptId = randomUUID();
        const resumeFence = await beginNavigationResume(
          snapshot,
          resumeAttemptId,
        );
        if (!isCurrentArm()) {
          if (resumeFence === "acquired")
            void releaseNavigationResume(
              snapshot.navigationId,
              resumeAttemptId,
            );
          return;
        }
        if (resumeFence === "user_mismatch") {
          fail("USER_MISMATCH", messages.userMismatch);
          return;
        }
        if (
          resumeFence === "stopped" ||
          resumeFence === "missing" ||
          resumeFence === "stale"
        ) {
          fail("SNAPSHOT_NOT_FOUND", messages.snapshotExpired);
          return;
        }
        if (resumeFence !== "acquired")
          throw new Error(`navigation resume fence ${resumeFence}`);
        resumeFenceAcquired = true;
        const resumeCommit = await commitNavigationResume(
          snapshot,
          resumeAttemptId,
        );
        if (
          resumeCommit !== "committed" ||
          navigationStopRevision(snapshot.navigationId) !== stopRevisionAtStart
        ) {
          void releaseNavigationResume(snapshot.navigationId, resumeAttemptId);
          resumeFenceAcquired = false;
          if (resumeCommit === "user_mismatch")
            fail("USER_MISMATCH", messages.userMismatch);
          else if (
            resumeCommit === "stopped" ||
            navigationStopRevision(snapshot.navigationId) !==
              stopRevisionAtStart
          )
            fail("SNAPSHOT_NOT_FOUND", messages.snapshotExpired);
          else throw new Error(`navigation resume commit ${resumeCommit}`);
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
          void releaseNavigationResume(snapshot.navigationId, resumeAttemptId);
          resumeFenceAcquired = false;
          fail("ROUTE_EXPIRED", messages.routeExpired);
          return;
        }
        if (resumePosition) latestPosition = resumePosition;
        reconcilingNavigations.delete(snapshot.navigationId);
        activeNavigation = {
          routeToken: snapshot.routeToken,
          navigationId: snapshot.navigationId,
          routeVersion: snapshot.routeVersion,
          generation: committedGeneration,
          requireElevator: envelope.canonicalRequest?.requireElevator ?? false,
        };
        resetCorridorState();
        if (resumeReplacement) sendRerouteJson(resumeReplacement);
        applyEffect(effect);
        void releaseNavigationResume(snapshot.navigationId, resumeAttemptId);
        resumeFenceAcquired = false;
        persistNavigationSnapshot(true);
        void checkCurrentTransitAlerts();
        driveNavigationSpeech();
      } catch (err) {
        if (resumeFenceAcquired && resumeAttemptId)
          void releaseNavigationResume(message.navigationId, resumeAttemptId);
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
          message: messages.resumeFailed,
          retryable: true,
        });
      }
    },
    updatePosition(position: NavPosition): void {
      if (disposed) return;
      latestPosition = position;
      pendingLocation?.finish();
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
      proposal = null;
      const idsToDelete = new Set<string>();
      if (activeNavigation?.navigationId)
        idsToDelete.add(activeNavigation.navigationId);
      if (pendingResumeNavigationId) idsToDelete.add(pendingResumeNavigationId);
      for (const navigationId of idsToDelete)
        bumpNavigationStopRevision(navigationId);
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
      proposal = null;
      registry = null;
      const idsToDelete = new Set<string>();
      if (activeNavigation?.navigationId)
        idsToDelete.add(activeNavigation.navigationId);
      if (pendingResumeNavigationId) idsToDelete.add(pendingResumeNavigationId);
      for (const navigationId of idsToDelete)
        bumpNavigationStopRevision(navigationId);
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
    clearAssistantEndTimers();
    if (disposed) return;
    closedByGateway = true;
    disposed = true;
    proposal = null;
    registry = null;
    pendingLocation?.finish();
    for (const cancel of pendingBootstraps) cancel();
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
