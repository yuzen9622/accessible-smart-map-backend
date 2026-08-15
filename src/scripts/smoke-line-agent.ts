import { runToolLoop } from "../modules/agent/agent-manager.service";
import { toGeminiHistory } from "../modules/agent/history-adapter";
import { lineFamilyTools } from "../config/ai/tool";
import { LINE_FAMILY_SYSTEM_PROMPT } from "../config/ai/line-family-prompt";
import { withCurrentDate } from "../config/ai/chat-prompt";
import { model } from "../config/ai";

interface RecordedCall {
  name: string;
  args: Record<string, unknown>;
}

interface ScenarioRun {
  calls: RecordedCall[];
  speech: string;
}

interface Scenario {
  id: string;
  message?: string;
  run?: () => Promise<ScenarioRun>;
  assert: (run: ScenarioRun) => string[];
}

interface HistoryMessage {
  role: "user" | "assistant";
  content: string;
}

const FIXED_LINE_CONTEXT =
  "【你服務的對象】此聯絡人已綁定家人：測試家人。上次分享的位置：尚未分享過位置。";

const CANNED_RESULTS: Record<string, unknown> = {
  getActiveSosContext: {
    activeSessions: [],
    latestSession: {
      sessionId: "000000000000000000000000",
      ownerName: "測試家人",
      status: "resolved",
      startedAt: "2026-07-19T03:00:00.000Z",
      resolvedAt: "2026-07-19T03:46:00.000Z",
      address: "台北市中正區測試路 1 號",
    },
  },
  getEnvironmentInfo: {
    ok: true,
    location: "台北市",
    weather: { description: "多雲", temperature: 31, rainProbability: 20 },
    airQuality: { aqi: 42, status: "良好" },
  },
  findGooglePlaces: {
    ok: true,
    places: [
      { name: "測試餐廳", address: "台北市中正區測試路 2 號", rating: 4.3 },
    ],
  },
};

/**
 * Runs one message through the same agent assembly as
 * line.service.ts#handleTextMessage, with a stub executor that records tool
 * selections and returns canned data instead of touching DB or external APIs.
 *
 * @param message User message to send through the LINE family agent
 * @param history Prior user and assistant messages to include
 * @returns Recorded tool calls plus the parsed speech of the final answer
 */
async function runScenario(
  message: string,
  history: HistoryMessage[] = [],
): Promise<ScenarioRun> {
  const calls: RecordedCall[] = [];
  const { systemInstruction, contents } = toGeminiHistory([
    { role: "system", content: withCurrentDate(LINE_FAMILY_SYSTEM_PROMPT) },
    { role: "system", content: FIXED_LINE_CONTEXT },
    ...history,
    { role: "user", content: message },
  ]);

  const result = await runToolLoop(
    contents,
    systemInstruction,
    model,
    undefined,
    undefined,
    undefined,
    undefined,
    false,
    false,
    false,
    async (name, args) => {
      calls.push({ name, args });
      return JSON.stringify(CANNED_RESULTS[name] ?? { ok: true });
    },
    { extraTools: lineFamilyTools },
  );

  return { calls, speech: parseSpeech(result.text ?? "") };
}

/**
 * @returns Combined tool calls from a two-turn weather clarification exchange.
 */
async function runWeatherClarificationScenario(): Promise<ScenarioRun> {
  const first = await runScenario("天氣如何");
  const second = await runScenario("台北", [
    { role: "user", content: "天氣如何" },
    { role: "assistant", content: first.speech },
  ]);
  return {
    calls: [...first.calls, ...second.calls],
    speech: second.speech,
  };
}

/**
 * Extracts the user-facing speech from the agent's final text, mirroring the
 * lenient JSON envelope parsing in line.service.ts.
 *
 * @param text Raw final text returned by the agent
 * @returns The speech field when the text is a JSON envelope, otherwise the raw text
 */
function parseSpeech(text: string): string {
  const trimmed = text.trim();
  if (!trimmed.startsWith("{")) return trimmed;
  try {
    const parsed = JSON.parse(trimmed);
    if (parsed && typeof parsed.speech === "string") return parsed.speech;
  } catch {
    return trimmed;
  }
  return trimmed;
}

function called(run: ScenarioRun, name: string): boolean {
  return run.calls.some((call) => call.name === name);
}

function calledSosTool(run: ScenarioRun): boolean {
  return run.calls.some(
    (call) => /sos/i.test(call.name) || call.name === "getActiveSosContext",
  );
}

