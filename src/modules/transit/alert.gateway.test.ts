import http from "http";
import type { AddressInfo } from "net";
import WebSocket from "ws";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

vi.mock("../../config/fetch", () => ({ tdxFetch: vi.fn() }));
vi.mock("../../model/bus-route.model", () => ({ default: { find: vi.fn() } }));

import { tdxFetch } from "../../config/fetch";
import { attachVoiceWebSocket } from "../voice";
import { attachAlertWebSocket, ALERT_WS_PATH } from "./alert.gateway";
import { clearAlertStore, upsertAlertSnapshot } from "./alert.store";

const tdxFetchMock = tdxFetch as unknown as ReturnType<typeof vi.fn>;

let server: http.Server;
let port: number;
const openSockets: WebSocket[] = [];

function connect(path = ALERT_WS_PATH): WebSocket {
  const ws = new WebSocket(`ws://127.0.0.1:${port}${path}`);
  openSockets.push(ws);
  return ws;
}

function waitForOpen(ws: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    ws.on("open", () => resolve());
    ws.on("error", reject);
  });
}

function collectMessages(ws: WebSocket): Array<Record<string, unknown>> {
  const received: Array<Record<string, unknown>> = [];
  ws.on("message", (raw) => {
    received.push(JSON.parse(raw.toString()));
  });
  return received;
}

async function waitForMessageCount(
  received: unknown[],
  count: number,
  timeoutMs = 1000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (received.length < count) {
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${count} message(s)`);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Seeds the store first: a cold store makes getTransitAlerts fall back to REST,
// whose own upsertAlertSnapshot re-fires the listener and yields a second push.
async function subscribedClient(): Promise<{
  ws: WebSocket;
  received: Array<Record<string, unknown>>;
}> {
  upsertAlertSnapshot("metro:TRTC", [], "mqtt");
  const ws = connect();
  await waitForOpen(ws);
  const received = collectMessages(ws);
  ws.send(
    JSON.stringify({
      type: "subscribe",
      ctx: { mode: "metro", railSystem: "TRTC" },
    }),
  );
  await waitForMessageCount(received, 1);
  return { ws, received };
}

beforeAll(async () => {
  server = http.createServer((_req, res) => res.end("ok"));
  attachAlertWebSocket(server);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  port = (server.address() as AddressInfo).port;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  vi.clearAllMocks();
  clearAlertStore();
  tdxFetchMock.mockResolvedValue({
    ok: true,
    json: async () => ({ Alerts: [] }),
  });
});

afterEach(async () => {
  while (openSockets.length > 0) {
    const ws = openSockets.pop();
    ws?.close();
  }
  clearAlertStore();
  await delay(20);
});

describe("alert websocket gateway", () => {
  it("pushes a snapshot immediately after subscribe", async () => {
    const ws = connect();
    await waitForOpen(ws);
    const received = collectMessages(ws);

    ws.send(
      JSON.stringify({
        type: "subscribe",
        ctx: { mode: "metro", railSystem: "TRTC" },
      }),
    );
    await waitForMessageCount(received, 1);

    expect(received[0].type).toBe("alerts");
    const result = received[0].result as { ok: boolean; alerts: unknown[] };
    expect(result.ok).toBe(true);
    expect(Array.isArray(result.alerts)).toBe(true);
  });

  it("pushes again when a relevant store key updates", async () => {
    const { received } = await subscribedClient();

    upsertAlertSnapshot(
      "metro:TRTC",
      [
        {
          AlertID: "trtc-1",
          Title: "板南線延誤",
          Description: "列車延誤",
          Status: 1,
          Scope: { Lines: [{ LineID: "BL" }] },
        },
      ],
      "mqtt",
    );
    await waitForMessageCount(received, 2);

    const result = received[1].result as { ok: boolean; alerts: unknown[] };
    expect(received[1].type).toBe("alerts");
    expect(result.ok).toBe(true);
  });

  it("does not push when an unrelated store key updates", async () => {
    const { received } = await subscribedClient();

    upsertAlertSnapshot("tra", [], "mqtt");
    await delay(200);

    expect(received).toHaveLength(1);
  });

  it("stops pushing after unsubscribe", async () => {
    const { ws, received } = await subscribedClient();

    ws.send(JSON.stringify({ type: "unsubscribe" }));
    await delay(50);
    upsertAlertSnapshot("metro:TRTC", [], "mqtt");
    await delay(200);

    expect(received).toHaveLength(1);
  });

  it("ignores malformed and unknown messages", async () => {
    const ws = connect();
    await waitForOpen(ws);
    const received = collectMessages(ws);

    ws.send("not-json");
    ws.send(JSON.stringify({ type: "bogus" }));
    await delay(150);

    expect(received).toHaveLength(0);
    expect(ws.readyState).toBe(WebSocket.OPEN);
  });

  it("rejects upgrades on other paths with 404", async () => {
    const ws = connect("/api/v1/does-not-exist");
    const error = await new Promise<Error>((resolve) => {
      ws.on("error", resolve);
    });

    expect(error.message).toContain("404");
  });

  it("coexists with the voice gateway on the same server", async () => {
    const combined = http.createServer((_req, res) => res.end("ok"));
    attachVoiceWebSocket(combined);
    attachAlertWebSocket(combined);
    await new Promise<void>((resolve) => combined.listen(0, resolve));
    const combinedPort = (combined.address() as AddressInfo).port;

    // 回歸：voice gateway 的 upgrade listener 曾把非 voice 路徑 404 掉，
    // 導致 alert path 在共同 server 上連不上（registerWsRoute 修掉）。
    const ws = new WebSocket(`ws://127.0.0.1:${combinedPort}${ALERT_WS_PATH}`);
    await waitForOpen(ws);
    ws.close();

    await new Promise<void>((resolve) => combined.close(() => resolve()));
  });
});
