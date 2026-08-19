import { WebSocket } from "ws";
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
import { getRouteByToken } from "../accessible-route/route-token.service";
import { getMemorySettings, loadMemories } from "../ai/memory.service";
import { getTransitAlerts } from "../transit/alert.service";
import { onAlertSnapshotUpdate } from "../transit/alert.store";
import { keyRelevantToContext } from "../transit/alert.gateway";
import { NavigationSession, type NavEffect } from "./navigation-session";
import type { NavPosition } from "./navigation.schema";

const MAX_BUFFERED_BYTES = 1024 * 1024;
const ERROR_SUMMARY_MAX_CHARS = 200;
const INPUT_AUDIO_MIME_TYPE = "audio/pcm;rate=16000";
const POSITION_MIN_INTERVAL_MS = 500;
const TURN_TIMEOUT_MS = 15_000;
const TURN_TIMEOUT_STRIKES = 2;
export const LIVE_TURN_TIMEOUT_CLOSE_CODE = 4410;

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
  armRouteToken(routeToken: string): Promise<void>;
  updatePosition(position: NavPosition): void;
  cancelNav(): void;
  close(): void;
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
 * Recursively masks personally identifiable fields in a value for trace logs:
 * token/secret-like keys, user ids, contact fields, and coordinate values
 * truncated to two decimals.
 *
 * @param value The value to redact.
 * @param key The property name of the value in its parent object, if any.
 * @returns A redacted copy safe for local trace output.
 */
function redactValue(value: unknown, key?: string): unknown {
  if (key) {
    if (/token|secret|password|authorization/i.test(key)) return "[redacted]";
    if (/user_?id/i.test(key)) return "[redacted]";
    if (/phone|email|contact/i.test(key)) return "[redacted]";
    if (
      /^(lat|latitude|lng|lon|longitude)$/i.test(key) &&
      typeof value === "number"
    ) {
      return Number(value.toFixed(2));
    }
  }
  if (Array.isArray(value)) return value.map((item) => redactValue(item));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = redactValue(v, k);
    return out;
  }
  if (typeof value === "string") {
    return value.replace(/-?\d{1,3}\.\d{3,}/g, (m) => Number(m).toFixed(2));
  }
  return value;
}

/**
 * Emits a full tool trace to the local console when VOICE_POC_TRACE=true,
 * with arguments and results passed through the redactor first.
 *
 * @param tool The tool name.
 * @param args The tool call arguments.
 * @param result The raw tool result string.
 */
