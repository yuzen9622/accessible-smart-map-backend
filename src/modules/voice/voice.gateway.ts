import type http from "http";
import { WebSocketServer, WebSocket, type RawData } from "ws";
import { registerWsRoute } from "../../config/ws-upgrade";
import { authenticateToken } from "../../config/auth";
import { createLiveBridge, type LiveBridge } from "./live-bridge";
import { type NavPosition } from "./navigation.schema";
import {
  NavCancelMessageSchema,
  NavPositionMessageSchema,
  NavResumeMessageSchema,
  NavSetRouteMessageSchema,
  SessionEndMessageSchema,
  SessionStartMessageSchema,
  UserLocationSchema,
  describeIssues,
  type NavResumeMessage,
} from "./voice.ws.schema";
import { deleteNavigationSnapshot } from "../accessible-route/navigation-state.repository";

const VOICE_WS_PATH = "/api/v1/voice/ws";
const DEFAULT_AUTH_TIMEOUT_MS = 5000;
const HEARTBEAT_INTERVAL_MS = 30000;
const MAX_MISSED_PONGS = 2;
export const CONTROL_FRAME_MAX_BYTES = 8 * 1024;
const SESSION_END_BYPASS_MAX_BYTES = 1024;
const CONTROL_FRAMES_PER_SEC = 40;
const CONTROL_FRAMES_BURST = 80;
// Frames accepted while the session.start token is still being authenticated.
// The per-connection rate buckets only apply after authentication, so this caps
// what an unauthenticated peer can make the server hold in memory.
const AUTH_QUEUE_MAX_FRAMES = 32;
const CONTROL_BYTES_PER_SEC = 320 * 1024;
const CONTROL_BYTES_BURST = 640 * 1024;
const CONTROL_MSGS_PER_SEC = 20;
const CONTROL_MSGS_BURST = 40;
const POSITION_MSGS_PER_SEC = 15;
const POSITION_MSGS_BURST = 30;
const CONTROL_RATE_CLOSE_CODE = 4408;
const VOICE_MAX_PAYLOAD_BYTES = 64 * 1024;

interface VoiceConnection {
  ws: WebSocket;
  bridge: LiveBridge | null;
}

export interface AttachVoiceWebSocketOptions {
  authTimeoutMs?: number;
}

const connections = new Map<string, VoiceConnection>();

class TokenBucket {
  private tokens: number;
  private updatedAt = Date.now();

  constructor(
    private readonly refillPerSec: number,
    private readonly capacity: number,
  ) {
    this.tokens = capacity;
  }

  take(cost = 1): boolean {
    const now = Date.now();
    this.tokens = Math.min(
      this.capacity,
      this.tokens + ((now - this.updatedAt) / 1000) * this.refillPerSec,
    );
    this.updatedAt = now;
    if (this.tokens < cost) return false;
    this.tokens -= cost;
    return true;
  }
}

/**
 * Converts a ws RawData payload into a Buffer.
 *
 * @param data The raw message data from ws.
 * @returns The message as a single Buffer.
 */
function rawDataToBuffer(data: RawData): Buffer {
  if (Buffer.isBuffer(data)) return data;
  if (Array.isArray(data)) return Buffer.concat(data);
  return Buffer.from(data);
}

/**
 * Parses the optional userLocation field of a session.start message.
 *
 * @param value The raw userLocation value from the client.
 * @returns A validated latitude/longitude pair, or undefined.
 */
/**
 * Reads the optional starting position off a `session.start` frame.
 *
 * An unusable location is dropped rather than rejected: the handshake still
 * succeeds, the session just starts without a position.
 *
 * @param value The raw `userLocation` field
 * @returns The validated coordinates, or undefined
 */
function parseUserLocation(
  value: unknown,
): { latitude: number; longitude: number } | undefined {
  const result = UserLocationSchema.safeParse(value);
  return result.success ? result.data : undefined;
}

/**
 * Handles the lifecycle of one WebSocket connection: first-message
 * authentication with a bounded deadline, single-session-per-user
 * enforcement, heartbeat, audio forwarding to the Live bridge, and cleanup.
 *
 * @param ws The accepted WebSocket connection.
 * @param authTimeoutMs Milliseconds the client has to send session.start.
 */
