import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../config/ai", () => ({
  googleGenAi: {
    interactions: { create: vi.fn() },
  },
  model: "test-model",
}));
vi.mock("../../config/ai/tool", () => ({
  openAiChatTools: [],
  memoryTools: [],
  findA11yPlacesDeclaration: {},
  findGooglePlacesDeclaration: {},
  planRouteDeclaration: {},
}));
vi.mock("../ai/agent-tools", () => ({
  executeLocalTool: vi.fn(),
}));
vi.mock("./tool-catalog", () => ({
  buildInteractionTools: vi.fn(() => []),
}));

import { googleGenAi } from "../../config/ai";
import { executeLocalTool } from "../ai/agent-tools";
import {
  runToolLoop,
  runAgent,
  routeOnce,
  MAX_ROUNDS,
  EMPTY_ANSWER_FALLBACK,
  AgentRateLimitError,
} from "./agent-manager.service";
import { buildInteractionTools } from "./tool-catalog";
import type { InteractionInputStep } from "../../types/agent";

const mockCreate = googleGenAi.interactions.create as unknown as ReturnType<
  typeof vi.fn
>;
const mockExec = executeLocalTool as unknown as ReturnType<typeof vi.fn>;
const mockTools = buildInteractionTools as unknown as ReturnType<typeof vi.fn>;

// The executor is an injected dependency (execTool is required), so tests pass
// the mocked executeLocalTool explicitly through this thin wrapper.
const run = (input: InteractionInputStep[]) =>
  runToolLoop(
    input,
    undefined,
    "test-model",
    undefined,
    undefined,
    undefined,
    undefined,
    false,
    false,
    false,
    executeLocalTool,
  );

const userInput = (text: string): InteractionInputStep[] => [
  { type: "user_input", content: [{ type: "text", text }] },
];

beforeEach(() => {
  vi.clearAllMocks();
  callSeq = 0;
});

let callSeq = 0;

/** An interaction whose steps request the given function calls. */
function functionCallResponse(
  calls: Array<{ name: string; args: Record<string, unknown> }>,
) {
  callSeq += 1;
  return {
    id: `int-${callSeq}`,
    status: "completed",
    steps: calls.map((c, i) => ({
      type: "function_call",
      id: `call-${callSeq}-${i}`,
      name: c.name,
      arguments: c.args,
    })),
  };
}

/** An interaction that answers with text and calls no tools. */
function textResponse(text: string) {
  callSeq += 1;
  return {
    id: `int-${callSeq}`,
    status: "completed",
    output_text: text,
    steps: [{ type: "model_output", content: [{ type: "text", text }] }],
  };
}

function stopResponse() {
  return textResponse("done");
}

/** An interaction with neither tool calls nor text. */
function emptyStopResponse() {
  callSeq += 1;
  return {
    id: `int-${callSeq}`,
    status: "completed",
    output_text: "",
    steps: [{ type: "model_output", content: [] }],
  };
}

/** The `input` array the loop sent on the Nth (0-based) interaction. */
function sentInput(n: number): any[] {
  return (mockCreate.mock.calls[n][0] as any).input;
}

function sentFunctionResults(n: number): any[] {
  return sentInput(n).filter((s: any) => s.type === "function_result");
}

