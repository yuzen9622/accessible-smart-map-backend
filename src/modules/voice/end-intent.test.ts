import { describe, expect, it } from "vitest";
import { isExplicitEndIntent } from "./end-intent";

describe("explicit voice end intent", () => {
  it.each([
    "再見",
    "好，再見。",
    "結束語音",
    "先這樣",
    "沒事了",
    "沒事了，謝謝",
    "拜拜",
    "bye",
    "可以結束語音嗎",
    "請幫我掛斷",
  ])("accepts explicit request %s", (text) => {
    expect(isExplicitEndIntent(text)).toBe(true);
  });
  it.each([
    "不要結束語音",
    "先不要結束語音",
    "別掛斷",
    "台中車站附近有什麼餐廳？",
    "可以再說一次嗎",
    "我沒事了但要找廁所",
    "再見是什麼意思",
    "再見的英文怎麼說",
    "好",
    "謝謝",
    "",
    null,
    undefined,
  ])("rejects non-end intent %s", (text) => {
    expect(isExplicitEndIntent(text)).toBe(false);
  });
});
