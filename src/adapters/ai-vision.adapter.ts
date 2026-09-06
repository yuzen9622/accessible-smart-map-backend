import { googleGenAi, model } from "../config/ai";
import { hazardVerifyConfig } from "../config/ai/config";
import { hazardVerifyContents } from "../config/ai/contents";

const AI_TIMEOUT_MS = 10_000;

/**
 * Sends a single user photo plus textual hints to Gemini via the native
 * `@google/genai` client and returns the raw model text. Mapping to a verdict
 * is the caller's job; this adapter performs I/O only.
 *
 * @param buffer Raw photo bytes.
 * @param mimeType The photo MIME type.
 * @param hazardType The claimed hazard type.
 * @param description Optional free-text description from the reporter.
 * @param detectedLabels Optional Cloud Vision labels used as hints.
 * @returns The raw model response text.
 */
export async function verifyImageWithGemini(
  buffer: Buffer,
  mimeType: string,
  hazardType: string,
  description: string | undefined,
  detectedLabels: string[] | undefined,
): Promise<string> {
  const hints = [
    `宣稱障礙類型：${hazardType}`,
    description ? `使用者描述：${description}` : "",
    detectedLabels?.length ? `影像偵測標籤：${detectedLabels.join("、")}` : "",
  ]
    .filter(Boolean)
    .join("\n");

  const response = await googleGenAi.models.generateContent({
    model,
    contents: [
      ...hazardVerifyContents,
      {
        role: "user",
        parts: [
          { text: hints || "請判斷這張照片是否為真實路況回報。" },
          { inlineData: { mimeType, data: buffer.toString("base64") } },
        ],
      },
    ],
    config: { ...hazardVerifyConfig, httpOptions: { timeout: AI_TIMEOUT_MS } },
  });

  return response?.candidates?.[0]?.content?.parts?.[0]?.text ?? "";
}
