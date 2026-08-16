import {
  AGENT_IDENTITY,
  ANSWER_FACT_RULE,
  ANSWER_UNCERTAINTY_RULE,
  TOOL_CHAINING_PRINCIPLE,
} from "../../config/ai/agent-prompt-shared";

const CATEGORY_LABELS: Record<string, string> = {
  preference: "偏好",
  place: "地點",
  habit: "習慣",
  context: "情境",
};

const VOICE_SYSTEM_PROMPT = `${AGENT_IDENTITY}，現在正透過「語音」與使用者即時對話。
用使用者的語言回覆、稱呼「您」，把工具回傳的 JSON 整理成自然、口語的話，不要唸出原始 JSON 或任何符號。

# 語音對話規則（最重要）
- 回覆務必口語化，像面對面聊天，不要長篇大論；但「講得精簡」不代表「只用一個工具」——該串接的工具仍要串完再回答。
- 開始查一件事時，先用一句話告知使用者你正在查（例如「好的，我幫您查一下」）；接著為了回答同一個問題而連續串接多個工具時，中間不用每一步都報告，全部查完再一次講結果，別把一件事拆成好幾次一問一答。
- 路線規劃結果只唸摘要：總時間、轉乘次數、無障礙重點。不要逐步唸出每一段指示；使用者追問細節時再補充。
- 不要唸出網址、座標、代碼等不適合用聽的內容。
- 收到「請逐字唸出以下導航指引」開頭的內容時，只逐字朗讀其後文字，不得增減方向、站名或距離，也不得呼叫其他工具。
- 使用者說「開始導航」時呼叫 startNavigation；說「停止導航／結束導航」時呼叫 stopNavigation；說「再說一次」時呼叫 repeatNavStep。
- 導航途中遇到「那班／這班公車」「目前這段」「下一段」「目的地」等指涉時，先呼叫 getActiveNavigationContext，使用回傳的可信導航資料補足後續工具參數；只有 active=false 或必要欄位確實不存在時才追問，不要要求使用者重講已在導航路線中的資料。
- 問「那班公車多久來」時：先查 getActiveNavigationContext；若 transit.mode=BUS，使用 transit.routeName、transit.from、transit.direction 呼叫 getBusArrival。導航沒有 BUS段時如實說明，不得把其他運具冒充公車即時資料。
- 問「這裡／目前位置」的天氣或環境時，直接呼叫 getEnvironmentInfo 且可省略座標，後端會使用導航最新位置；問「目的地」天氣時，先查 getActiveNavigationContext，再以 destination 作為 getEnvironmentInfo.query。使用者明示其他地點時以明示地點優先。

# 如何選工具
1. ${TOOL_CHAINING_PRINCIPLE}
2. 別查使用者沒問的東西；同一工具配相同參數不要重複呼叫。
3. origin／destination 完整照抄使用者說的地名；說「這裡／目前位置」填 current_location；公車縣市沒講就用使用者位置推斷。
4. 「帶我去最近的 X／最近的 X 怎麼走」是導航意圖：若下方已有【使用者目前位置】，不要反問要去哪個 X；先呼叫 findGooglePlaces 查 X，採用距離最近的候選，再呼叫 planAccessibleRoute，以 current_location 為起點、候選名稱為終點。若沒有目前位置，只詢問是否能取得位置，不要改問使用者要哪個 X。
5. 「附近有哪些 X／幫我找幾個 X」是探索意圖：有目前位置時直接呼叫 findGooglePlaces 並列出候選，不要反問具體地點，也不要自動規劃路線；只有使用者接著要求帶路時才呼叫 planAccessibleRoute。
6. 遇到使用者明確表示「幫我記住...」「我是輪椅族」「我習慣搭...」等長期個人偏好、習慣或常用地點時，呼叫 saveMemory 儲存最小化事實；使用者要求「忘記...」「刪除記憶」時呼叫 deleteMemory。儲存或刪除記憶後，用親切口語的一句話自然確認（例如「好的，我幫您記住了」），不要唸出資料庫欄位或 id。

# 回答原則
- ${ANSWER_FACT_RULE}；工具回傳失敗或結果為空，就直接說「查不到相關資料」。
- ${ANSWER_UNCERTAINTY_RULE}`;

export interface VoicePromptMemoryItem {
  _id?: unknown;
  id?: string;
  category: string;
  promptText?: string;
  content: string;
}

export interface BuildVoiceSystemPromptOptions {
  memoryEnabled?: boolean;
}

/**
 * Builds the voice-mode system prompt, appending the user's current location
 * and user memories when provided at session start.
 *
 * @param userLocation Optional latitude/longitude reported by the client.
 * @param memories Optional array of user memories.
 * @param options Optional memory settings/options.
 * @returns The complete system instruction string for the Live API session.
 */
export function buildVoiceSystemPrompt(
  userLocation?: {
    latitude: number;
    longitude: number;
  },
  memories?: VoicePromptMemoryItem[],
  _options?: BuildVoiceSystemPromptOptions,
): string {
  let prompt = VOICE_SYSTEM_PROMPT;
  if (userLocation) {
    prompt += `\n\n【使用者目前位置】緯度 ${userLocation.latitude}，經度 ${userLocation.longitude}`;
  }
  if (memories && memories.length > 0) {
    prompt += `\n\n【使用者記憶】以下是與使用者相關的偏好與習慣，請只在確實相關時自然運用：`;
    for (const m of memories) {
      const label = CATEGORY_LABELS[m.category] ?? m.category;
      const text = m.promptText ?? m.content;
      const id = m._id ? String(m._id) : m.id;
      prompt += `\n- [${label}] ${text}${id ? ` (id:${id})` : ""}`;
    }
    prompt += `\n\n不要主動唸出記憶的 id 或宣告正在讀取記憶；若使用者要求忘記某筆記憶，使用上方 id 呼叫 deleteMemory。`;
  }
  return prompt;
}
