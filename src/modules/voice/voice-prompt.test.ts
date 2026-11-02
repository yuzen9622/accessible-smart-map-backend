import { describe, expect, it } from "vitest";
import { VENUE_ANNOTATION_PRESENTATION_RULE } from "../../config/ai/agent-prompt-shared";
import {
  buildVoiceSystemPrompt,
  buildNavigationSpeechPrompt,
} from "./voice-prompt";

describe("voice language preference", () => {
  it("places the current preference after earlier history and memories", () => {
    const prompt = buildVoiceSystemPrompt(
      undefined,
      [{ category: "preference", content: "以前偏好中文" }],
      { language: "en", history: [{ role: "assistant", text: "您好" }] },
    );
    expect(prompt).toContain("Respond in English");
    expect(prompt.indexOf("【目前介面語言偏好：en】")).toBeGreaterThan(
      prompt.indexOf("您好"),
    );
    expect(prompt).toContain("只有使用者本輪明確要求另一種語言或翻譯時");
    expect(
      buildVoiceSystemPrompt(undefined, [], { language: "zh-TW" }),
    ).toContain("請使用臺灣繁體中文回覆");
    expect(buildVoiceSystemPrompt()).not.toContain("目前介面語言偏好");
  });

  it("marks navigation facts for natural phrasing, asking for English when the UI is English", () => {
    const text = "向右轉，沿中山路走 50 公尺，搭乘 307 公車";
    expect(buildNavigationSpeechPrompt(text)).toBe(`【導航提示】${text}`);
    expect(buildNavigationSpeechPrompt(text, "en")).toBe(
      `【導航提示】（請用英文說）${text}`,
    );
    const prompt = buildVoiceSystemPrompt();
    expect(prompt).toContain("收到「【導航提示】」開頭的內容時");
    expect(prompt).toContain(
      "方向、路名、站名、路線號碼、距離與時間都必須保留且不能更改",
    );
    expect(prompt).not.toContain("逐字唸出");
  });
});

describe("buildVoiceSystemPrompt nearest-place policy", () => {
  it("directs the model to search and route without asking for a station when GPS exists", () => {
    const prompt = buildVoiceSystemPrompt({
      latitude: 25.0478,
      longitude: 121.517,
    });

    expect(prompt).toContain("不要要求使用者重複指定最近的地點");
    expect(prompt).toContain("先呼叫 findGooglePlaces");
    expect(prompt).toContain("再呼叫 planAccessibleRoute");
    expect(prompt).toContain("【使用者目前位置】");
  });

  it("keeps nearby exploration separate from route planning", () => {
    const prompt = buildVoiceSystemPrompt({
      latitude: 25.0478,
      longitude: 121.517,
    });

    expect(prompt).toContain("使用者僅想探索附近地點");
    expect(prompt).toContain("不要自動規劃路線");
    expect(prompt).toContain(
      "需要路線資訊或實際帶路時再呼叫 planAccessibleRoute",
    );
    expect(prompt).toContain("不以特定詞句判定");
  });

  it("directs the model to request location instead of a station when GPS is absent", () => {
    const prompt = buildVoiceSystemPrompt();

    expect(prompt).toContain("工具會向 App 確認位置");
    expect(prompt).toContain("收到 LOCATION_REQUIRED 時保持對話");
    expect(prompt).toContain(
      "STALE_SELECTION 代表查詢已被較新的要求取代，不代表沒有定位",
    );
    expect(prompt).toContain("不要猜測最近的候選");
    expect(prompt).not.toContain("【使用者目前位置】緯度");
  });
});

describe("buildVoiceSystemPrompt multi-tool chaining guidance", () => {
  it("adopts the shared chaining principle so it keeps calling tools until it can fully answer", () => {
    const prompt = buildVoiceSystemPrompt();

    expect(prompt).toContain("依序串接多個工具，直到能完整回答再停");
    expect(prompt).toContain("全部查完再一次講結果");
  });

  it("no longer carries the announce-before-every-tool rule that forced one-tool-at-a-time replies", () => {
    const prompt = buildVoiceSystemPrompt();

    expect(prompt).not.toContain("呼叫任何工具之前");
    expect(prompt).not.toContain("一次只講重點");
  });
});

describe("buildVoiceSystemPrompt active-navigation context", () => {
  it("resolves transit and weather references before asking the user again", () => {
    const prompt = buildVoiceSystemPrompt();

    expect(prompt).toContain("先呼叫 getActiveNavigationContext");
    expect(prompt).toContain(
      "transit.routeName、transit.from、transit.direction",
    );
    expect(prompt).toContain("呼叫 getBusArrival");
    expect(prompt).toContain("後端會使用導航最新位置");
    expect(prompt).toContain("只有 active=false 或必要欄位確實不存在時才追問");
    expect(prompt).toContain("不得把其他運具冒充公車即時資料");
  });
});

