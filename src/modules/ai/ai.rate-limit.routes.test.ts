import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import request from "supertest";

/**
 * Rate-limit contract for the anonymous-but-expensive AI endpoints.
 *
 * These routes stay usable without a token by product contract, so the only
 * thing standing between an anonymous caller and an unbounded Gemini bill is
 * the tiered limiter chain mounted in `src/modules/ai/ai.router.ts`. The tests
 * drive the real Express app through supertest and the real auth path (only
 * the `User.findById` DB seam is stubbed), so removing `optionalAuth` or any
 * limiter layer turns them red.
 *
 * Buckets are keyed by client IP, and `trust proxy` is a hop count, so each
 * test picks its own `X-Forwarded-For` address to get a fresh bucket.
 */

vi.mock("./ai-chat.service", () => ({
  runChatAgent: vi.fn(async () => ({ text: "ok", toolResults: [] })),
  toGeminiHistory: vi.fn(() => ({
    systemInstruction: undefined,
    contents: [],
  })),
}));

vi.mock("./ai.service", () => ({
  parseRouteIntent: vi.fn(async () => ({ origin: "A", destination: "B" })),
  generateRouteExplanation: vi.fn(async () => ({ summary: "ok" })),
}));

vi.mock("./memory.service", () => ({
  getMemorySettings: vi.fn(async () => ({ memoryEnabled: false })),
  searchMemoriesForPrompt: vi.fn(async () => []),
}));

import {
  startTestServer,
  stopTestServer,
} from "../../../tests/helpers/test-helpers";
import {
  bearerFor,
  expiredBearerFor,
  stubAuthUserLookup,
} from "../../../tests/helpers/real-auth";
import { redisClient } from "../../config/redis";
import { ResponseCode } from "../../types/code";

let server: Awaited<ReturnType<typeof startTestServer>>;

const CHAT_URL = "/api/v1/ai/chat";
const INTENT_URL = "/api/v1/ai/intent";
const EXPLAIN_URL = "/api/v1/ai/explain";

const CHAT_ANON_BURST = 10;
const INTENT_ANON_BURST = 30;

const CHAT_BODY = {
  messages: [{ role: "user", content: "hi" }],
  stream: false,
};
const INTENT_BODY = { query: "從台北車站到台北101" };
const EXPLAIN_BODY = { route: { routeName: "測試路線" } };

beforeAll(async () => {
  server = await startTestServer();
});

afterAll(async () => {
  await stopTestServer(server);
});

beforeEach(() => {
  vi.restoreAllMocks();
  stubAuthUserLookup();
});

/** Fires one anonymous chat request from the given client IP. */
function anonChat(ip: string) {
  return request(server)
    .post(CHAT_URL)
    .set("X-Forwarded-For", ip)
    .send(CHAT_BODY);
}

/** Fires one authenticated chat request from the given client IP. */
function authedChat(ip: string) {
  return request(server)
    .post(CHAT_URL)
    .set("X-Forwarded-For", ip)
    .set("Authorization", bearerFor())
    .send(CHAT_BODY);
}

/** Asserts a 429 answered through the shared response envelope. */
function expectRateLimitEnvelope(res: request.Response) {
  expect(res.status).toBe(ResponseCode.TOO_MANY_REQUESTS);
  expect(res.body.ok).toBe(false);
  expect(res.body.status).toBe("error");
  expect(res.body.code).toBe(ResponseCode.TOO_MANY_REQUESTS);
  expect(typeof res.body.message).toBe("string");
  expect(res.body.message.length).toBeGreaterThan(0);
}

describe("POST /api/v1/ai/chat 匿名限流", () => {
  it("A1: 不帶 token 連打第 11 次回 429，且走統一信封", async () => {
    const ip = "203.0.113.11";
    for (let i = 0; i < CHAT_ANON_BURST; i += 1) {
      const res = await anonChat(ip);
      expect(res.status).toBe(ResponseCode.OK);
    }

    expectRateLimitEnvelope(await anonChat(ip));
  });

  it("A4: 未設定 REDIS_URL 時仍由記憶體 store 擋下第 11 次", async () => {
    expect(process.env.REDIS_URL).toBeUndefined();
    expect(redisClient).toBeNull();

    const ip = "203.0.113.44";
    for (let i = 0; i < CHAT_ANON_BURST; i += 1) {
      expect((await anonChat(ip)).status).toBe(ResponseCode.OK);
    }

    expect((await anonChat(ip)).status).toBe(ResponseCode.TOO_MANY_REQUESTS);
  });
});

