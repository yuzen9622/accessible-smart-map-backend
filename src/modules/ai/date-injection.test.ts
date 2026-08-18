import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";

vi.mock("./ai-chat.service", () => ({
  runChatAgent: vi.fn().mockResolvedValue({ text: "ok" }),
  toInteractionInput: vi.fn(() => ({
    systemInstruction: undefined,
    input: [],
  })),
}));

import { buildTestApp } from "../../../tests/helpers/test-helpers";
import { toInteractionInput } from "./ai-chat.service";

const app = buildTestApp();

beforeEach(() => {
  vi.clearAllMocks();
});

describe("HTTP chat entry injects the current date (F23)", () => {
  it("passes a system prompt containing the date rule to toInteractionInput", async () => {
    await request(app)
      .post("/api/v1/ai/chat")
      .send({
        messages: [{ role: "user", content: "明天九點的火車" }],
        stream: false,
      });

    expect(toInteractionInput).toHaveBeenCalled();
    const messages = vi.mocked(toInteractionInput).mock.calls[0][0] as Array<{
      role: string;
      content: string;
    }>;
    const system = messages.find((m) => m.role === "system");
    expect(system?.content).toContain("【現在時間】");
    // The wall-clock time must be injected too, not just the date: a user who
    // says "10:20" or "大約五點" cannot be anchored without it.
    expect(system?.content).toMatch(
      /【現在時間】\d{4}-\d{2}-\d{2}（Asia\/Taipei，週.）\d{2}:\d{2}/,
    );
  });
});