describe("runToolLoop dedup", () => {
  it("沒有工具呼叫但模型有文字時回傳文字（T3：不多打 final）", async () => {
    mockCreate.mockResolvedValueOnce(stopResponse());

    const result = await run(userInput("hello"));

    expect(result.text).toBe("done");
    expect(mockExec).not.toHaveBeenCalled();
    expect(mockCreate).toHaveBeenCalledTimes(1);
  });

  it("相同 (name, args) 且成功 → 第二次不執行 executeLocalTool", async () => {
    const args = { routeName: "307", city: "台北" };
    mockCreate
      .mockResolvedValueOnce(
        functionCallResponse([{ name: "trackBuses", args }]),
      )
      .mockResolvedValueOnce(
        functionCallResponse([{ name: "trackBuses", args }]),
      )
      .mockResolvedValueOnce(stopResponse());

    mockExec.mockResolvedValue(JSON.stringify({ ok: true, buses: [] }));

    await run(userInput("test"));

    expect(mockExec).toHaveBeenCalledTimes(1);
    // Both rounds still report a result back to the model, and the cached
    // second one is identical to the first.
    const first = sentFunctionResults(1);
    const second = sentFunctionResults(2);
    expect(first).toHaveLength(1);
    expect(second).toHaveLength(1);
    expect(first[0].result).toEqual(second[0].result);
  });

  it("相同 (name, args) 但失敗 → 第二次重新執行（暫時性錯誤留一次機會）", async () => {
    const args = { query: "火星" };
    mockCreate
      .mockResolvedValueOnce(
        functionCallResponse([{ name: "findA11yPlaces", args }]),
      )
      .mockResolvedValueOnce(
        functionCallResponse([{ name: "findA11yPlaces", args }]),
      )
      .mockResolvedValueOnce(stopResponse());

    mockExec
      .mockResolvedValueOnce(JSON.stringify({ ok: false, error: "找不到" }))
      .mockResolvedValueOnce(JSON.stringify({ ok: true, places: [] }));

    await run(userInput("test"));

    expect(mockExec).toHaveBeenCalledTimes(2);
  });

  it("失敗的工具結果標記 is_error 回報給模型", async () => {
    mockCreate
      .mockResolvedValueOnce(
        functionCallResponse([{ name: "findA11yPlaces", args: { q: "x" } }]),
      )
      .mockResolvedValueOnce(stopResponse());
    mockExec.mockResolvedValue(JSON.stringify({ ok: false, error: "找不到" }));

    await run(userInput("test"));

    expect(sentFunctionResults(1)[0].is_error).toBe(true);
  });

  it("不同 args → 各自執行", async () => {
    mockCreate
      .mockResolvedValueOnce(
        functionCallResponse([
          {
            name: "getBusArrival",
            args: { routeName: "307", stopName: "台北車站" },
          },
          {
            name: "getBusArrival",
            args: { routeName: "307", stopName: "忠孝復興" },
          },
        ]),
      )
      .mockResolvedValueOnce(stopResponse());

    mockExec.mockResolvedValue(JSON.stringify({ ok: true, arrival: "3min" }));

    await run(userInput("test"));

    expect(mockExec).toHaveBeenCalledTimes(2);
    expect(sentFunctionResults(1)).toHaveLength(2);
  });

  it("returns parsed tool results for downstream UI mappers", async () => {
    mockCreate
      .mockResolvedValueOnce(
        functionCallResponse([
          { name: "planRouteToSosVictim", args: { sessionId: "s1" } },
        ]),
      )
      .mockResolvedValueOnce(stopResponse());

    mockExec.mockResolvedValue(
      JSON.stringify({
        ok: true,
        sessionId: "s1",
        routes: [{ routeName: "route1", totalMinutes: 12 }],
      }),
    );

    const result = await run(userInput("test"));

    expect(result.toolResults).toEqual([
      {
        name: "planRouteToSosVictim",
        args: { sessionId: "s1" },
        result: {
          ok: true,
          sessionId: "s1",
          routes: [{ routeName: "route1", totalMinutes: 12 }],
        },
      },
    ]);
  });

  it("args 順序不同但值相同 → 命中 cache", async () => {
    mockCreate
      .mockResolvedValueOnce(
        functionCallResponse([
          { name: "trackBuses", args: { routeName: "307", city: "台北" } },
        ]),
      )
      .mockResolvedValueOnce(
        functionCallResponse([
          { name: "trackBuses", args: { city: "台北", routeName: "307" } },
        ]),
      )
      .mockResolvedValueOnce(stopResponse());

    mockExec.mockResolvedValue(JSON.stringify({ ok: true, buses: [] }));

    await run(userInput("test"));

    expect(mockExec).toHaveBeenCalledTimes(1);
  });

  it("含 error 欄位的結果不被快取", async () => {
    const args = { latitude: 0, longitude: 0 };
    mockCreate
      .mockResolvedValueOnce(
        functionCallResponse([{ name: "getAirQuality", args }]),
      )
      .mockResolvedValueOnce(
        functionCallResponse([{ name: "getAirQuality", args }]),
      )
      .mockResolvedValueOnce(stopResponse());

    mockExec
      .mockResolvedValueOnce(JSON.stringify({ error: "查詢失敗" }))
      .mockResolvedValueOnce(JSON.stringify({ ok: true, pm25: 12 }));

    await run(userInput("test"));

    expect(mockExec).toHaveBeenCalledTimes(2);
  });
});

