import { describe, expect, it } from "vitest";
import { normalizeVoiceTranscript } from "./transcript-normalizer";

describe("normalizeVoiceTranscript", () => {
  it("converts simplified Chinese transcripts to Taiwan Traditional Chinese", () => {
    expect(normalizeVoiceTranscript("带我去最近的火车站，怎么走？")).toBe(
      "帶我去最近的火車站，怎麼走？",
    );
  });

  it("preserves existing Traditional Chinese and non-Chinese text", () => {
    expect(normalizeVoiceTranscript("帶我去臺北車站，ETA 5 min")).toBe(
      "帶我去臺北車站，ETA 5 min",
    );
  });

  it("converts Mainland vocabulary to Taiwan vocabulary (twp phrase level)", () => {
    expect(normalizeVoiceTranscript("帮我查网络上的出租车信息")).toBe(
      "幫我查網路上的計程車資訊",
    );
  });
});
