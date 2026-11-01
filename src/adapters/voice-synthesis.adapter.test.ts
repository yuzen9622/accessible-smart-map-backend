import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GenerateContentResponse } from "@google/genai";

const mock = vi.hoisted(() => ({ stream: vi.fn() }));
vi.mock("../config/ai", () => ({
  googleGenAi: { models: { generateContentStream: mock.stream } },
}));

import { synthesizeVoice } from "./voice-synthesis.adapter";

function audio(bytes: number[], mimeType = "audio/L16;codec=pcm;rate=24000") {
  return {
    candidates: [
      {
        content: {
          parts: [
            {
              thought: false,
              inlineData: {
                mimeType,
                data: Buffer.from(bytes).toString("base64"),
              },
            },
          ],
        },
        finishReason: undefined as NonNullable<
          GenerateContentResponse["candidates"]
        >[number]["finishReason"],
      },
    ],
    promptFeedback: undefined as GenerateContentResponse["promptFeedback"],
  };
}
async function* chunks(...values: ReturnType<typeof audio>[]) {
  yield* values;
  yield { candidates: [{ finishReason: "STOP" }] };
}
function run(signal = new AbortController().signal) {
  return synthesizeVoice("已規劃開車與機車路線，目前未開始導航。", {
    voiceName: "Kore",
    signal,
  });
}
beforeEach(() => {
  vi.clearAllMocks();
  mock.stream.mockResolvedValue(chunks(audio([1, 0, 2, 0])));
});
afterEach(() => vi.useRealTimers());