describe("runToolLoop 是 stateful 的（M1-2）", () => {
  it("首輪送完整歷史；後續只送 function_result + previous_interaction_id", async () => {
    mockCreate
      .mockResolvedValueOnce(
        functionCallResponse([{ name: "getAirQuality", args: { a: 1 } }]),
      )
      .mockResolvedValueOnce(stopResponse());
    mockExec.mockResolvedValue(JSON.stringify({ ok: true, pm25: 10 }));

    await run(userInput("空氣好嗎"));

    // Round 0 carries the conversation and no previous id.
    const round0 = mockCreate.mock.calls[0][0] as any;
    expect(round0.previous_interaction_id).toBeUndefined();
    expect(round0.input[0]).toMatchObject({ type: "user_input" });

    // Round 1 chains onto round 0 and sends ONLY the tool result — the growing
    // history is not resent.
    const round1 = mockCreate.mock.calls[1][0] as any;
    expect(round1.previous_interaction_id).toBe("int-1");
    expect(round1.input).toHaveLength(1);
    expect(round1.input[0]).toMatchObject({
      type: "function_result",
      call_id: "call-1-0",
      name: "getAirQuality",
    });
    expect(round1.input.some((s: any) => s.type === "user_input")).toBe(false);
  });

  it("每一輪都重送 interaction-scoped 的 tools / system_instruction / generation_config", async () => {
    mockCreate
      .mockResolvedValueOnce(
        functionCallResponse([{ name: "getAirQuality", args: {} }]),
      )
      .mockResolvedValueOnce(stopResponse());
    mockExec.mockResolvedValue(JSON.stringify({ ok: true }));

    await runToolLoop(
      userInput("x"),
      "SYS",
      "test-model",
      undefined,
      undefined,
      undefined,
      undefined,
      false,
      false,
      false,
      executeLocalTool,
    );

    for (const call of mockCreate.mock.calls) {
      const params = call[0] as any;
      expect(params.system_instruction).toBe("SYS");
      expect(params.tools).toBeDefined();
      expect(params.generation_config).toBeDefined();
    }
  });
});

