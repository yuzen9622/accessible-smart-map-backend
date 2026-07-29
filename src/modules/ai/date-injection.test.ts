import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";

vi.mock("./ai-chat.service", () => ({
  runChatAgent: vi.fn().mockResolvedValue({ text: "ok" }),
  toGeminiHistory: vi.fn(() => ({ systemInstruction: undefined, contents: [] })),
}));

import { buildTestApp } from "../../../tests/helpers/test-helpers";
import { toGeminiHistory } from "./ai-chat.service";

const app = buildTestApp();

beforeEach(() => {
  vi.clearAllMocks();
});

describe("HTTP chat entry injects the current date (F23)", () => {
  it("passes a system prompt containing the date rule to toGeminiHistory", async () => {
    await request(app)
      .post("/api/v1/ai/chat")
      .send({ messages: [{ role: "user", content: "明天九點的火車" }], stream: false });

    expect(toGeminiHistory).toHaveBeenCalled();
    const messages = vi.mocked(toGeminiHistory).mock.calls[0][0] as Array<{
      role: string;
      content: string;
    }>;
    const system = messages.find((m) => m.role === "system");
    expect(system?.content).toContain("【今天日期】");
  });
});