describe("trusted transcript speech synthesis", () => {
  it("uses one isolated TTS request and concatenates ordered PCM without chat/tools", async () => {
    mock.stream.mockResolvedValue(chunks(audio([1, 0]), audio([2, 0])));
    await expect(run()).resolves.toEqual({
      pcm: Buffer.from([1, 0, 2, 0]),
      sampleRate: 24000,
    });
    expect(mock.stream).toHaveBeenCalledTimes(1);
    const request = mock.stream.mock.calls[0][0];
    expect(request.model).toBe("gemini-3.8-flash-lite-tts");
    expect(request.contents).toEqual([
      {
        role: "user",
        parts: [{ text: "已規劃開車與機車路線，目前未開始導航。" }],
      },
    ]);
    expect(request.config).toMatchObject({
      responseModalities: ["AUDIO"],
      speechConfig: {
        voiceConfig: { prebuiltVoiceConfig: { voiceName: "Kore" } },
      },
      httpOptions: { timeout: 30000, retryOptions: { attempts: 1 } },
    });
    expect(request.config).not.toHaveProperty("tools");
    expect(request.config).not.toHaveProperty("systemInstruction");
  });

  it.each(["audio/l16;rate=24000", "audio/pcm;rate=24000;channels=1"])(
    "accepts documented mono PCM format %s",
    async (mime) => {
      mock.stream.mockResolvedValue(chunks(audio([1, 0], mime)));
      await expect(run()).resolves.toMatchObject({ sampleRate: 24000 });
    },
  );

  it.each([
    "audio/wav",
    "audio/l16",
    "audio/pcm",
    "audio/l16;rate=16000",
    "audio/l16;channels=2",
    "audio/l16;codec=float32",
    "audio/l16;rate=24000=invalid",
    "",
  ])("rejects incompatible audio format %s", async (mime) => {
    mock.stream.mockResolvedValue(chunks(audio([1, 0], mime)));
    await expect(run()).rejects.toThrow("VOICE_SYNTHESIS_INVALID_FORMAT");
  });

  it("rejects odd PCM bytes without returning earlier complete chunks", async () => {
    mock.stream.mockResolvedValue(chunks(audio([1, 0]), audio([2])));
    await expect(run()).rejects.toThrow("VOICE_SYNTHESIS_INVALID_AUDIO");
  });

  it("rejects malformed base64 and a response exceeding 90 seconds before decoding it", async () => {
    const malformed = audio([1, 0]);
    malformed.candidates[0].content.parts[0].inlineData.data = "!!!!";
    mock.stream.mockResolvedValueOnce(chunks(malformed));
    await expect(run()).rejects.toThrow("VOICE_SYNTHESIS_INVALID_AUDIO");
    const oversized = audio([1, 0]);
    oversized.candidates[0].content.parts[0].inlineData.data = Buffer.alloc(
      24000 * 2 * 90 + 2,
    ).toString("base64");
    mock.stream.mockResolvedValueOnce(chunks(oversized));
    await expect(run()).rejects.toThrow("VOICE_SYNTHESIS_AUDIO_TOO_LONG");
  });

  it("rejects cumulative PCM beyond the limit", async () => {
    const first = audio([1, 0]);
    first.candidates[0].content.parts[0].inlineData.data = Buffer.alloc(
      24000 * 2 * 90 - 2,
    ).toString("base64");
    mock.stream.mockResolvedValue(chunks(first, audio([1, 0, 2, 0])));
    await expect(run()).rejects.toThrow("VOICE_SYNTHESIS_AUDIO_TOO_LONG");
  });

  it.each(["empty", "thought", "blocked", "truncated", "multiple"])(
    "does not return %s audio as a successful trusted turn",
    async (kind) => {
      const chunk = audio([1, 0]);
      if (kind === "empty") chunk.candidates = [];
      if (kind === "thought")
        chunk.candidates[0].content.parts[0].thought = true;
      if (kind === "blocked")
        chunk.promptFeedback = {
          blockReason: "SAFETY",
        } as GenerateContentResponse["promptFeedback"];
      if (kind === "truncated")
        chunk.candidates[0].finishReason = "MAX_TOKENS" as NonNullable<
          GenerateContentResponse["candidates"]
        >[number]["finishReason"];
      if (kind === "multiple") chunk.candidates.push(chunk.candidates[0]);
      mock.stream.mockResolvedValue(chunks(chunk));
      await expect(run()).rejects.toThrow();
    },
  );

  it("rejects audio followed by EOF without the provider STOP marker", async () => {
    mock.stream.mockResolvedValue(
      (async function* () {
        yield audio([1, 0]);
      })(),
    );
    await expect(run()).rejects.toThrow("VOICE_SYNTHESIS_INCOMPLETE");
  });

  it("does not call the provider for an already canceled turn", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(run(controller.signal)).rejects.toThrow(
      "VOICE_SYNTHESIS_ABORTED",
    );
    expect(mock.stream).not.toHaveBeenCalled();
  });

  it("cancels promptly while the provider stream is stalled", async () => {
    const controller = new AbortController();
    mock.stream.mockResolvedValue(
      (async function* () {
        yield audio([1, 0]);
        await new Promise(() => {});
      })(),
    );
    const result = expect(run(controller.signal)).rejects.toThrow(
      "VOICE_SYNTHESIS_ABORTED",
    );
    await Promise.resolve();
    controller.abort();
    await result;
    expect(mock.stream.mock.calls[0][0].config.abortSignal.aborted).toBe(true);
  });

  it("bounds a provider call even if it ignores cancellation", async () => {
    vi.useFakeTimers();
    mock.stream.mockReturnValue(new Promise(() => {}));
    const result = expect(run()).rejects.toThrow("VOICE_SYNTHESIS_TIMEOUT");
    await vi.advanceTimersByTimeAsync(30000);
    await result;
    expect(mock.stream.mock.calls[0][0].config.abortSignal.aborted).toBe(true);
  });

  it("returns provider failure without retrying or returning partial audio", async () => {
    mock.stream.mockResolvedValue(
      (async function* () {
        yield audio([1, 0]);
        throw new Error("provider failed");
      })(),
    );
    await expect(run()).rejects.toThrow("provider failed");
    expect(mock.stream).toHaveBeenCalledTimes(1);
  });
});
