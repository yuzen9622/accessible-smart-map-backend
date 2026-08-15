import { openai, model } from "../config/ai";

const AI_TIMEOUT_MS = 10_000;

const SYSTEM_PROMPT = `你是一個路況回報真實性驗證助手。你會收到一張使用者在現場即時拍攝的照片，
以及該回報所宣稱的障礙類型與（可能的）物件標籤提示。

請僅根據這張照片判斷：
1. 這是否為真實的戶外街道／人行道場景（而非截圖、室內自拍、純色圖或與路況無關的圖）？
2. 照片中是否可見與宣稱類型相符的路況障礙（obstacle 障礙物 / construction 施工 / data_error 標示或設施錯誤）？

請以 JSON 格式回傳以下欄位：
{
  "verdict": "verified" | "suspicious" | "rejected",
  "confidence": 0.0 ~ 1.0,
  "reason": "繁體中文說明（最多 100 字）"
}

判斷標準：
- verified：確為戶外路況場景，且可見與宣稱類型相符的合理障礙
- suspicious：像戶外場景但障礙不明確，或與宣稱類型不完全相符
- rejected：明顯非戶外路況場景（截圖／室內／無關），或完全看不到任何障礙`;

/**
 * Sends a single user photo plus textual hints to Gemini (via the OpenAI-compat
 * endpoint) and returns the raw model text. Mapping to a verdict is the caller's
 * job; this adapter performs I/O only.
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
  const dataUrl = `data:${mimeType};base64,${buffer.toString("base64")}`;
  const hints = [
    `宣稱障礙類型：${hazardType}`,
    description ? `使用者描述：${description}` : "",
    detectedLabels?.length ? `影像偵測標籤：${detectedLabels.join("、")}` : "",
  ]
    .filter(Boolean)
    .join("\n");

  const completion = await openai.chat.completions.create(
    {
      model,
      temperature: 0,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        {
          role: "user",
          content: [
            {
              type: "text",
              text: hints || "請判斷這張照片是否為真實路況回報。",
            },
            { type: "image_url", image_url: { url: dataUrl } },
          ],
        },
      ],
    },
    { timeout: AI_TIMEOUT_MS },
  );

  return completion.choices?.[0]?.message?.content ?? "";
}