describe("buildVoiceSystemPrompt user memories", () => {
  it("injects user memories with category labels and IDs when provided", () => {
    const memories = [
      {
        _id: "60c72b2f9b1d8b0015f8e123",
        category: "preference",
        content: "使用者偏好輪椅友善路線",
        promptText: "偏好輪椅友善路線",
      },
      {
        _id: "60c72b2f9b1d8b0015f8e124",
        category: "habit",
        content: "常搭307公車通勤",
      },
    ];

    const prompt = buildVoiceSystemPrompt(undefined, memories);

    expect(prompt).toContain("【使用者記憶】");
    expect(prompt).toContain(
      "- [偏好] 偏好輪椅友善路線 (id:60c72b2f9b1d8b0015f8e123)",
    );
    expect(prompt).toContain(
      "- [習慣] 常搭307公車通勤 (id:60c72b2f9b1d8b0015f8e124)",
    );
    expect(prompt).toContain("呼叫 saveMemory");
    expect(prompt).toContain("呼叫 deleteMemory");
  });

  it("omits the memory section when memories array is empty or undefined", () => {
    const promptWithoutMem = buildVoiceSystemPrompt();
    expect(promptWithoutMem).not.toContain("【使用者記憶】");

    const promptWithEmptyMem = buildVoiceSystemPrompt(undefined, []);
    expect(promptWithEmptyMem).not.toContain("【使用者記憶】");
  });
});

it("explains named Places centers and explicit-only voice ending", () => {
  const prompt = buildVoiceSystemPrompt();
  for (const rule of [
    "locationQuery",
    "台中車站",
    "我附近",
    "endVoiceSession",
    "否定、資訊詢問、引用指令",
    "回答完問題",
  ])
    expect(prompt).toContain(rule);
});

it("requires semantic direct start and current proposal confirmation", () => {
  const prompt = buildVoiceSystemPrompt();
  expect(prompt).toContain("navigationStarted:true");
  expect(prompt).toContain("proposeNavigationCandidate");
  expect(prompt).toContain("confirmNavigationCandidateSwitch");
  expect(prompt).toContain("同一使用者回合");
  expect(prompt).toContain("無固定對話期限");
  expect(prompt).toContain("startNavigation:true");
  expect(prompt).toContain("省略 startNavigation 或設 false");
  expect(prompt).not.toContain("120 秒");
  expect(prompt).toContain("等使用者要求開始導航");
});

it("uses the shared indoor annotation presentation rule without announcing unrequested editing notes", () => {
  const prompt = buildVoiceSystemPrompt();
  expect(prompt).toContain(VENUE_ANNOTATION_PRESENTATION_RULE);
  expect(prompt).not.toContain("slopeMeasured 為 false 時說「坡度未實測」");
});

describe("voice conversation and tool-result boundaries", () => {
  it("scopes duplicate lookups to one turn and grounds replay in a fresh navigation tool result", () => {
    const prompt = buildVoiceSystemPrompt(undefined, [], {
      history: [
        { role: "user", text: "請重播目前這一步的導航指示。" },
        { role: "assistant", text: "向右轉進入承德路一段。" },
      ],
    });
    expect(prompt).not.toContain("同一工具配相同參數不要重複呼叫");
    expect(prompt).toContain("同一使用者回合內，對相同結果不要無故重複查詢");
    expect(prompt).toContain(
      "新的使用者請求、導航步驟或狀態變更時可再次呼叫相同工具與參數",
    );
    expect(prompt).toContain("重播或重述目前步驟時，以本次真實工具結果為準");
    expect(prompt).toContain("可呼叫 repeatNavStep 由導航引擎播報");
    expect(prompt).toContain(
      "或呼叫 getActiveNavigationContext 後忠實重述 currentStep",
    );
    expect(prompt).toContain("不得更改方向或距離");
    expect(prompt).toContain("active=false 時依本次結果說明");
    expect(prompt).toContain("不得僅依歷史推測不可用或宣稱已重播");
    expect(prompt).not.toContain(
      "使用者每次要求重播目前步驟時，都呼叫 repeatNavStep",
    );
    expect(prompt).toContain(
      "只有 startNavigation 或 confirmNavigationCandidateSwitch 回傳 ok:true 才可說已開始導航或已切換",
    );
    expect(prompt).toContain(
      "希望停止導航時呼叫 stopNavigation，不得誤呼叫 endVoiceSession 或只口頭答應",
    );
  });
  it("distinguishes automatic navigation speech from route previews and context queries", () => {
    const prompt = buildVoiceSystemPrompt();
    expect(prompt).toContain(
      "開始導航（含規劃後直接開始）、推進或重播成功時，導航引擎會另外送來導航提示播報步驟",
    );
    expect(prompt).toContain("guidance=preview 表示使用者還不在路線上");
    expect(prompt).toContain(
      "只規劃未開始導航，或僅呼叫 getActiveNavigationContext 查詢時，依工具結果自然說明",
    );
    expect(prompt).toContain(
      "呼叫 planIndoorRoute；僅規劃、未開始導航時，依回傳步驟口語說明",
    );
    expect(prompt).not.toContain("呼叫 planIndoorRoute，依回傳步驟口語說明");
  });
  it("allows natural conversation without requiring a route or a tool result", () => {
    const prompt = buildVoiceSystemPrompt();
    expect(prompt).toContain("問候、閒聊與一般對話直接自然回應，無須呼叫工具");
    expect(prompt).toContain("依使用者本輪問題與上下文自行組織回答");
    expect(prompt).toContain("涉及路線、班次、地點或操作結果時");
    expect(prompt).not.toContain("開始查一件事時，先用一句話告知使用者");
  });
});