const SCENARIOS: Scenario[] = [
  {
    id: "S1 一般天氣（含地名）",
    message: "台北天氣如何",
    assert: (run) => {
      const errors: string[] = [];
      const envCall = run.calls.find((c) => c.name === "getEnvironmentInfo");
      if (!envCall) errors.push("必須呼叫 getEnvironmentInfo");
      else if (
        typeof envCall.args.query !== "string" ||
        !envCall.args.query.includes("台北")
      )
        errors.push(
          `getEnvironmentInfo 的 query 應含使用者地名，實際: ${JSON.stringify(envCall.args)}`,
        );
      if (calledSosTool(run)) errors.push("不得呼叫任何 SOS 工具");
      return errors;
    },
  },
  {
    id: "S2 一般天氣（無地名）",
    message: "天氣如何",
    assert: (run) => {
      const errors: string[] = [];
      if (calledSosTool(run)) errors.push("不得呼叫任何 SOS 工具");
      if (called(run, "getEnvironmentInfo"))
        errors.push(
          "沒有地名時不得呼叫 getEnvironmentInfo（不可自行假設地點）",
        );
      if (!run.speech) errors.push("speech 不得為空");
      else if (!/[哪那][個些裡邊]?|[?？]/.test(run.speech))
        errors.push(`speech 應為詢問地區的問句，實際: ${run.speech}`);
      return errors;
    },
  },
  {
    id: "S3 家人位置（無 active SOS）",
    message: "他現在在哪",
    assert: (run) => {
      const errors: string[] = [];
      if (!called(run, "getActiveSosContext"))
        errors.push("必須先呼叫 getActiveSosContext");
      if (!run.speech) errors.push("speech 不得為空");
      return errors;
    },
  },
  {
    id: "S4 求救者那邊的天氣",
    message: "那邊天氣怎樣",
    assert: (run) => {
      const errors: string[] = [];
      if (!called(run, "getActiveSosContext"))
        errors.push("必須先呼叫 getActiveSosContext（SOS 指涉路徑）");
      if (called(run, "getEnvironmentInfo"))
        errors.push("不得改走一般天氣工具 getEnvironmentInfo");
      return errors;
    },
  },
  {
    id: "S5 一般找地點",
    message: "台北車站附近有什麼餐廳",
    assert: (run) => {
      const errors: string[] = [];
      if (!called(run, "findGooglePlaces"))
        errors.push("必須呼叫 findGooglePlaces");
      if (calledSosTool(run)) errors.push("不得呼叫任何 SOS 工具");
      return errors;
    },
  },
  {
    id: "S6 多輪天氣位置澄清",
    run: runWeatherClarificationScenario,
    assert: (run) => {
      const errors: string[] = [];
      const environmentCalls = run.calls.filter(
        (call) => call.name === "getEnvironmentInfo",
      );
      const finalEnvironmentCall = environmentCalls.at(-1);
      if (!finalEnvironmentCall) {
        errors.push("第二輪必須呼叫 getEnvironmentInfo");
      } else if (
        typeof finalEnvironmentCall.args.query !== "string" ||
        !finalEnvironmentCall.args.query.includes("台北")
      ) {
        errors.push(
          `第二輪 getEnvironmentInfo 的 query 應含台北，實際: ${JSON.stringify(finalEnvironmentCall.args)}`,
        );
      }
      if (environmentCalls.length !== 1) {
        errors.push(
          `兩輪合計應只在第二輪呼叫一次 getEnvironmentInfo，實際: ${environmentCalls.length}`,
        );
      }
      if (calledSosTool(run)) errors.push("兩輪全程不得呼叫任何 SOS 工具");
      return errors;
    },
  },
];

const MAX_ATTEMPTS = 2;

async function main(): Promise<void> {
  if (!process.env.GEMINI_API_KEY) {
    console.error("缺少 GEMINI_API_KEY，無法執行煙測");
    process.exit(1);
  }

  let failed = 0;
  for (const scenario of SCENARIOS) {
    let errors: string[] = [];
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      const run = scenario.run
        ? await scenario.run()
        : await runScenario(scenario.message ?? "");
      errors = scenario.assert(run);
      const toolSeq =
        run.calls.map((c) => c.name).join(" → ") || "(無工具呼叫)";
      console.log(
        `[${scenario.id}] attempt ${attempt} 工具序列: ${toolSeq}\n  speech: ${run.speech}`,
      );
      if (!errors.length) break;
      console.log(`  未通過: ${errors.join("；")}`);
    }
    if (errors.length) {
      failed++;
      console.error(`✗ ${scenario.id} 失敗`);
    } else {
      console.log(`✓ ${scenario.id} 通過`);
    }
  }

  if (failed) {
    console.error(`\n煙測失敗：${failed}/${SCENARIOS.length} 個情境未通過`);
    process.exit(1);
  }
  console.log(`\n煙測通過：${SCENARIOS.length}/${SCENARIOS.length}`);
  process.exit(0);
}

main().catch((error) => {
  console.error("煙測執行錯誤", error);
  process.exit(1);
});