function handleConnection(ws: WebSocket, authTimeoutMs: number): void {
  let authenticated = false;
  let authInFlight: Promise<void> | null = null;
  let authQueue: { data: RawData; isBinary: boolean }[] = [];
  let userId: string | null = null;
  let bridge: LiveBridge | null = null;
  let missedPongs = 0;
  let disposed = false;
  let connGen = 0;
  let pendingRouteToken: string | null = null;
  let pendingPosition: NavPosition | null = null;
  let pendingResume: NavResumeMessage | null = null;
  const frameBucket = new TokenBucket(
    CONTROL_FRAMES_PER_SEC,
    CONTROL_FRAMES_BURST,
  );
  const byteBucket = new TokenBucket(
    CONTROL_BYTES_PER_SEC,
    CONTROL_BYTES_BURST,
  );
  const controlBucket = new TokenBucket(
    CONTROL_MSGS_PER_SEC,
    CONTROL_MSGS_BURST,
  );
  const positionBucket = new TokenBucket(
    POSITION_MSGS_PER_SEC,
    POSITION_MSGS_BURST,
  );

  const sendJson = (payload: Record<string, unknown>): void => {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(payload));
  };

  const authTimer = setTimeout(() => {
    if (!authenticated) ws.close(4401, "unauthorized");
  }, authTimeoutMs);

  const heartbeatTimer = setInterval(() => {
    if (missedPongs >= MAX_MISSED_PONGS) {
      ws.terminate();
      return;
    }
    missedPongs++;
    ws.ping();
  }, HEARTBEAT_INTERVAL_MS);

  const handleAuthMessage = async (
    data: RawData,
    isBinary: boolean,
  ): Promise<void> => {
    if (isBinary) {
      ws.close(4401, "unauthorized");
      return;
    }
    const buffer = rawDataToBuffer(data);
    if (buffer.byteLength > CONTROL_FRAME_MAX_BYTES) {
      ws.close(4401, "unauthorized");
      return;
    }
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(buffer.toString("utf8"));
    } catch {
      ws.close(4401, "unauthorized");
      return;
    }
    const handshake = SessionStartMessageSchema.safeParse(parsed);
    if (!handshake.success) {
      console.warn(
        `[voice] rejecting handshake: ${describeIssues(handshake.error)}`,
      );
      ws.close(4401, "unauthorized");
      return;
    }
    const result = await authenticateToken(handshake.data.token);
    if (!result.ok) {
      authQueue = [];
      ws.close(4401, "unauthorized");
      return;
    }
    const id = result.userId;
    authenticated = true;
    const generation = ++connGen;
    clearTimeout(authTimer);
    userId = id;
    const userLocation = parseUserLocation(handshake.data.userLocation);
    const existing = connections.get(id);
    if (existing) existing.ws.close(4409, "superseded");
    const connection: VoiceConnection = { ws, bridge: null };
    connections.set(id, connection);

    // Replay the frames that arrived mid-authentication before the bridge is
    // started, so they are buffered into pendingRouteToken/pendingPosition the
    // same way they would be on a synchronous handshake. Starting the bridge
    // first would let them reach a live bridge one by one instead.
    const queued = authQueue;
    authQueue = [];
    for (const frame of queued) {
      if (ws.readyState !== WebSocket.OPEN) break;
      if (frame.isBinary) bridge?.sendAudio(rawDataToBuffer(frame.data));
      else handleControlMessage(frame.data);
    }

    // Deliberately not awaited: the session is authenticated from here on, so
    // control frames that arrive while the Live bridge is still connecting must
    // reach handleControlMessage and be buffered rather than queue behind it.
    void startBridge(id, generation, connection, userLocation);
  };

  const startBridge = async (
    id: string,
    generation: number,
    connection: VoiceConnection,
    userLocation: ReturnType<typeof parseUserLocation>,
  ): Promise<void> => {
    try {
      const createdBridge = await createLiveBridge({
        ws,
        userId: id,
        userLocation,
      });
      if (
        disposed ||
        generation !== connGen ||
        ws.readyState !== WebSocket.OPEN ||
        connections.get(id) !== connection
      ) {
        createdBridge.close();
        return;
      }
      bridge = createdBridge;
      connection.bridge = createdBridge;
    } catch (err) {
      console.error(
        "[voice] live connect failed:",
        err instanceof Error ? err.message : String(err),
      );
      sendJson({ type: "error", code: "LIVE_CONNECT_FAILED" });
      ws.close(1011, "live-connect-failed");
      return;
    }
    sendJson({ type: "session.ready" });
    if (pendingRouteToken) void bridge.armRouteToken(pendingRouteToken);
    if (pendingResume) void bridge.resumeNavigation(pendingResume);
    if (pendingPosition) bridge.updatePosition(pendingPosition);
    pendingRouteToken = null;
    pendingResume = null;
    pendingPosition = null;
  };

  const handleControlMessage = (data: RawData): void => {
    const buffer = rawDataToBuffer(data);
    const frameAllowed = frameBucket.take();
    const bytesAllowed = byteBucket.take(buffer.byteLength);
    const bypassCandidate = buffer.byteLength <= SESSION_END_BYPASS_MAX_BYTES;
    if ((!frameAllowed || !bytesAllowed) && !bypassCandidate) {
      ws.close(CONTROL_RATE_CLOSE_CODE, "control-rate-limit");
      return;
    }
    if (buffer.byteLength > CONTROL_FRAME_MAX_BYTES) {
      console.warn("[voice] ignoring oversized control frame");
      return;
    }
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(buffer.toString("utf8"));
    } catch {
      console.warn("[voice] ignoring unparseable text message");
      return;
    }
    if (SessionEndMessageSchema.safeParse(parsed).success) {
      disposed = true;
      connGen++;
      const resumeNavId = pendingResume?.navigationId;
      pendingRouteToken = null;
      pendingResume = null;
      pendingPosition = null;
      if (bridge) {
        if (typeof bridge.endSession === "function") {
          bridge.endSession();
        } else {
          bridge.close();
        }
      } else if (resumeNavId && userId) {
        void deleteNavigationSnapshot(resumeNavId, userId).catch(() => {});
      }
      ws.close(1000, "client-end");
      return;
    }
    if (!frameAllowed || !bytesAllowed) {
      ws.close(CONTROL_RATE_CLOSE_CODE, "control-rate-limit");
      return;
    }
    if (parsed?.type === "nav.setRoute") {
      if (!controlBucket.take()) return;
      const result = NavSetRouteMessageSchema.safeParse(parsed);
      if (!result.success) {
        console.warn(
          `[voice] rejecting nav.setRoute: ${describeIssues(result.error)}`,
        );
        sendJson({
          type: "nav.error",
          code: "NAV_ROUTE_INVALID",
          message: "路線憑證格式無效",
        });
        return;
      }
      if (bridge) void bridge.armRouteToken(result.data.routeToken);
      else pendingRouteToken = result.data.routeToken;
      return;
    }
    if (parsed?.type === "nav.position") {
      if (!positionBucket.take()) return;
      const result = NavPositionMessageSchema.safeParse(parsed);
      if (!result.success) {
        console.warn(
          `[voice] ignoring nav.position: ${describeIssues(result.error)}`,
        );
        return;
      }
      const { type: _type, ...position } = result.data;
      if (bridge) bridge.updatePosition(position);
      else pendingPosition = position;
      return;
    }
    if (parsed?.type === "nav.resume") {
      if (!controlBucket.take()) return;
      const result = NavResumeMessageSchema.safeParse(parsed);
      if (!result.success) {
        console.warn(
          `[voice] rejecting nav.resume: ${describeIssues(result.error)}`,
        );
        sendJson({
          type: "nav.resume_failed",
          navigationId:
            typeof parsed.navigationId === "string" ? parsed.navigationId : "",
          code: "INVALID_REQUEST",
          message: "恢復導航請求格式無效",
          retryable: false,
        });
        return;
      }
      if (bridge) void bridge.resumeNavigation(result.data);
      else pendingResume = result.data;
      return;
    }
    if (NavCancelMessageSchema.safeParse(parsed).success) {
      if (!controlBucket.take()) return;
      const resumeNavId = pendingResume?.navigationId;
      pendingRouteToken = null;
      pendingResume = null;
      pendingPosition = null;
      if (bridge) {
        bridge.cancelNav();
      } else if (resumeNavId && userId) {
        void deleteNavigationSnapshot(resumeNavId, userId).catch(() => {});
      }
      return;
    }
    console.warn(
      `[voice] ignoring unexpected message type: ${String(parsed?.type)}`,
    );
  };

  ws.on("pong", () => {
    missedPongs = 0;
  });

  ws.on("message", (data: RawData, isBinary: boolean) => {
    if (!authenticated) {
      // Authentication now hits the database, so frames sent straight after
      // session.start can arrive mid-check. Hold them until it settles instead
      // of treating them as a malformed handshake and dropping the connection.
      if (authInFlight) {
        if (authQueue.length >= AUTH_QUEUE_MAX_FRAMES) {
          ws.close(4401, "unauthorized");
          return;
        }
        authQueue.push({ data, isBinary });
        return;
      }
      authInFlight = handleAuthMessage(data, isBinary);
      return;
    }
    if (isBinary) {
      bridge?.sendAudio(rawDataToBuffer(data));
      return;
    }
    handleControlMessage(data);
  });

  ws.on("close", () => {
    disposed = true;
    connGen++;
    pendingRouteToken = null;
    pendingResume = null;
    pendingPosition = null;
    clearTimeout(authTimer);
    clearInterval(heartbeatTimer);
    bridge?.close();
    if (userId && connections.get(userId)?.ws === ws) {
      connections.delete(userId);
    }
  });

  ws.on("error", (err) => {
    disposed = true;
    connGen++;
    console.error("[voice] socket error:", err.message);
  });
}

/**
 * Attaches the voice WebSocket gateway to an HTTP server. Upgrade requests
 * are only accepted on the voice WS path; every other path receives an HTTP
 * 404 before the socket is destroyed.
 *
 * @param server The HTTP server created around the Express app.
 * @param options Optional overrides (auth deadline injection for tests).
 */
export function attachVoiceWebSocket(
  server: http.Server,
  options: AttachVoiceWebSocketOptions = {},
): void {
  const authTimeoutMs = options.authTimeoutMs ?? DEFAULT_AUTH_TIMEOUT_MS;
  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: VOICE_MAX_PAYLOAD_BYTES,
  });

  registerWsRoute(server, { path: VOICE_WS_PATH, wss });

  wss.on("connection", (ws: WebSocket) => {
    handleConnection(ws, authTimeoutMs);
  });
}
