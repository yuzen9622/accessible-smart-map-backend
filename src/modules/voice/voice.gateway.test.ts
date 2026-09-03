import http from "http";
import { AddressInfo } from "net";
import jwt from "jsonwebtoken";
import WebSocket from "ws";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";

vi.mock("./live-bridge", () => ({
  createLiveBridge: vi.fn(async () => ({
    sendAudio: vi.fn(),
    armRouteToken: vi.fn(),
    resumeNavigation: vi.fn(),
    updatePosition: vi.fn(),
    cancelNav: vi.fn(),
    endSession: vi.fn(),
    close: vi.fn(),
  })),
}));

import app from "../../app";
import { attachVoiceWebSocket } from "./voice.gateway";
import { createLiveBridge } from "./live-bridge";
import {
  buildDbUser,
  stubAuthUserLookup,
} from "../../../tests/helpers/real-auth";

const mockCreateLiveBridge = createLiveBridge as unknown as ReturnType<
  typeof vi.fn
>;

const AUTH_TIMEOUT_MS = 300;

let server: http.Server;
let port: number;
const openSockets: WebSocket[] = [];

/**
 * Signs a valid access token with the same payload shape and secret used by
 * tests/helpers/real-auth.ts. Includes tokenVersion 0, which the production
 * revocation check compares against the `User.findById` stub.
 *
 * @param userId The user _id embedded in the JWT payload.
 * @returns A signed access token string.
 */
function signToken(userId: string): string {
  return jwt.sign(
    {
      user: {
        _id: userId,
        email: `${userId}@example.com`,
        tokenVersion: 0,
      },
    },
    process.env.JWT_ACCESS_SECRET ?? "test-access-secret",
  );
}

/**
 * Opens a WebSocket client against the test server and tracks it for cleanup.
 *
 * @param path The request path for the upgrade.
 * @returns The connecting WebSocket client.
 */
function connect(path = "/api/v1/voice/ws"): WebSocket {
  const ws = new WebSocket(`ws://127.0.0.1:${port}${path}`);
  openSockets.push(ws);
  return ws;
}

/**
 * Resolves when the socket emits open.
 *
 * @param ws The WebSocket client.
 * @returns A promise resolved on open, rejected on error.
 */
function waitForOpen(ws: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    ws.on("open", () => resolve());
    ws.on("error", reject);
  });
}

/**
 * Resolves with the close code and reason once the socket closes.
 *
 * @param ws The WebSocket client.
 * @returns A promise of the close code and reason string.
 */
function waitForClose(
  ws: WebSocket,
): Promise<{ code: number; reason: string }> {
  return new Promise((resolve) => {
    ws.on("close", (code, reason) =>
      resolve({ code, reason: reason.toString() }),
    );
  });
}

/**
 * Resolves with the next JSON message received on the socket.
 *
 * @param ws The WebSocket client.
 * @returns A promise of the parsed JSON message.
 */
function waitForJson(ws: WebSocket): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    ws.once("message", (data) => resolve(JSON.parse(data.toString())));
  });
}

/**
 * Sends an authenticating session.start message for the given user.
 *
 * @param ws The open WebSocket client.
 * @param userId The user to authenticate as.
 */
function sendSessionStart(
  ws: WebSocket,
  userId: string,
  userLocation?: { latitude: number; longitude: number },
): void {
  ws.send(
    JSON.stringify({
      type: "session.start",
      token: signToken(userId),
      userLocation,
    }),
  );
}

beforeAll(async () => {
  server = http.createServer(app);
  attachVoiceWebSocket(server, { authTimeoutMs: AUTH_TIMEOUT_MS });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as AddressInfo).port;
  // Real auth path: the handshake runs the production authenticateToken();
  // only the User.findById DB seam is stubbed, echoing whatever id the token
  // claims so the tokenVersion check passes.
  stubAuthUserLookup((id) => buildDbUser({ _id: id }));
});

