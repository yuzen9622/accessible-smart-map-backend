import { googleGenAi, model } from "../config/ai";
import { withDeadline } from "../utils/with-deadline";

const TRANSCRIBE_INSTRUCTION =
  "把這段語音逐字轉成繁體中文文字（台灣用語）。只輸出聽到的內容，不要回答、不要補充、不要加引號。若聽不清楚或沒有人聲，輸出空字串。";

/**
 * One bounded speech-to-text call. The transcript is user input, never an
 * instruction to this call, and the audio itself is not stored.
 *
 * @param audio The audio bytes.
 * @param mimeType The audio MIME type (LINE voice messages are AAC in MP4).
 * @param timeoutMs Give up after this long.
 * @returns The trimmed transcript; empty when nothing intelligible was heard.
 */
export async function transcribeAudio(
  audio: Buffer,
  mimeType: string,
  timeoutMs: number,
): Promise<string> {
  const response = await withDeadline(
    () =>
      googleGenAi.models.generateContent({
        model,
        contents: [
          {
            role: "user",
            parts: [
              { inlineData: { mimeType, data: audio.toString("base64") } },
            ],
          },
        ],
        config: {
          systemInstruction: TRANSCRIBE_INSTRUCTION,
          temperature: 0,
          httpOptions: { timeout: timeoutMs, retryOptions: { attempts: 1 } },
        },
      }),
    { timeoutMs },
    () => new Error("AUDIO_TRANSCRIBE_TIMEOUT"),
  );
  return (response.candidates?.[0]?.content?.parts ?? [])
    .filter((part) => !part.thought && typeof part.text === "string")
    .map((part) => part.text)
    .join("")
    .trim();
}
