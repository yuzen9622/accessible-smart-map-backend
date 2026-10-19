import { describe, expect, it } from "vitest";
import { classifyNavigationIntent } from "./navigation-intent";

describe("server navigation authorization", () => {
  it.each([
    ["導航到台北車站", "direct"],
    ["帶我去醫院", "direct"],
    ["navigate to the station", "direct"],
    ["take me to school", "direct"],
    ["怎麼去醫院", "informational"],
    ["比較路線", "informational"],
    ["how do I get to school", "informational"],
    ["不要導航到醫院", "other"],
    ["don't navigate to school", "other"],
    ["不要停止導航", "other"],
    ["不用停止導航", "other"],
    ["我不想導航到醫院", "other"],
    ["不用導航到醫院", "other"],
    ["不需要導航到醫院", "other"],
    ["先別結束導航", "other"],
    ["我不想帶我去醫院", "other"],
    ["don't stop navigation", "other"],
    ["do not end navigation", "other"],
    ["I don't want to navigate to hospital", "other"],
    ["I do not want you to take me to school", "other"],
    ["I do not need to navigate to hospital", "other"],
    ["I don't need to stop navigation", "other"],
    ["換一條", "switch"],
    ["第二條", "switch"],
    ["好，換吧", "confirm"],
    ["yes", "confirm"],
    ["確認", "confirm"],
    ["不要換", "reject"],
    ["不用了", "reject"],
    ["no", "reject"],
    ["可以換嗎？", "other"],
    ["換第二條，確認", "switch"],
    ["停止導航", "stop"],
    ["結束導航", "stop"],
    ["開始導航", "start"],
  ])("%s -> %s", (text, kind) =>
    expect(classifyNavigationIntent(text).kind).toBe(kind),
  );
  it("preserves explicit ordinal", () =>
    expect(classifyNavigationIntent("換第三條")).toEqual({
      kind: "switch",
      candidateNumber: 3,
    }));
});