describe("POST /api/v1/ai/chat 已登入額度與匿名額度互不污染", () => {
  it("A2: 同一 IP 的匿名額度用盡後，帶有效 token 的第 11 次仍是 200", async () => {
    const ip = "203.0.113.22";
    for (let i = 0; i < CHAT_ANON_BURST; i += 1) {
      expect((await anonChat(ip)).status).toBe(ResponseCode.OK);
    }
    expect((await anonChat(ip)).status).toBe(ResponseCode.TOO_MANY_REQUESTS);

    for (let i = 0; i < CHAT_ANON_BURST; i += 1) {
      expect((await authedChat(ip)).status).toBe(ResponseCode.OK);
    }

    expect((await authedChat(ip)).status).toBe(ResponseCode.OK);
  });
});

describe("POST /api/v1/ai/chat 壞掉的 token 不會靜默降級為匿名", () => {
  it("A3a: 過期 token 回 401", async () => {
    const res = await request(server)
      .post(CHAT_URL)
      .set("X-Forwarded-For", "203.0.113.31")
      .set("Authorization", expiredBearerFor())
      .send(CHAT_BODY);

    expect(res.status).toBe(ResponseCode.UNAUTHORIZED);
    expect(res.body.ok).toBe(false);
  });

  it("A3b: 無效 token 回 403", async () => {
    const res = await request(server)
      .post(CHAT_URL)
      .set("X-Forwarded-For", "203.0.113.32")
      .set("Authorization", "Bearer not-a-real-token")
      .send(CHAT_BODY);

    expect(res.status).toBe(ResponseCode.FORBIDDEN);
    expect(res.body.ok).toBe(false);
  });
});

describe("POST /api/v1/ai/chat IPv6 子網正規化", () => {
  it("A7: 同一 /56 子網內的兩個 IPv6 位址共用同一個限流桶", async () => {
    const ipA = "2001:db8:1:1::1";
    const ipB = "2001:db8:1:1:ffff:ffff:ffff:ffff";

    for (let i = 0; i < CHAT_ANON_BURST; i += 1) {
      expect((await anonChat(ipA)).status).toBe(ResponseCode.OK);
    }

    // ipA already spent the whole bucket. If the key generator used the raw
    // `req.ip` instead of `ipKeyGenerator` (which collapses IPv6 addresses to
    // their /56 subnet), ipB would land in its own fresh bucket and this
    // request would wrongly succeed with 200.
    expectRateLimitEnvelope(await anonChat(ipB));
  });
});

describe("POST /api/v1/ai/intent 與 /api/v1/ai/explain 匿名限流", () => {
  it("A6a: /intent 匿名連打第 31 次回 429", async () => {
    const ip = "203.0.113.61";
    for (let i = 0; i < INTENT_ANON_BURST; i += 1) {
      const res = await request(server)
        .post(INTENT_URL)
        .set("X-Forwarded-For", ip)
        .send(INTENT_BODY);
      expect(res.status).toBe(ResponseCode.OK);
    }

    const limited = await request(server)
      .post(INTENT_URL)
      .set("X-Forwarded-For", ip)
      .send(INTENT_BODY);
    expectRateLimitEnvelope(limited);
  });

  it("A6b: /explain 匿名連打第 31 次回 429", async () => {
    const ip = "203.0.113.62";
    for (let i = 0; i < INTENT_ANON_BURST; i += 1) {
      const res = await request(server)
        .post(EXPLAIN_URL)
        .set("X-Forwarded-For", ip)
        .send(EXPLAIN_BODY);
      expect(res.status).toBe(ResponseCode.OK);
    }

    const limited = await request(server)
      .post(EXPLAIN_URL)
      .set("X-Forwarded-For", ip)
      .send(EXPLAIN_BODY);
    expectRateLimitEnvelope(limited);
  });
});
