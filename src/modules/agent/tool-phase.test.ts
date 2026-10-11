import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../config/ai", () => ({
  googleGenAi: { interactions: { create: vi.fn() } },
  model: "test-model",
}));
vi.mock("./tool-catalog", () => ({ buildInteractionTools: vi.fn(() => []) }));

import { googleGenAi } from "../../config/ai";
import { buildInteractionTools } from "./tool-catalog";
import { MAX_ROUNDS, runAgent } from "./agent-manager.service";
import type { AgentInput } from "../../types/agent";

const create = vi.mocked(googleGenAi.interactions.create);
const catalogue = vi.mocked(buildInteractionTools);
const execTool = vi.fn<AgentInput["execTool"]>();
const onToolCall = vi.fn();
const onToolResult = vi.fn();
const FINISH = "finishToolPhase";

function calls(id: string, names: string[], prose?: string) {
  return {
    id,
    status: "requires_action",
    steps: [
      ...(prose
        ? [{ type: "model_output", content: [{ type: "text", text: prose }] }]
        : []),
      ...names.map((name, index) => ({
        type: "function_call",
        id: `${id}-${index}`,
        name,
        arguments: {},
      })),
    ],
  };
}
function text(id: string, answer: string) {
  return {
    id,
    status: "completed",
    output_text: answer,
    steps: [
      { type: "model_output", content: [{ type: "text", text: answer }] },
    ],
  };
}
async function* stream(answer: string) {
  yield {
    event_type: "interaction.created",
    interaction: { id: "answer", status: "in_progress" },
  };
  yield { event_type: "step.start", index: 0, step: { type: "model_output" } };
  yield {
    event_type: "step.delta",
    index: 0,
    delta: { type: "text", text: answer },
  };
  yield {
    event_type: "interaction.completed",
    interaction: { id: "answer", status: "completed" },
  };
}
const input: AgentInput["input"] = [
  { type: "user_input", content: [{ type: "text", text: "請查空氣品質" }] },
];
const run = (options: Partial<AgentInput> = {}) =>
  runAgent({
    input,
    model: "test-model",
    systemInstruction: "Original language and safety rules",
    execTool,
    onToolCall,
    onToolResult,
    toolPhaseMode: "explicit",
    ...options,
  });

beforeEach(() => {
  vi.clearAllMocks();
  create.mockReset();
  catalogue
    .mockReset()
    .mockReturnValue([{ type: "function", name: "getAirQuality" }]);
  execTool.mockReset().mockResolvedValue('{"ok":true,"aqi":25}');
});

