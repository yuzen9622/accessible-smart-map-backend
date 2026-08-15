import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../config/ai", () => ({
  googleGenAi: {
    models: { generateContent: vi.fn() },
  },
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

import { googleGenAi } from "../../config/ai";
import { executeLocalTool } from "../ai/agent-tools";
import { runToolLoop, runAgent } from "./agent-manager.service";
import { FunctionCallingConfigMode, type Content } from "@google/genai";

const mockCreate = googleGenAi.models.generateContent as unknown as ReturnType<
  typeof vi.fn
>;
const mockExec = executeLocalTool as unknown as ReturnType<typeof vi.fn>;

// The executor is now an injected dependency (execTool is required), so tests
// pass the mocked executeLocalTool explicitly through this thin wrapper.
const run = (contents: Content[]) =>
  runToolLoop(
    contents,
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

beforeEach(() => {
  vi.clearAllMocks();
});

function functionCallResponse(
  calls: Array<{ name: string; args: Record<string, unknown> }>,
) {
  return {
    functionCalls: calls.map((c) => ({ name: c.name, args: c.args })),
    candidates: [
      {
        content: {
          role: "model",
          parts: calls.map((c) => ({
            functionCall: { name: c.name, args: c.args },
          })),
        },
      },
    ],
  };
}

function stopResponse() {
  return {
    functionCalls: undefined,
    text: "done",
    candidates: [{ content: { role: "model", parts: [{ text: "done" }] } }],
  };
}

function functionResponseParts(contents: Content[]) {
  return contents
    .flatMap((c) => c.parts ?? [])
    .filter((p) => "functionResponse" in p && p.functionResponse);
}

describe("runToolLoop dedup", () => {
  it("沒有工具呼叫但模型有文字時回傳文字（T3：不多打 final）", async () => {
    mockCreate.mockResolvedValueOnce(stopResponse());

    const contents: Content[] = [{ role: "user", parts: [{ text: "hello" }] }];
    const result = await run(contents);

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

    const contents: Content[] = [{ role: "user", parts: [{ text: "test" }] }];
    await run(contents);

    expect(mockExec).toHaveBeenCalledTimes(1);
    const fnResponses = functionResponseParts(contents);
    expect(fnResponses).toHaveLength(2);
    expect((fnResponses[0] as any).functionResponse.response).toEqual(
      (fnResponses[1] as any).functionResponse.response,
    );
  });

  it("相同 (name, args) 但失敗 → 第二次重新執行", async () => {
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

    const contents: Content[] = [{ role: "user", parts: [{ text: "test" }] }];
    await run(contents);

    expect(mockExec).toHaveBeenCalledTimes(2);
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

    const contents: Content[] = [{ role: "user", parts: [{ text: "test" }] }];
    await run(contents);

    expect(mockExec).toHaveBeenCalledTimes(2);
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

    const contents: Content[] = [{ role: "user", parts: [{ text: "test" }] }];
    const result = await run(contents);

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

    const contents: Content[] = [{ role: "user", parts: [{ text: "test" }] }];
    await run(contents);

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

    const contents: Content[] = [{ role: "user", parts: [{ text: "test" }] }];
    await run(contents);

    expect(mockExec).toHaveBeenCalledTimes(2);
  });
});

function emptyStopResponse() {
  return {
    functionCalls: undefined,
    text: "",
    candidates: [{ content: { role: "model", parts: [] } }],
  };
}

function textResponse(text: string) {
  return {
    functionCalls: undefined,
    text,
    candidates: [{ content: { role: "model", parts: [{ text }] } }],
  };
}

describe("runToolLoop 最終文字保證（修沒文字 bug）", () => {
  it("T1：跑滿 MAX_ROUNDS 仍在呼叫工具 → 用 buildFinalConfig(mode NONE) 強制回文字", async () => {
    for (let i = 0; i < 5; i++) {
      mockCreate.mockResolvedValueOnce(
        functionCallResponse([{ name: "getBusArrival", args: { round: i } }]),
      );
    }
    mockCreate.mockResolvedValueOnce(textResponse("最終答案"));
    mockExec.mockResolvedValue(JSON.stringify({ ok: true, etaMinutes: 4 }));

    const contents: Content[] = [{ role: "user", parts: [{ text: "x" }] }];
    const result = await run(contents);

    expect(mockCreate).toHaveBeenCalledTimes(6);
    const finalCfg = (mockCreate.mock.calls[5][0] as any).config;
    expect(finalCfg.toolConfig.functionCallingConfig.mode).toBe(
      FunctionCallingConfigMode.NONE,
    );
    expect(finalCfg.temperature).toBe(0);
    expect(result.text).toBe("最終答案");
  });

  it("T2：無工具呼叫但文字為空 → 觸發一次 final 生成回非空文字", async () => {
    mockCreate
      .mockResolvedValueOnce(emptyStopResponse())
      .mockResolvedValueOnce(textResponse("補救答案"));

    const contents: Content[] = [{ role: "user", parts: [{ text: "x" }] }];
    const result = await run(contents);

    expect(mockCreate).toHaveBeenCalledTimes(2);
    const finalCfg = (mockCreate.mock.calls[1][0] as any).config;
    expect(finalCfg.toolConfig.functionCallingConfig.mode).toBe(
      FunctionCallingConfigMode.NONE,
    );
    expect(result.text).toBe("補救答案");
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

    const contents: Content[] = [
      {
        role: "user",
        parts: [{ text: "從中科大要去火車站可以搭哪些公車、哪班最快來" }],
      },
    ];
    const result = await run(contents);

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
      contents: [{ role: "user", parts: [{ text: "hi" }] }],
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
      contents: [{ role: "user", parts: [{ text: "air?" }] }],
      systemInstruction: undefined,
      model: "test-model",
      execTool: executeLocalTool,
    });

    expect(mockExec).toHaveBeenCalledTimes(1);
    expect(mockExec.mock.calls[0][0]).toBe("getAirQuality");
  });
});