function traceToolCall(tool: string, args: unknown, result: string): void {
  if (process.env.VOICE_POC_TRACE !== "true") return;
  let redactedResult: unknown;
  try {
    redactedResult = redactValue(JSON.parse(result));
  } catch {
    redactedResult = redactValue(result);
  }
  console.log(
    "[voice-trace]",
    JSON.stringify({ tool, args: redactValue(args), result: redactedResult }),
  );
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
  let messageQueue = Promise.resolve();
  let pendingToolMessages = 0;
  const navSession = new NavigationSession();

  const sendJson = (payload: Record<string, unknown>): void => {
    if (!disposed && ws.readyState === WebSocket.OPEN)
      ws.send(JSON.stringify(payload));
  };

  const applyEffect = (effect: NavEffect): void => {
    for (const event of effect.events)
      sendJson(event as unknown as Record<string, unknown>);
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
    try {
      const result = await getTransitAlerts(transitCtx);
      if (disposed) return;
      if (result.ok && result.alerts.length > 0) {
        const effect = navSession.onTransitAlerts(result.alerts);
        applyEffect(effect);
        driveNavigationSpeech();
      }
    } catch (err) {
      console.warn("[voice] transit alert check failed", err);
    }
  };

  const unsubscribeAlerts = onAlertSnapshotUpdate((key: string) => {
    if (disposed || !session) return;
    void checkCurrentTransitAlerts(key);
  });

  const clearTurnTimeout = (): void => {
    if (turnTimeout) clearTimeout(turnTimeout);
    turnTimeout = null;
  };

  const closeForTurnTimeout = (): void => {
    if (disposed || ws.readyState !== WebSocket.OPEN) return;
    ws.close(LIVE_TURN_TIMEOUT_CLOSE_CODE, "live-turn-timeout");
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
        closeForTurnTimeout();
        return;
      }
      startTurnTimeout();
    }, TURN_TIMEOUT_MS);
  };

  const driveNavigationSpeech = (): void => {
    if (disposed || !session || ws.readyState !== WebSocket.OPEN) return;
    if (liveState !== "IDLE" || navSpeaking || pendingToolMessages > 0) return;
    const text = navSession.takeNextSpeech();
    if (!text) return;
    session.sendClientContent({
      turns: `請逐字唸出以下導航指引，不得增減內容：${text}`,
      turnComplete: true,
    });
    navSpeaking = true;
    liveState = "AWAIT_MODEL";
    startTurnTimeout();
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
  ): Promise<void> => {
    const functionResponses: FunctionResponse[] = [];
    for (const call of functionCalls) {
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
          if (positionTimer) {
            clearTimeout(positionTimer);
            positionTimer = null;
          }
          const effect = navSession.start(latestPosition ?? undefined);
          applyEffect(effect);
          if (effect.ok) {
            void checkCurrentTransitAlerts();
          }
          result = JSON.stringify({
            ok: effect.ok,
            message: effect.ok ? "已開始導航" : "尚未選擇路線",
          });
        } else if (name === "stopNavigation") {
          applyEffect(navSession.stop("user_voice"));
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
        traceToolCall(name, call.args ?? {}, result);
      } catch (err) {
        ok = false;
        response = {
          error: summarizeError(
            err instanceof Error ? err.message : String(err),
          ),
        };
      }
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
    if (!disposed && session) session.sendToolResponse({ functionResponses });
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
  ): Promise<void> => {
    if (disposed) return;
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
      await handleToolCalls(message.toolCall.functionCalls);
      if (!disposed) liveState = "AWAIT_MODEL";
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

  let memoryEnabled = false;
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

  session = await googleGenAi.live.connect({
    model: process.env.GEMINI_LIVE_MODEL ?? "gemini-3.1-flash-live-preview",
    config: liveConfig,
    callbacks: {
      onmessage: (message: LiveServerMessage) => {
        const hasToolCalls = Boolean(message.toolCall?.functionCalls?.length);
        if (hasToolCalls) pendingToolMessages++;
        messageQueue = messageQueue
          .then(() => handleServerMessage(message))
          .catch((err) => {
            console.error(
              "[voice] server message handling failed:",
              summarizeError(err instanceof Error ? err.message : String(err)),
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
      },
      onclose: () => {
        if (closedByGateway || ws.readyState !== WebSocket.OPEN) return;
        sendJson({ type: "error", code: "LIVE_SESSION_ENDED" });
        ws.close(1000, "live-session-ended");
      },
    },
  });

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
    async armRouteToken(routeToken: string): Promise<void> {
      const generation = ++armGen;
      const route = await getRouteByToken(routeToken);
      if (disposed || generation !== armGen) return;
      if (!route) {
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
        return;
      }
      applyEffect(navSession.armRoute(route));
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
        if (
          effect.events.some(
            (e) => e.type === "nav.transit" || e.type === "nav.start",
          )
        ) {
          void checkCurrentTransitAlerts();
        }
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
      if (positionTimer) clearTimeout(positionTimer);
      positionTimer = null;
      applyEffect(navSession.cancel());
    },
    close(): void {
      if (disposed) return;
      closedByGateway = true;
      disposed = true;
      unsubscribeAlerts();
      pendingToolMessages = 0;
      armGen++;
      if (positionTimer) clearTimeout(positionTimer);
      positionTimer = null;
      clearTurnTimeout();
      navSession.dispose();
      try {
        session?.close();
      } catch (err) {
        console.warn(
          "[voice] live session close failed:",
          summarizeError(err instanceof Error ? err.message : String(err)),
        );
      }
      session = null;
    },
  };
}