describe("runToolLoop 最終文字保證（修沒文字 bug）", () => {
  it("T1：跑滿 MAX_ROUNDS 仍在呼叫工具 → 用 tool_choice none 強制回文字", async () => {
    for (let i = 0; i < MAX_ROUNDS; i++) {
      mockCreate.mockResolvedValueOnce(
        functionCallResponse([{ name: "getBusArrival", args: { round: i } }]),
      );
    }
    mockCreate.mockResolvedValueOnce(textResponse("最終答案"));
    mockExec.mockResolvedValue(JSON.stringify({ ok: true, etaMinutes: 4 }));

    const result = await run(userInput("x"));

    expect(mockCreate).toHaveBeenCalledTimes(MAX_ROUNDS + 1);
    const finalParams = mockCreate.mock.calls[MAX_ROUNDS][0] as any;
    expect(finalParams.generation_config.tool_choice).toBe("none");
    expect(finalParams.generation_config.thinking_level).toBe("high");
    // The final round still delivers the last round's unsent tool results.
    expect(
      finalParams.input.filter((s: any) => s.type === "function_result"),
    ).toHaveLength(1);
    expect(result.text).toBe("最終答案");
  });

  it("T2：無工具呼叫但文字為空 → 觸發一次 final 生成回非空文字", async () => {
    mockCreate
      .mockResolvedValueOnce(emptyStopResponse())
      .mockResolvedValueOnce(textResponse("補救答案"));

    const result = await run(userInput("x"));

    expect(mockCreate).toHaveBeenCalledTimes(2);
    const finalParams = mockCreate.mock.calls[1][0] as any;
    expect(finalParams.generation_config.tool_choice).toBe("none");
    // Nothing was pending, so the loop nudges with a user turn rather than
    // sending an empty input (which the API would reject).
    expect(finalParams.input).toHaveLength(1);
    expect(finalParams.input[0].type).toBe("user_input");
    expect(result.text).toBe("補救答案");
  });

  it("output_text 缺失時退回讀 model_output 的文字", async () => {
    callSeq += 1;
    mockCreate.mockResolvedValueOnce({
      id: "int-x",
      status: "completed",
      steps: [
        { type: "thought", signature: "sig" },
        { type: "model_output", content: [{ type: "text", text: "備援文字" }] },
      ],
    });

    const result = await run(userInput("x"));

    expect(result.text).toBe("備援文字");
    expect(mockCreate).toHaveBeenCalledTimes(1);
  });

  it("T6：複合公車鏈 planAccessibleRoute→getBusArrival 串接並回公車導向文字", async () => {
    mockCreate
      .mockResolvedValueOnce(
        functionCallResponse([
          {
            name: "planAccessibleRoute",
            args: { origin: "中科大", destination: "火車站" },
          },
        ]),
      )
      .mockResolvedValueOnce(
        functionCallResponse([
          {
            name: "getBusArrival",
            args: { routeName: "159", stopName: "中科大" },
          },
        ]),
      )
      .mockResolvedValueOnce(
        textResponse("您可以搭 159 路，約 4 分鐘後到，是最快的一班。"),
      );

    mockExec.mockImplementation(async (name: string) =>
      name === "planAccessibleRoute"
        ? JSON.stringify({ ok: true, routes: [{ routeName: "159" }] })
        : JSON.stringify({ ok: true, routeName: "159", etaMinutes: 4 }),
    );

    const result = await run(
      userInput("從中科大要去火車站可以搭哪些公車、哪班最快來"),
    );

    const execNames = mockExec.mock.calls.map((c) => c[0]);
    expect(execNames).toEqual(["planAccessibleRoute", "getBusArrival"]);
    expect(result.text).toContain("159");
    expect((result.text ?? "").length).toBeGreaterThan(0);
  });
});

describe("runAgent façade", () => {
  it("maps the named input to the loop and returns an AgentResult", async () => {
    mockCreate.mockResolvedValueOnce(stopResponse());

    const result = await runAgent({
      input: userInput("hi"),
      systemInstruction: undefined,
      model: "test-model",
      execTool: executeLocalTool,
    });

    expect(result.text).toBe("done");
    expect(result.toolResults).toEqual([]);
    expect(mockExec).not.toHaveBeenCalled();
  });

  it("routes tool execution through the injected executor", async () => {
    mockCreate
      .mockResolvedValueOnce(
        functionCallResponse([{ name: "getAirQuality", args: {} }]),
      )
      .mockResolvedValueOnce(stopResponse());
    mockExec.mockResolvedValue(JSON.stringify({ ok: true, pm25: 10 }));

    await runAgent({
      input: userInput("air?"),
      systemInstruction: undefined,
      model: "test-model",
      execTool: executeLocalTool,
    });

    expect(mockExec).toHaveBeenCalledTimes(1);
    expect(mockExec.mock.calls[0][0]).toBe("getAirQuality");
  });

  it("轉傳 toolAllowList / allowedFunctionNames / seedParts（修 runAgent 漏傳）", async () => {
    mockCreate.mockResolvedValueOnce(stopResponse());

    await runAgent({
      input: userInput("hi"),
      systemInstruction: undefined,
      model: "test-model",
      execTool: executeLocalTool,
      allowedFunctionNames: ["getAirQuality"],
      seedParts: ["額外情境"],
      toolAllowList: ["getAirQuality"],
    });

    const params = mockCreate.mock.calls[0][0] as any;
    expect(params.generation_config.tool_choice).toEqual({
      allowed_tools: { mode: "any", tools: ["getAirQuality"] },
    });
    expect(params.input.at(-1)).toMatchObject({
      type: "user_input",
      content: [{ type: "text", text: "額外情境" }],
    });
  });

  it("toolAllowList 攔下未授權工具且不執行它", async () => {
    mockCreate
      .mockResolvedValueOnce(
        functionCallResponse([{ name: "deleteMemory", args: {} }]),
      )
      .mockResolvedValueOnce(stopResponse());

    await runAgent({
      input: userInput("hi"),
      systemInstruction: undefined,
      model: "test-model",
      execTool: executeLocalTool,
      toolAllowList: ["getAirQuality"],
    });

    expect(mockExec).not.toHaveBeenCalled();
    expect(sentFunctionResults(1)[0]).toMatchObject({
      is_error: true,
      result: { error: "tool_not_allowed" },
    });
  });
});

