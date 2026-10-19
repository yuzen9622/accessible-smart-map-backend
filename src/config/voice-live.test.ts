import { afterEach, describe, expect, it, vi } from "vitest";
import { getVoiceOutputTrimConfig } from "./voice-live";

describe("getVoiceOutputTrimConfig", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("uses the measured defaults when unset or blank", () => {
    vi.stubEnv("VOICE_OUTPUT_MAX_SILENCE_MS", undefined);
    vi.stubEnv("VOICE_OUTPUT_SPEECH_LEVEL", " ");
    vi.stubEnv("VOICE_OUTPUT_SPEECH_MAX_ZCR", undefined);
    expect(getVoiceOutputTrimConfig()).toEqual({
      maxSilenceMs: 1500,
      speechLevel: 300,
      speechMaxZeroCrossingRate: 0.5,
    });
  });

  it("applies valid overrides", () => {
    vi.stubEnv("VOICE_OUTPUT_MAX_SILENCE_MS", "2000");
    vi.stubEnv("VOICE_OUTPUT_SPEECH_LEVEL", "200");
    vi.stubEnv("VOICE_OUTPUT_SPEECH_MAX_ZCR", "0.6");
    expect(getVoiceOutputTrimConfig()).toEqual({
      maxSilenceMs: 2000,
      speechLevel: 200,
      speechMaxZeroCrossingRate: 0.6,
    });
  });

  it.each([
    ["VOICE_OUTPUT_MAX_SILENCE_MS", "0"],
    ["VOICE_OUTPUT_MAX_SILENCE_MS", "abc"],
    ["VOICE_OUTPUT_SPEECH_LEVEL", "40000"],
    ["VOICE_OUTPUT_SPEECH_MAX_ZCR", "1.5"],
  ])("rejects %s=%s", (name, value) => {
    vi.stubEnv(name, value);
    expect(() => getVoiceOutputTrimConfig()).toThrow(name);
  });
});
