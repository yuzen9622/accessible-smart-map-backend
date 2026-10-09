import { describe, expect, it } from "vitest";
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

  it("translates English navigation while keeping all source facts and legacy verbatim speech", () => {
    const text = "向右轉，沿中山路走 50 公尺，搭乘 307 公車";
    const english = buildNavigationSpeechPrompt(text, "en");
    expect(english).toContain("使用英文");
    expect(english).toContain("不得增減資訊或呼叫工具");
    expect(english).toContain(text);
    expect(english).not.toContain("逐字唸出");
    expect(buildNavigationSpeechPrompt(text, "zh-TW")).toBe(
      buildNavigationSpeechPrompt(text),
    );
  });
});

describe("buildVoiceSystemPrompt nearest-place policy", () => {
  it("directs the model to search and route without asking for a station when GPS exists", () => {
    const prompt = buildVoiceSystemPrompt({
      latitude: 25.0478,
      longitude: 121.517,
    });

    expect(prompt).toContain("不要反問要去哪個 X");
    expect(prompt).toContain("先呼叫 findGooglePlaces");
    expect(prompt).toContain("再呼叫 planAccessibleRoute");
    expect(prompt).toContain("【使用者目前位置】");
  });

  it("keeps nearby exploration separate from route planning", () => {
    const prompt = buildVoiceSystemPrompt({
      latitude: 25.0478,
      longitude: 121.517,
    });

    expect(prompt).toContain("附近有哪些 X");
    expect(prompt).toContain("不要自動規劃路線");
    expect(prompt).toContain(
      "只有使用者接著要求帶路時才呼叫 planAccessibleRoute",
    );
  });

  it("directs the model to request location instead of a station when GPS is absent", () => {
    const prompt = buildVoiceSystemPrompt();

    expect(prompt).toContain("只詢問是否能取得位置");
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