describe("最終回答永不為空（M2-1，原本沒被測到的洞）", () => {
  it("final 輪也回空 → 重試一次，取得文字就用它", async () => {
    mockCreate
      .mockResolvedValueOnce(emptyStopResponse()) // round 0: no calls, no text
      .mockResolvedValueOnce(emptyStopResponse()) // forced final: still empty
      .mockResolvedValueOnce(textResponse("重試後的答案"));

    const result = await run(userInput("x"));

    expect(mockCreate).toHaveBeenCalledTimes(3);
    // The retry deliberately drops the interaction chain: a poisoned context is
    // the likeliest cause of the silence.
    const retryParams = mockCreate.mock.calls[2][0] as any;
    expect(retryParams.previous_interaction_id).toBeUndefined();
    expect(retryParams.generation_config.tool_choice).toBe("none");
    expect(result.text).toBe("重試後的答案");
  });

  it("final 與重試都回空 → 回降級文案，絕不回空字串", async () => {
    mockCreate
      .mockResolvedValueOnce(emptyStopResponse())
      .mockResolvedValueOnce(emptyStopResponse())
      .mockResolvedValueOnce(emptyStopResponse());

    const result = await run(userInput("x"));

    expect(result.text).toBe(EMPTY_ANSWER_FALLBACK);
    expect(result.text).not.toBe("");
  });

  it("重試會帶上已取得的工具結果，不讓查到的資料白費", async () => {
    mockCreate
      .mockResolvedValueOnce(
        functionCallResponse([{ name: "getAirQuality", args: {} }]),
      )
      .mockResolvedValueOnce(emptyStopResponse()) // round 1: silent
      .mockResolvedValueOnce(emptyStopResponse()) // forced final: silent
      .mockResolvedValueOnce(textResponse("PM2.5 是 12"));
    mockExec.mockResolvedValue(JSON.stringify({ ok: true, pm25: 12 }));

    const result = await run(userInput("空氣如何"));

    const retryText = (mockCreate.mock.calls[3][0] as any).input[0].content[0]
      .text;
    expect(retryText).toContain("pm25");
    expect(result.text).toBe("PM2.5 是 12");
  });
});

describe("暫時性錯誤處理（M2-4）", () => {
  it("429 → 退避重試，成功就正常回答", async () => {
    const err: any = new Error("Resource exhausted");
    err.status = 429;
    mockCreate
      .mockRejectedValueOnce(err)
      .mockResolvedValueOnce(textResponse("恢復了"));

    const result = await run(userInput("x"));

    expect(mockCreate).toHaveBeenCalledTimes(2);
    expect(result.text).toBe("恢復了");
  });

  it("429 重試耗盡 → 丟 AgentRateLimitError（讓 HTTP 層回 429 而非 500）", async () => {
    const err: any = new Error("Resource exhausted");
    err.status = 429;
    mockCreate.mockRejectedValue(err);

    await expect(run(userInput("x"))).rejects.toBeInstanceOf(
      AgentRateLimitError,
    );
    expect(mockCreate).toHaveBeenCalledTimes(3);
  });

  it("非暫時性錯誤不重試，直接往上拋", async () => {
    const err: any = new Error("bad request");
    err.status = 400;
    mockCreate.mockRejectedValue(err);

    await expect(run(userInput("x"))).rejects.toThrow("bad request");
    expect(mockCreate).toHaveBeenCalledTimes(1);
  });

  it("timeout 類訊息視為暫時性並重試", async () => {
    mockCreate
      .mockRejectedValueOnce(new Error("socket hang up"))
      .mockResolvedValueOnce(textResponse("ok"));

    const result = await run(userInput("x"));

    expect(mockCreate).toHaveBeenCalledTimes(2);
    expect(result.text).toBe("ok");
  });
});

