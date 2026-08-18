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
      execTool: executeLocalTool,
    });
    expect(result).toEqual({ text: "ok", toolResults: [] });
  });
});