afterEach(() => {
  for (const ws of openSockets.splice(0)) {
    ws.removeAllListeners();
    ws.terminate();
  }
  vi.clearAllMocks();
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe("voice gateway", () => {
  it("closes 4401 when no session.start arrives before the auth deadline", async () => {
    const ws = connect();
    await waitForOpen(ws);
    const { code } = await waitForClose(ws);
    expect(code).toBe(4401);
  });

  it("closes 4401 when session.start carries an invalid token", async () => {
    const ws = connect();
    await waitForOpen(ws);
    ws.send(
      JSON.stringify({ type: "session.start", token: "not-a-valid-token" }),
    );
    const { code } = await waitForClose(ws);
    expect(code).toBe(4401);
  });

  it("closes 4401 when a binary frame arrives before authentication", async () => {
    const ws = connect();
    await waitForOpen(ws);
    ws.send(Buffer.from([0x01, 0x02, 0x03]));
    const { code } = await waitForClose(ws);
    expect(code).toBe(4401);
  });

  it("closes 4401 on an oversized unauthenticated frame before creating Live", async () => {
    const ws = connect();
    await waitForOpen(ws);
    const closed = waitForClose(ws);
    ws.send(
      JSON.stringify({ type: "session.start", token: "x".repeat(9_000) }),
    );
    expect((await closed).code).toBe(4401);
    expect(mockCreateLiveBridge).not.toHaveBeenCalled();
  });

  it("replies session.ready and keeps the connection alive for a valid token", async () => {
    const ws = connect();
    await waitForOpen(ws);
    const ready = waitForJson(ws);
    sendSessionStart(ws, "voice-user-valid");
    const message = await ready;
    expect(message).toEqual({ type: "session.ready" });
    expect(ws.readyState).toBe(WebSocket.OPEN);
  });

  it("forwards a valid GPS pair to the Live bridge", async () => {
    const ws = connect();
    await waitForOpen(ws);
    const ready = waitForJson(ws);
    sendSessionStart(ws, "voice-user-location", {
      latitude: 25.0478,
      longitude: 121.517,
    });
    await ready;

    expect(mockCreateLiveBridge).toHaveBeenCalledWith(
      expect.objectContaining({
        userLocation: { latitude: 25.0478, longitude: 121.517 },
      }),
    );
  });

  it("drops an out-of-range GPS pair before creating the Live bridge", async () => {
    const ws = connect();
    await waitForOpen(ws);
    const ready = waitForJson(ws);
    sendSessionStart(ws, "voice-user-invalid-location", {
      latitude: 999,
      longitude: 121.517,
    });
    await ready;

    expect(mockCreateLiveBridge).toHaveBeenCalledWith(
      expect.objectContaining({
        userLocation: undefined,
      }),
    );
  });

  it("routes nav.setRoute, nav.position, and nav.cancel to the bridge", async () => {
    const ws = connect();
    await waitForOpen(ws);
    const ready = waitForJson(ws);
    sendSessionStart(ws, "voice-user-nav");
    await ready;
    const bridge = await mockCreateLiveBridge.mock.results.at(-1)!.value;
    ws.send(JSON.stringify({ type: "nav.setRoute", routeToken: "capability" }));
    ws.send(
      JSON.stringify({
        type: "nav.position",
        latitude: 25,
        longitude: 121,
        accuracy: 5,
      }),
    );
    ws.send(JSON.stringify({ type: "nav.cancel" }));
    await vi.waitFor(() =>
      expect(bridge.armRouteToken).toHaveBeenCalledWith("capability"),
    );
    expect(bridge.updatePosition).toHaveBeenCalledWith({
      latitude: 25,
      longitude: 121,
      accuracy: 5,
    });
    expect(bridge.cancelNav).toHaveBeenCalledOnce();
  });

  it("emits nav.error for a parsed nav.setRoute with an invalid token", async () => {
    const ws = connect();
    await waitForOpen(ws);
    const ready = waitForJson(ws);
    sendSessionStart(ws, "voice-user-invalid-cap");
    await ready;
    const message = waitForJson(ws);
    ws.send(JSON.stringify({ type: "nav.setRoute", routeToken: "" }));
    await expect(message).resolves.toMatchObject({
      type: "nav.error",
      code: "NAV_ROUTE_INVALID",
    });
  });

  it("ignores an oversized authenticated control frame before JSON parsing", async () => {
    const ws = connect();
    await waitForOpen(ws);
    const ready = waitForJson(ws);
    sendSessionStart(ws, "voice-user-oversized");
    await ready;
    const bridge = await mockCreateLiveBridge.mock.results.at(-1)!.value;
    ws.send(
      JSON.stringify({ type: "nav.setRoute", routeToken: "x".repeat(9_000) }),
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(bridge.armRouteToken).not.toHaveBeenCalled();
    expect(ws.readyState).toBe(WebSocket.OPEN);
  });

  it("keeps latest route and position while Live bridge creation is pending", async () => {
    let resolveBridge!: (bridge: any) => void;
    const pending = new Promise<any>((resolve) => {
      resolveBridge = resolve;
    });
    mockCreateLiveBridge.mockImplementationOnce(() => pending);
    const ws = connect();
    await waitForOpen(ws);
    sendSessionStart(ws, "voice-user-pending");
    ws.send(JSON.stringify({ type: "nav.setRoute", routeToken: "first" }));
    ws.send(JSON.stringify({ type: "nav.setRoute", routeToken: "latest" }));
    ws.send(
      JSON.stringify({ type: "nav.position", latitude: 25, longitude: 121 }),
    );
    const bridge = {
      sendAudio: vi.fn(),
      armRouteToken: vi.fn(),
      updatePosition: vi.fn(),
      cancelNav: vi.fn(),
      close: vi.fn(),
    };
    const ready = waitForJson(ws);
    resolveBridge(bridge);
    await expect(ready).resolves.toEqual({ type: "session.ready" });
    await vi.waitFor(() =>
      expect(bridge.armRouteToken).toHaveBeenCalledWith("latest"),
    );
    expect(bridge.armRouteToken).toHaveBeenCalledOnce();
    expect(bridge.updatePosition).toHaveBeenCalledWith({
      latitude: 25,
      longitude: 121,
    });
  });

  it("closes a bridge that resolves after its WebSocket was already closed", async () => {
    let resolveBridge!: (bridge: any) => void;
    const pending = new Promise<any>((resolve) => {
      resolveBridge = resolve;
    });
    mockCreateLiveBridge.mockImplementationOnce(() => pending);
    const ws = connect();
    await waitForOpen(ws);
    sendSessionStart(ws, "voice-user-close-race");
    const closed = waitForClose(ws);
    ws.close(1000, "test-close");
    await closed;
    const bridge = {
      sendAudio: vi.fn(),
      armRouteToken: vi.fn(),
      updatePosition: vi.fn(),
      cancelNav: vi.fn(),
      close: vi.fn(),
    };
    resolveBridge(bridge);
    await vi.waitFor(() => expect(bridge.close).toHaveBeenCalledOnce());
    expect(bridge.armRouteToken).not.toHaveBeenCalled();
  });

  it("rate-limits high-frequency positions before bridge processing", async () => {
    const ws = connect();
    await waitForOpen(ws);
    const ready = waitForJson(ws);
    sendSessionStart(ws, "voice-user-position-flood");
    await ready;
    const bridge = await mockCreateLiveBridge.mock.results.at(-1)!.value;
    for (let i = 0; i < 50; i++) {
      ws.send(
        JSON.stringify({
          type: "nav.position",
          latitude: 25,
          longitude: 121 + i / 100_000,
        }),
      );
    }
    await vi.waitFor(() => expect(bridge.updatePosition).toHaveBeenCalled());
    expect(bridge.updatePosition.mock.calls.length).toBeLessThanOrEqual(30);
    expect(ws.readyState).toBe(WebSocket.OPEN);
  });

  it("closes the connection when the pre-parse per-connection frame budget is exhausted", async () => {
    const ws = connect();
    await waitForOpen(ws);
    const ready = waitForJson(ws);
    sendSessionStart(ws, "voice-user-frame-flood");
    await ready;
    const closed = waitForClose(ws);
    for (let i = 0; i < 90; i++)
      ws.send(JSON.stringify({ type: `unknown.${i}`, pad: "x".repeat(1100) }));
    const result = await closed;
    expect(result.code).toBe(4408);
    expect(result.reason).toBe("control-rate-limit");
  });

  it("uses WebSocket close as the session.end termination path", async () => {
    const ws = connect();
    await waitForOpen(ws);
    const ready = waitForJson(ws);
    sendSessionStart(ws, "voice-user-end");
    await ready;
    const closed = waitForClose(ws);
    ws.send(JSON.stringify({ type: "session.end" }));
    expect(await closed).toEqual({ code: 1000, reason: "client-end" });
  });

  it("still accepts session.end after the parsed-control budget is exhausted", async () => {
    const ws = connect();
    await waitForOpen(ws);
    const ready = waitForJson(ws);
    sendSessionStart(ws, "voice-user-end-after-budget");
    await ready;
    for (let i = 0; i < 45; i++)
      ws.send(JSON.stringify({ type: "nav.cancel" }));
    const closed = waitForClose(ws);
    ws.send(JSON.stringify({ type: "session.end" }));
    expect(await closed).toEqual({ code: 1000, reason: "client-end" });
  });

  it("closes the first connection with 4409 when the same user reconnects", async () => {
    const first = connect();
    await waitForOpen(first);
    const firstReady = waitForJson(first);
    sendSessionStart(first, "voice-user-dup");
    await firstReady;

    const firstClosed = waitForClose(first);
    const second = connect();
    await waitForOpen(second);
    const secondReady = waitForJson(second);
    sendSessionStart(second, "voice-user-dup");
    await secondReady;

    const { code } = await firstClosed;
    expect(code).toBe(4409);
    expect(second.readyState).toBe(WebSocket.OPEN);
  });

  it("rejects the upgrade with 404 on any other path", async () => {
    const ws = connect("/api/v1/voice/other");
    const error = await new Promise<Error>((resolve) => {
      ws.on("error", (err) => resolve(err));
    });
    expect(error.message).toContain("404");
  });
});
