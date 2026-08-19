# 前端遷移說明：語音逐字稿順序與音近校正拆分

**影響端點**：`wss://…/api/v1/voice/ws`（`transcript` 相關下行 frame）
**日期**：2026-08-18
**性質**：破壞性變更。`transcript` 新增 `utteranceId`；新增 `transcript.correction` frame；`final:true` 的 `text` 由「校正後」改為「未校正原文」。

## 修的是什麼 bug

畫面上會出現「使用者訊息重複兩則 + 助理回覆被切成兩則（看起來像被截斷）」，例如：

```
你好。                                    ← 使用者
您好！有什麼我可以幫您的嗎？無障礙路線規劃、公車到站時間，還是   ← 助理
你好。                                    ← 使用者（重複）
附近的無障礙設施查詢都可以喔。                  ← 助理（被切開的後半）
```

根因在後端事件順序，不在辨識品質。舊版的 `final:true` 要等一次音近錯字校正的 LLM 往返（最多 2.5 秒）才送出，期間助理逐字稿已經開始往前端流，於是 `final:true` 落在助理逐字稿中間；前端以 role 變化切訊息氣泡，就切出上面那四則。

## 現在的協定

`role:"user"` 的逐字稿分三種 frame，同一句話用 `utteranceId`（session 內單調遞增，如 `u1`、`u2`）串起來：

| frame                   | 欄位                                            | 時機                                                      |
| ----------------------- | ----------------------------------------------- | --------------------------------------------------------- |
| `transcript`            | `final:false`, `utteranceId`, `text`（片段）    | 說話中即時送出，同句多則                                  |
| `transcript`            | `final:true`, `utteranceId`, `text`（整句原文） | 整句結束時**立即**送出，保證早於該回合任何 `role:"model"` |
| `transcript.correction` | `utteranceId`, `text`（校正後整句）             | final 之後 0.5–2.5 秒，**只在校正結果與原文不同時**才會送 |

`role:"model"` 不變：不帶 `final`、不帶 `utteranceId`，逐段 append。

## 前端要改三件事

1. **改用 `utteranceId` 當使用者訊息的 key**：interim 累加到該 id 的元素，`final:true` 用整句取代該 id 的元素。
2. **處理 `transcript.correction`**：以 `utteranceId` 找回**已經渲染過**的那則使用者訊息，**原地取代**文字。不可 append 成新訊息；找不到就忽略。沒有實作這個型別也不會壞——只會顯示未校正原文（例如「珠北車站」不會被修成「竹北車站」）。
3. **助理訊息的邊界改用 `turn.complete`／`interrupted`**，不要用「收到使用者逐字稿」當結束訊號。barge-in 時使用者的 interim 本來就會與模型輸出正常交錯，用 role 變化切氣泡在那種情況下一樣會斷。

`interrupted` 時只結束「當前使用者字幕」，`utteranceId` 對照表**不要清**——被打斷那句的 `transcript.correction` 會在 `interrupted` 之後才到。斷線／結束 session 時才整個清空。

## 參考實作

`src/modules/voice/poc-client.html` 的 `handleTranscript()` 與 `applyTranscriptCorrection()`；完整協定見 `docs/specs/VOICE_WS_PROTOCOL.md` §3.5。