describe("重複失敗不燒光回合預算（M3-4）", () => {
  it("同一個失敗呼叫重試一次後改吃快取，不再執行", async () => {
    // Four rounds all asking for the same failing call.
    for (let i = 0; i < 4; i++) {
      mockCreate.mockResolvedValueOnce(
        functionCallResponse([{ name: "findA11yPlaces", args: { q: "火星" } }]),
      );
    }
    mockCreate.mockResolvedValueOnce(textResponse("查不到"));
    mockExec.mockResolvedValue(JSON.stringify({ ok: false, error: "找不到" }));

    await run(userInput("x"));

    // Executed twice (first attempt + one retry), then served from cache.
    expect(mockExec).toHaveBeenCalledTimes(2);
  });

  it("失敗後成功 → 清掉失敗計數，成功結果照常快取", async () => {
    mockCreate
      .mockResolvedValueOnce(
        functionCallResponse([{ name: "getAirQuality", args: {} }]),
      )
      .mockResolvedValueOnce(
        functionCallResponse([{ name: "getAirQuality", args: {} }]),
      )
      .mockResolvedValueOnce(
        functionCallResponse([{ name: "getAirQuality", args: {} }]),
      )
      .mockResolvedValueOnce(textResponse("好"));
    mockExec
      .mockResolvedValueOnce(JSON.stringify({ ok: false, error: "暫時失敗" }))
      .mockResolvedValueOnce(JSON.stringify({ ok: true, pm25: 10 }));

    await run(userInput("x"));

    // 1 failure + 1 success; the third round hits the success cache.
    expect(mockExec).toHaveBeenCalledTimes(2);
  });
});

describe("routeOnce 工具目錄（回歸：eval 只傳 userId 時記憶工具必須在目錄裡）", () => {
  it("有 userId 但未指定 memoryEnabled → memoryEnabled 仍為 true", async () => {
    mockCreate.mockResolvedValueOnce(textResponse("hi"));

    await routeOnce("記住我坐輪椅", "SYS", { userId: "eval-user" });

    // buildInteractionTools(userId, memoryEnabled) — the second argument is the
    // one this regression broke (it was hard-coded to false, which silently
    // removed saveMemory/deleteMemory from the catalogue).
    expect(mockTools).toHaveBeenCalledWith("eval-user", true);
  });

  it("沒有 userId → memoryEnabled 為 false", async () => {
    mockCreate.mockResolvedValueOnce(textResponse("hi"));

    await routeOnce("你好", "SYS", {});

    expect(mockTools).toHaveBeenCalledWith(undefined, false);
  });

  it("明確指定 memoryEnabled: false 時尊重呼叫端", async () => {
    mockCreate.mockResolvedValueOnce(textResponse("hi"));

    await routeOnce("hi", "SYS", { userId: "u1", memoryEnabled: false });

    expect(mockTools).toHaveBeenCalledWith("u1", false);
  });
});

/** An async iterable of streaming SSE events. */
async function* eventStream(events: any[]) {
  for (const e of events) yield e;
}

function streamedTextEvents(id: string, chunks: string[]) {
  return [
    {
      event_type: "interaction.created",
      interaction: { id, status: "in_progress" },
    },
    { event_type: "step.start", index: 0, step: { type: "model_output" } },
    ...chunks.map((t) => ({
      event_type: "step.delta",
      index: 0,
      delta: { type: "text", text: t },
    })),
    { event_type: "step.stop", index: 0 },
    {
      event_type: "interaction.completed",
      interaction: { id, status: "completed", usage: { total_tokens: 9 } },
    },
  ];
}

