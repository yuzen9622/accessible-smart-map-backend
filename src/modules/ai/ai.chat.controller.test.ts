import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";

vi.mock("./ai-chat.service", () => ({
  runChatAgent: vi.fn(),
  toGeminiHistory: vi.fn(() => ({
    systemInstruction: undefined,
    contents: [],
  })),
}));

import { buildTestApp } from "../../../tests/helpers/test-helpers";
import { googleGenAi } from "../../config/ai";
import { runChatAgent } from "./ai-chat.service";

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