describe("explicit tool-phase protocol", () => {
  it("forces tools-or-finish decisions and returns every correlated result before one final answer", async () => {
    create
      .mockResolvedValueOnce(
        calls("lookup", ["getAirQuality"], "不公開的工具旁白") as never,
      )
      .mockResolvedValueOnce(calls("finish", [FINISH]) as never)
      .mockResolvedValueOnce(text("answer", "空氣良好") as never);
    const result = await run();
    expect(result.text).toBe("空氣良好");
    expect(result.toolResults).toEqual([
      { name: "getAirQuality", args: {}, result: { ok: true, aqi: 25 } },
    ]);
    expect(onToolCall).toHaveBeenCalledExactlyOnceWith(
      "getAirQuality",
      {},
      "lookup-0",
    );
    expect(onToolResult).toHaveBeenCalledExactlyOnceWith(
      "getAirQuality",
      { ok: true, aqi: 25 },
      "lookup-0",
    );
    expect(execTool).toHaveBeenCalledTimes(1);
    for (const [params] of create.mock.calls.slice(0, 2)) {
      expect(params).toMatchObject({
        generation_config: { tool_choice: "any" },
      });
      expect(params.tools).toEqual(
        expect.arrayContaining([expect.objectContaining({ name: FINISH })]),
      );
      expect(params.system_instruction).toContain(
        "Original language and safety rules",
      );
      expect(params.system_instruction).toContain(FINISH);
      expect(params.stream).toBeUndefined();
    }
    expect(create.mock.calls[1][0]).toMatchObject({
      previous_interaction_id: "lookup",
      input: [
        {
          type: "function_result",
          call_id: "lookup-0",
          name: "getAirQuality",
          result: { ok: true, aqi: 25 },
          is_error: false,
        },
      ],
    });
    expect(create.mock.calls[2][0]).toMatchObject({
      previous_interaction_id: "finish",
      generation_config: { tool_choice: "none" },
      input: [
        {
          type: "function_result",
          call_id: "finish-0",
          name: FINISH,
          result: { ready: true },
          is_error: false,
        },
      ],
    });
    expect(create.mock.calls[2][0].system_instruction).toBe(
      "Original language and safety rules",
    );
    expect(create.mock.calls[2][0]).not.toHaveProperty("tools");
    expect(create).toHaveBeenCalledTimes(3);
  });

  it("greeting/no lookup finishes privately then streams the answer without any executor or UI tool event", async () => {
    create
      .mockResolvedValueOnce(calls("finish", [FINISH]) as never)
      .mockResolvedValueOnce(stream("你好") as never);
    const onTextDelta = vi.fn();
    const result = await run({ onTextDelta });
    expect(result.text).toBe("你好");
    expect(onTextDelta).toHaveBeenCalledExactlyOnceWith("你好");
    expect(execTool).not.toHaveBeenCalled();
    expect(onToolCall).not.toHaveBeenCalled();
    expect(onToolResult).not.toHaveBeenCalled();
    expect(result.toolResults).toEqual([]);
    expect(create).toHaveBeenCalledTimes(2);
  });

  it("does not interpret a prose-only decision as successful tool-phase completion", async () => {
    create.mockResolvedValueOnce(text("wrong", "還未完成查詢的文字") as never);
    const onTextDelta = vi.fn();
    await expect(run({ onTextDelta })).rejects.toThrow(/decision|tool phase/i);
    expect(create).toHaveBeenCalledTimes(1);
    expect(onTextDelta).not.toHaveBeenCalled();
    expect(execTool).not.toHaveBeenCalled();
  });

  it.each([[[FINISH, "getAirQuality"]], [["getAirQuality", FINISH]]])(
    "does not finish early when control and real tools share a round: %j",
    async (names) => {
      create
        .mockResolvedValueOnce(calls("mixed", names) as never)
        .mockResolvedValueOnce(calls("finish", [FINISH]) as never)
        .mockResolvedValueOnce(text("answer", "已查詢") as never);
      await run();
      expect(create.mock.calls[1][0]).toMatchObject({
        generation_config: { tool_choice: "any" },
      });
      expect(create.mock.calls[1][0].input).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            name: FINISH,
            result: expect.objectContaining({ ready: false }),
            is_error: true,
          }),
          expect.objectContaining({
            name: "getAirQuality",
            result: { ok: true, aqi: 25 },
          }),
        ]),
      );
      expect(onToolCall).toHaveBeenCalledTimes(1);
      expect(onToolResult).toHaveBeenCalledTimes(1);
      expect(execTool).toHaveBeenCalledTimes(1);
    },
  );

  it("continues deciding after an actual tool failure; finishing never claims that tool succeeded", async () => {
    execTool.mockResolvedValueOnce('{"ok":false,"error":"unavailable"}');
    create
      .mockResolvedValueOnce(calls("lookup", ["getAirQuality"]) as never)
      .mockResolvedValueOnce(calls("finish", [FINISH]) as never)
      .mockResolvedValueOnce(text("answer", "暫時無法查詢") as never);
    await run();
    expect(create.mock.calls[1][0].input).toEqual([
      expect.objectContaining({
        is_error: true,
        result: { ok: false, error: "unavailable" },
      }),
    ]);
    expect(onToolResult).toHaveBeenCalledWith(
      "getAirQuality",
      { ok: false, error: "unavailable" },
      "lookup-0",
    );
    expect(create.mock.calls[2][0].input).toEqual([
      expect.objectContaining({ result: { ready: true } }),
    ]);
  });

  it("with no available business tools skips the decision phase and answers the original input", async () => {
    catalogue.mockReturnValueOnce([]);
    create.mockResolvedValueOnce(stream("直接回答") as never);
    expect((await run({ toolAllowList: [], onTextDelta: () => {} })).text).toBe(
      "直接回答",
    );
    expect(create).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        input,
        generation_config: { tool_choice: "none", thinking_level: "high" },
        stream: true,
      }),
    );
    expect(execTool).not.toHaveBeenCalled();
  });

  it("does not register its private control in the shared business catalogue", async () => {
    const business = [{ type: "function" as const, name: "getAirQuality" }];
    catalogue.mockReturnValueOnce(business);
    create
      .mockResolvedValueOnce(calls("finish", [FINISH]) as never)
      .mockResolvedValueOnce(text("answer", "ok") as never);
    await run();
    expect(business).toEqual([{ type: "function", name: "getAirQuality" }]);
  });

  it("rejects a reserved control name collision before any upstream call or side effect", async () => {
    catalogue.mockReturnValueOnce([{ type: "function", name: FINISH }]);
    await expect(run()).rejects.toThrow(/reserved|collision/i);
    expect(create).not.toHaveBeenCalled();
    expect(execTool).not.toHaveBeenCalled();
  });

  it("preserves forced first-tool selection and does not permit finish to bypass it", async () => {
    create.mockResolvedValueOnce(calls("wrong", [FINISH]) as never);
    await expect(
      run({ allowedFunctionNames: ["getAirQuality"] }),
    ).rejects.toThrow(/forced/i);
    expect(create.mock.calls[0][0]).toMatchObject({
      generation_config: {
        tool_choice: {
          allowed_tools: { mode: "any", tools: ["getAirQuality"] },
        },
      },
    });
    expect(execTool).not.toHaveBeenCalled();
    expect(onToolCall).not.toHaveBeenCalled();
  });

  it("executes the forced first tool, then allows a private finish in the next round", async () => {
    create
      .mockResolvedValueOnce(calls("forced", ["getAirQuality"]) as never)
      .mockResolvedValueOnce(calls("finish", [FINISH]) as never)
      .mockResolvedValueOnce(text("answer", "ok") as never);
    await run({ allowedFunctionNames: ["getAirQuality"] });
    expect(execTool).toHaveBeenCalledTimes(1);
    expect(create.mock.calls[0][0]).toMatchObject({
      generation_config: {
        tool_choice: {
          allowed_tools: { mode: "any", tools: ["getAirQuality"] },
        },
      },
    });
    expect(create.mock.calls[1][0]).toMatchObject({
      generation_config: { tool_choice: "any" },
    });
  });

  it("cannot force undeclared/unauthorized tool names", async () => {
    await expect(
      run({
        allowedFunctionNames: ["saveMemory"],
        toolAllowList: ["getAirQuality"],
      }),
    ).rejects.toThrow(/forced/i);
    expect(create).not.toHaveBeenCalled();
    expect(execTool).not.toHaveBeenCalled();
  });

  it("never executes a provider-requested undeclared tool", async () => {
    create
      .mockResolvedValueOnce(calls("blocked", ["saveMemory"]) as never)
      .mockResolvedValueOnce(calls("finish", [FINISH]) as never)
      .mockResolvedValueOnce(text("answer", "無法使用此工具") as never);
    await run();
    expect(execTool).not.toHaveBeenCalled();
    expect(onToolResult).toHaveBeenCalledWith(
      "saveMemory",
      { error: "tool_not_allowed" },
      "blocked-0",
    );
  });

  it("keeps the execution allow-list authoritative even if the catalogue accidentally declares a denied tool", async () => {
    create
      .mockResolvedValueOnce(calls("denied", ["getAirQuality"]) as never)
      .mockResolvedValueOnce(calls("finish", [FINISH]) as never)
      .mockResolvedValueOnce(text("answer", "無權查詢") as never);
    await run({ toolAllowList: [] });
    expect(execTool).not.toHaveBeenCalled();
    expect(onToolResult).toHaveBeenCalledWith(
      "getAirQuality",
      { error: "tool_not_allowed" },
      "denied-0",
    );
  });

  it("requires empty control arguments; it cannot smuggle an answer or side effect", async () => {
    const invalid = calls("finish", [FINISH]);
    invalid.steps[0] = {
      type: "function_call",
      id: "finish-0",
      name: FINISH,
      arguments: { text: "不得公開" },
    } as never;
    create.mockResolvedValueOnce(invalid as never);
    await expect(run()).rejects.toThrow(/finish|control/i);
    expect(onToolCall).not.toHaveBeenCalled();
    expect(onToolResult).not.toHaveBeenCalled();
    expect(execTool).not.toHaveBeenCalled();
    expect(create).toHaveBeenCalledTimes(1);
  });

  it.each(["failed", "incomplete", "in_progress"])(
    "does not execute tool calls from a decision with status %s",
    async (status) => {
      create.mockResolvedValueOnce({
        ...calls("bad", ["getAirQuality"]),
        status,
      } as never);
      await expect(run()).rejects.toThrow(/decision|tool phase/i);
      expect(execTool).not.toHaveBeenCalled();
    },
  );

  it("rejects duplicate call IDs before executing any tool", async () => {
    const duplicate = calls("bad", ["getAirQuality", "getAirQuality"]);
    duplicate.steps[1] = { ...duplicate.steps[1], id: "bad-0" } as never;
    create.mockResolvedValueOnce(duplicate as never);
    await expect(run()).rejects.toThrow(/call/i);
    expect(execTool).not.toHaveBeenCalled();
  });

  it("rejects missing call IDs before publishing a tool event or executing a side effect", async () => {
    const invalid = calls("missing", ["getAirQuality"]);
    invalid.steps[0] = { ...invalid.steps[0], id: "" } as never;
    create.mockResolvedValueOnce(invalid as never);
    await expect(run()).rejects.toThrow(/call/i);
    expect(execTool).not.toHaveBeenCalled();
    expect(onToolCall).not.toHaveBeenCalled();
  });

  it("drops a late decision after cancellation without executing tools or synthesizing an answer", async () => {
    let release!: (decision: never) => void;
    create.mockImplementationOnce(
      () =>
        new Promise<never>((resolve) => {
          release = resolve;
        }),
    );
    const cancellation = new AbortController();
    const request = run({ signal: cancellation.signal });
    cancellation.abort();
    release(calls("late", ["getAirQuality"]) as never);
    await expect(request).rejects.toThrow();
    expect(create).toHaveBeenCalledTimes(1);
    expect(execTool).not.toHaveBeenCalled();
    expect(onToolCall).not.toHaveBeenCalled();
  });

  it("bounds tool rounds and explicitly labels budget exhaustion instead of inventing successful completion", async () => {
    for (let i = 0; i < MAX_ROUNDS; i++)
      create.mockResolvedValueOnce(
        calls(`round-${i}`, ["getAirQuality"]) as never,
      );
    create.mockResolvedValueOnce(text("answer", "目前只能查到這些") as never);
    await run();
    expect(create).toHaveBeenCalledTimes(MAX_ROUNDS + 1);
    expect(create.mock.calls[MAX_ROUNDS][0]).toMatchObject({
      generation_config: { tool_choice: "none" },
    });
    expect(JSON.stringify(create.mock.calls[MAX_ROUNDS][0].input)).toMatch(
      /上限|limit|budget/i,
    );
    expect(execTool).toHaveBeenCalledTimes(1);
  });
});
