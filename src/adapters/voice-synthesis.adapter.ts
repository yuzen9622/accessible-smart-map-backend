import { Modality } from "@google/genai";
import { googleGenAi } from "../config/ai";
import { withDeadline } from "../utils/with-deadline";

const MODEL = "gemini-3.8-flash-lite-tts";
const SAMPLE_RATE = 24_000;
const MAX_PCM_BYTES = SAMPLE_RATE * 2 * 90;
const TIMEOUT_MS = 30_000;

function validatePcmMime(mimeType: string | undefined): void {
  const [mediaType, ...parameters] = (mimeType ?? "")
    .toLowerCase()
    .split(";")
    .map((value) => value.trim());
  if (mediaType !== "audio/l16" && mediaType !== "audio/pcm") {
    throw new Error("VOICE_SYNTHESIS_INVALID_FORMAT");
  }
  const expected: Record<string, string> = {
    rate: String(SAMPLE_RATE),
    channels: "1",
    codec: "pcm",
  };
  let hasRate = false;
  for (const parameter of parameters) {
    const [key, value, extra] = parameter.split("=");
    if (!key || expected[key] !== value || extra !== undefined) {
      throw new Error("VOICE_SYNTHESIS_INVALID_FORMAT");
    }
    if (key === "rate") hasRate = true;
  }
  if (!hasRate) throw new Error("VOICE_SYNTHESIS_INVALID_FORMAT");
}

/** Synthesize only the supplied transcript; return complete PCM, never a partial turn. */
export async function synthesizeVoice(
  text: string,
  options: { voiceName: string; signal: AbortSignal },
): Promise<{ pcm: Buffer; sampleRate: 24000 }> {
  if (!text.trim() || text.length > 8_000 || !options.voiceName.trim()) {
    throw new Error("VOICE_SYNTHESIS_INVALID_INPUT");
  }
  const request = new AbortController();
  try {
    return await withDeadline(
      async () => {
        const stream = await googleGenAi.models.generateContentStream({
          model: MODEL,
          contents: [{ role: "user", parts: [{ text }] }],
          config: {
            responseModalities: [Modality.AUDIO],
            speechConfig: {
              voiceConfig: {
                prebuiltVoiceConfig: { voiceName: options.voiceName },
              },
            },
            abortSignal: request.signal,
            httpOptions: {
              timeout: TIMEOUT_MS,
              retryOptions: { attempts: 1 },
            },
          },
        });
        const buffers: Buffer[] = [];
        let bytes = 0;
        let sawStop = false;
        for await (const chunk of stream) {
          request.signal.throwIfAborted();
          const blocked = chunk.promptFeedback?.blockReason;
          if (blocked && blocked !== "BLOCKED_REASON_UNSPECIFIED") {
            throw new Error("VOICE_SYNTHESIS_BLOCKED");
          }
          if ((chunk.candidates?.length ?? 0) > 1) {
            throw new Error("VOICE_SYNTHESIS_AMBIGUOUS_AUDIO");
          }
          const candidate = chunk.candidates?.[0];
          if (candidate?.finishReason && candidate.finishReason !== "STOP") {
            throw new Error("VOICE_SYNTHESIS_INCOMPLETE");
          }
          if (candidate?.finishReason === "STOP") sawStop = true;
          for (const part of candidate?.content?.parts ?? []) {
            if (part.thought || !part.inlineData?.data) continue;
            validatePcmMime(part.inlineData.mimeType);
            const data = part.inlineData.data;
            if (data.length > Math.ceil((MAX_PCM_BYTES - bytes) / 3) * 4) {
              throw new Error("VOICE_SYNTHESIS_AUDIO_TOO_LONG");
            }
            if (data.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(data)) {
              throw new Error("VOICE_SYNTHESIS_INVALID_AUDIO");
            }
            const buffer = Buffer.from(data, "base64");
            if (buffer.length % 2 !== 0) {
              throw new Error("VOICE_SYNTHESIS_INVALID_AUDIO");
            }
            bytes += buffer.length;
            if (bytes > MAX_PCM_BYTES) {
              throw new Error("VOICE_SYNTHESIS_AUDIO_TOO_LONG");
            }
            buffers.push(buffer);
          }
        }
        request.signal.throwIfAborted();
        if (!sawStop) throw new Error("VOICE_SYNTHESIS_INCOMPLETE");
        if (bytes === 0) throw new Error("VOICE_SYNTHESIS_EMPTY_AUDIO");
        return { pcm: Buffer.concat(buffers, bytes), sampleRate: SAMPLE_RATE };
      },
      { signal: options.signal, timeoutMs: TIMEOUT_MS },
      () => {
        request.abort();
        return new Error(
          options.signal.aborted
            ? "VOICE_SYNTHESIS_ABORTED"
            : "VOICE_SYNTHESIS_TIMEOUT",
        );
      },
    );
  } finally {
    request.abort();
  }
}