function streamedCallEvents(
  id: string,
  call: { id: string; name: string; argChunks: string[] },
) {
  return [
    {
      event_type: "interaction.created",
      interaction: { id, status: "in_progress" },
    },
    {
      event_type: "step.start",
      index: 0,
      step: { type: "function_call", id: call.id, name: call.name },
    },
    ...call.argChunks.map((a) => ({
      event_type: "step.delta",
      index: 0,
      delta: { type: "arguments_delta", arguments: a },
    })),
    { event_type: "step.stop", index: 0 },
    {
      event_type: "interaction.completed",
      interaction: { id, status: "requires_action" },
    },
  ];
}

describe("streaming（M1-6：最終答案逐字送）", () => {
  it("提供 onTextDelta 時改用 stream:true，並逐塊回呼", async () => {
    mockCreate.mockResolvedValueOnce(
      eventStream(streamedTextEvents("int-s1", ["您可以搭", "132 路", "。"])),
    );
    const chunks: string[] = [];

    const result = await runToolLoop(
      userInput("x"),
      undefined,
      "test-model",
      undefined,
      undefined,
      undefined,
      undefined,
      false,
      false,
      false,
      executeLocalTool,
      { onTextDelta: (t) => chunks.push(t) },
    );

    expect((mockCreate.mock.calls[0][0] as any).stream).toBe(true);
    expect(chunks).toEqual(["您可以搭", "132 路", "。"]);
    // The reassembled text must equal the concatenation the client received.
    expect(result.text).toBe("您可以搭132 路。");
  });

  it("streaming 下把 arguments_delta 拼回完整的工具參數", async () => {
    mockCreate
      .mockResolvedValueOnce(
        eventStream(
          streamedCallEvents("int-s2", {
            id: "call-x",
            name: "getBusArrival",
            argChunks: ['{"routeName":', '"132","stopName"', ':"臺中車站"}'],
          }),
        ),
      )
      .mockResolvedValueOnce(eventStream(streamedTextEvents("int-s3", ["好"])));
    mockExec.mockResolvedValue(JSON.stringify({ ok: true, etaMinutes: 3 }));

    const result = await runToolLoop(
      userInput("x"),
      undefined,
      "test-model",
      undefined,
      undefined,
      undefined,
      undefined,
      false,
      false,
      false,
      executeLocalTool,
      { onTextDelta: () => {} },
    );

    expect(mockExec).toHaveBeenCalledWith(
      "getBusArrival",
      { routeName: "132", stopName: "臺中車站" },
      undefined,
      undefined,
      expect.anything(),
    );
    expect(result.text).toBe("好");
  });

  it("沒有 onTextDelta 時維持非串流呼叫", async () => {
    mockCreate.mockResolvedValueOnce(stopResponse());

    await run(userInput("x"));

    expect((mockCreate.mock.calls[0][0] as any).stream).toBeUndefined();
  });

  it("串流中斷（arguments 拼不成 JSON）時不炸掉，當成空參數", async () => {
    mockCreate
      .mockResolvedValueOnce(
        eventStream(
          streamedCallEvents("int-s4", {
            id: "call-y",
            name: "getAirQuality",
            argChunks: ['{"lat":'],
          }),
        ),
      )
      .mockResolvedValueOnce(eventStream(streamedTextEvents("int-s5", ["ok"])));
    mockExec.mockResolvedValue(JSON.stringify({ ok: true }));

    const result = await runToolLoop(
      userInput("x"),
      undefined,
      "test-model",
      undefined,
      undefined,
      undefined,
      undefined,
      false,
      false,
      false,
      executeLocalTool,
      { onTextDelta: () => {} },
    );

    expect(mockExec.mock.calls[0][1]).toEqual({});
    expect(result.text).toBe("ok");
  });
});
