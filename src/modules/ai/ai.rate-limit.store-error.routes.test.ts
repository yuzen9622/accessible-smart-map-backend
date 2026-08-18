import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import request from "supertest";

/**
 * Store-failure contract for the tiered AI limiters.
 *
 * express-rate-limit rethrows a store error unless `passOnStoreError` is on,
 * and a rethrown error never reaches the handler — it becomes a 500. This file
 * injects a store that fails every call and asserts the two halves of the
 * intended behaviour: normal traffic still gets its answer, and the in-memory
 * backstop layer still caps what a single process can spend.
 *
 * The injection replaces `rate-limit-redis` with an always-throwing store and
 * makes the Redis client look configured, so `createRateLimiter` takes its real
 * Redis branch.
 */

vi.mock("rate-limit-redis", () => ({
  RedisStore: class ThrowingStore {
    prefix = "throwing:";

    async init(): Promise<void> {
      throw new Error("store unavailable");
    }

    async increment(): Promise<never> {
      throw new Error("store unavailable");
    }

    async decrement(): Promise<never> {
      throw new Error("store unavailable");
    }

    async resetKey(): Promise<never> {
      throw new Error("store unavailable");
    }
  },
}));

vi.mock("../../config/redis", async (importActual) => ({
  ...(await importActual<typeof import("../../config/redis")>()),
  redisClient: { call: vi.fn() },
}));

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
const CHAT_BODY = {
  messages: [{ role: "user", content: "hi" }],
  stream: false,
};
// Anonymous burst is 10/10min and the in-memory backstop is three times that.
const BACKSTOP_LIMIT = 30;

beforeAll(async () => {
  server = await startTestServer();
});

afterAll(async () => {
  await stopTestServer(server);
});

/** Fires one anonymous chat request from the given client IP. */
function anonChat(ip: string) {
  return request(server)
    .post(CHAT_URL)
    .set("X-Forwarded-For", ip)
    .send(CHAT_BODY);
}

describe("限流 store 全數失敗時的行為", () => {
  it("A5: 未超過 backstop 額度回 200（不是 500），超過才回 429，且錯誤有被記錄", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const ip = "198.51.100.5";

    try {
      for (let i = 0; i < BACKSTOP_LIMIT; i += 1) {
        const res = await anonChat(ip);
        expect(res.status).toBe(ResponseCode.OK);
      }

      const limited = await anonChat(ip);
      expect(limited.status).toBe(ResponseCode.TOO_MANY_REQUESTS);
      expect(limited.body.ok).toBe(false);
      expect(limited.body.code).toBe(ResponseCode.TOO_MANY_REQUESTS);

      expect(
        errorSpy.mock.calls.some(
          (call) => call[0] === "[ratelimit] store error",
        ),
      ).toBe(true);
    } finally {
      errorSpy.mockRestore();
    }
  });
});
