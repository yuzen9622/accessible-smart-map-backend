import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import request from "supertest";

/**
 * Daily-tier contract for the tiered AI limiters.
 *
 * `aiChatRateLimit` mounts three layers per identity — backstop, burst
 * (10-minute window), daily (24-hour window) — but the anonymous burst
 * allowance (10 / 10min) always trips before the daily allowance (60 / 24h)
 * under real-time traffic, so no burst-window test can ever reach the daily
 * layer. Deleting the daily layer from the mount chain would therefore stay
 * green under every other rate-limit test in this module.
 *
 * This file closes that gap by advancing a faked `Date` across burst windows:
 * each window sends exactly the burst allowance (never tripping burst), and
 * after enough windows the cumulative count exceeds the daily allowance.
 * Only `Date` is faked (`toFake: ["Date"]`) — `setTimeout`/`setInterval` stay
 * real so supertest's actual socket I/O keeps working; express-rate-limit's
 * default `MemoryStore` only ever reads `Date.now()` / `new Date()` to decide
 * whether a client's window has rolled over (see
 * `express-rate-limit/dist/index.cjs`'s `MemoryStore.increment`), so faking
 * only the clock is sufficient to walk the store through real windows without
 * waiting in real time.
 */

vi.mock("./ai-chat.service", () => ({
  runChatAgent: vi.fn(async () => ({ text: "ok", toolResults: [] })),
  toGeminiHistory: vi.fn(() => ({
    systemInstruction: undefined,
    contents: [],
  })),
}));

vi.mock("./memory.service", () => ({
  getMemorySettings: vi.fn(async () => ({ memoryEnabled: false })),
  searchMemoriesForPrompt: vi.fn(async () => []),
}));

import {
  startTestServer,
  stopTestServer,
} from "../../../tests/helpers/test-helpers";
import { ResponseCode } from "../../types/code";

let server: Awaited<ReturnType<typeof startTestServer>>;

const CHAT_URL = "/api/v1/ai/chat";
const CHAT_ANON_BURST = 10;
const CHAT_ANON_DAILY = 60;
const BURST_WINDOW_MS = 10 * 60 * 1000;

const CHAT_BODY = {
  messages: [{ role: "user", content: "hi" }],
  stream: false,
};

beforeAll(async () => {
  server = await startTestServer();
});

afterAll(async () => {
  await stopTestServer(server);
});

afterEach(() => {
  vi.useRealTimers();
});

/** Fires one anonymous chat request from the given client IP. */
function anonChat(ip: string) {
  return request(server)
    .post(CHAT_URL)
    .set("X-Forwarded-For", ip)
    .send(CHAT_BODY);
}

describe("POST /api/v1/ai/chat 每日限流層", () => {
  it("A8: 跨多個 burst 視窗、每窗不超過 burst 額度，累積超過每日額度時仍回 429", async () => {
    const ip = "203.0.113.90";

    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));

    const windows = Math.ceil(CHAT_ANON_DAILY / CHAT_ANON_BURST);
    for (let w = 0; w < windows; w += 1) {
      for (let i = 0; i < CHAT_ANON_BURST; i += 1) {
        const res = await anonChat(ip);
        expect(res.status).toBe(ResponseCode.OK);
      }
      // Advance past this burst window so the next batch starts fresh
      // against the burst/backstop layers, but the daily window (24h) never
      // rolls over across these small hops.
      vi.setSystemTime(new Date(Date.now() + BURST_WINDOW_MS));
    }

    // Total requests sent so far equal the daily allowance exactly (60), none
    // of them tripped burst (10 per fresh window) or backstop (30 per fresh
    // window). One more request, in yet another fresh burst window, must
    // still be rejected — only the daily layer can be the reason.
    const res = await anonChat(ip);
    expect(res.status).toBe(ResponseCode.TOO_MANY_REQUESTS);
    expect(res.body.ok).toBe(false);
    expect(res.body.status).toBe("error");
    expect(res.body.code).toBe(ResponseCode.TOO_MANY_REQUESTS);
  });
});
