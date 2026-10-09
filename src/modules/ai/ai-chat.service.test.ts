import { describe, it, expect, vi, beforeEach } from "vitest";

const { runAgent } = vi.hoisted(() => ({ runAgent: vi.fn() }));
vi.mock("../agent/agent-manager.service", () => ({ runAgent }));
vi.mock("../agent/history-adapter", () => ({ toInteractionInput: vi.fn() }));
vi.mock("./agent-tools", () => ({ executeLocalTool: vi.fn() }));

import { runChatAgent } from "./ai-chat.service";
import { executeLocalTool } from "./agent-tools";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("runChatAgent facade", () => {
  it("uses the current request language after earlier context without leaking across requests", async () => {
    const input = {
      input: [],
      model: "m",
      systemInstruction: "Earlier conversation was in Chinese.",
    };
    for (const language of ["en", "zh-TW", undefined] as const) {
      await runChatAgent({ ...input, language });
    }
    const prompts = runAgent.mock.calls.map(([args]) => args.systemInstruction);
    expect(prompts[0]).toContain("Respond in English");
    expect(prompts[0].indexOf("【目前介面語言偏好：en】")).toBeGreaterThan(
      prompts[0].indexOf("目前查看的路線"),
    );
    expect(prompts[1]).toContain("請使用臺灣繁體中文回覆");
    expect(prompts[1]).not.toContain("Respond in English");
    expect(prompts[2]).not.toContain("目前介面語言偏好");
  });

  it("injects the ai module's executeLocalTool and delegates to the Agent Manager", async () => {
    runAgent.mockResolvedValue({ text: "ok", toolResults: [] });
    const input = {
      contents: [],
      systemInstruction: undefined,
      model: "m",
      userId: "u",
      memoryToolsEnabled: true,
    };

    const result = await runChatAgent(input as never);

    expect(runAgent).toHaveBeenCalledWith({
      ...input,
      execTool: expect.any(Function),
      systemInstruction: expect.stringContaining("目前查看的路線"),
    });
    vi.mocked(executeLocalTool).mockResolvedValue('{"ok":true}');
    await runAgent.mock.calls[0][0].execTool(
      "getEnvironmentInfo",
      {},
      undefined,
      "u",
    );
    expect(executeLocalTool).toHaveBeenCalledWith(
      "getEnvironmentInfo",
      {},
      undefined,
      "u",
      expect.any(Object),
    );
    expect(result).toEqual({ text: "ok", toolResults: [] });
  });
});
