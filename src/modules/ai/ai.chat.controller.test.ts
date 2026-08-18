import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";

vi.mock("./ai-chat.service", () => ({
  runChatAgent: vi.fn(),
  toInteractionInput: vi.fn(() => ({
    systemInstruction: undefined,
    input: [],
  })),
}));

import { buildTestApp } from "../../../tests/helpers/test-helpers";
import { googleGenAi } from "../../config/ai";
import { runChatAgent } from "./ai-chat.service";
import { AgentRateLimitError } from "../agent/agent-manager.service";

const app = buildTestApp();
const URL = "/api/v1/ai/chat";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("POST /api/v1/ai/chat 不再走舊 fallback，直接用 runChatAgent 的文字", () => {
  it("T4：non-streaming 回傳 loopResult.text，且不呼叫 fallback generateContent", async () => {
    vi.mocked(runChatAgent).mockResolvedValue({
      text: "測試答案",
      toolResults: [],
    });
    const genSpy = vi.spyOn(googleGenAi.models, "generateContent");

    const res = await request(app)
      .post(URL)
      .send({ messages: [{ role: "user", content: "hi" }], stream: false });

    expect(res.status).toBe(200);
    expect(res.body.data.choices[0].message.content).toBe("測試答案");
    expect(genSpy).not.toHaveBeenCalled();
  });

  it("T5：streaming 送 event: token + event: done，且不呼叫 fallback generateContentStream", async () => {
    vi.mocked(runChatAgent).mockResolvedValue({
      text: "串流答案",
      toolResults: [],
    });
    const streamSpy = vi.spyOn(googleGenAi.models, "generateContentStream");

    const res = await request(app)
      .post(URL)
      .send({ messages: [{ role: "user", content: "hi" }], stream: true });

    expect(res.status).toBe(200);
    expect(res.text).toContain("event: token");
    expect(res.text).toContain("串流答案");
    expect(res.text).toContain("event: done");
    expect(streamSpy).not.toHaveBeenCalled();
  });
});

describe("空回答不得被當成成功回應（M2-2）", () => {
  it("non-streaming：agent 回空字串 → 500 error，不回 200 空內容", async () => {
    vi.mocked(runChatAgent).mockResolvedValue({ text: "", toolResults: [] });

    const res = await request(app)
      .post(URL)
      .send({ messages: [{ role: "user", content: "hi" }], stream: false });

    expect(res.status).toBe(500);
    expect(res.body.ok).toBe(false);
    expect(res.body.data?.choices).toBeUndefined();
  });

  it("streaming：agent 回空字串 → 送 event: error，不送空的 event: token", async () => {
    vi.mocked(runChatAgent).mockResolvedValue({ text: "", toolResults: [] });

    const res = await request(app)
      .post(URL)
      .send({ messages: [{ role: "user", content: "hi" }], stream: true });

    expect(res.text).toContain("event: error");
    expect(res.text).not.toContain("event: token");
    expect(res.text).toContain("event: done");
  });

  it("streaming：AgentRateLimitError → error 事件帶 429 而非 500", async () => {
    vi.mocked(runChatAgent).mockRejectedValue(
      new AgentRateLimitError("忙線中"),
    );

    const res = await request(app)
      .post(URL)
      .send({ messages: [{ role: "user", content: "hi" }], stream: true });

    expect(res.text).toContain("event: error");
    expect(res.text).toContain("429");
  });

  it("non-streaming：AgentRateLimitError → HTTP 429", async () => {
    vi.mocked(runChatAgent).mockRejectedValue(
      new AgentRateLimitError("忙線中"),
    );

    const res = await request(app)
      .post(URL)
      .send({ messages: [{ role: "user", content: "hi" }], stream: false });

    expect(res.status).toBe(429);
  });
});

describe("streaming 逐字送出（M1-6）", () => {
  it("agent 逐塊回呼 → 送出多個 token 事件，且不重複送完整文字", async () => {
    vi.mocked(runChatAgent).mockImplementation(async (input: any) => {
      input.onTextDelta?.("您可以搭 ");
      input.onTextDelta?.("132 路");
      return { text: "您可以搭 132 路", toolResults: [] };
    });

    const res = await request(app)
      .post(URL)
      .send({ messages: [{ role: "user", content: "hi" }], stream: true });

    const tokenEvents = res.text.split("event: token").length - 1;
    expect(tokenEvents).toBe(2);
    // The full string must NOT also be sent as a third chunk.
    expect(res.text).not.toContain('{"text":"您可以搭 132 路"}');
    expect(res.text).toContain("event: done");
  });

  it("agent 沒串流但有文字（例如降級文案）→ 一次性送出", async () => {
    vi.mocked(runChatAgent).mockResolvedValue({
      text: "抱歉，我這次沒能整理出回答。",
      toolResults: [],
    });

    const res = await request(app)
      .post(URL)
      .send({ messages: [{ role: "user", content: "hi" }], stream: true });

    expect(res.text.split("event: token").length - 1).toBe(1);
    expect(res.text).toContain("抱歉");
  });
});
