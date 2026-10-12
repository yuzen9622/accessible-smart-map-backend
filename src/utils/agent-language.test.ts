import { describe, expect, it } from "vitest";
import { withResponseLanguage } from "./agent-language";

describe("source display guidance in trusted language instructions", () => {
  it("does not change callers without an explicit language", () => {
    expect(withResponseLanguage("existing prompt")).toBe("existing prompt");
  });
  it.each(["en", "zh-TW"] as const)(
    "uses display names for narration but canonical values for tool arguments (%s)",
    (language) => {
      const prompt = withResponseLanguage("existing prompt", language);
      expect(prompt).toContain(`【目前介面語言偏好：${language}】`);
      expect(prompt).toContain(
        "displayName、fromDisplayName、toDisplayName、routeDisplayName",
      );
      expect(prompt).toContain("後續工具呼叫仍使用原始名稱欄位與 ID");
      expect(prompt).toContain("缺少英文來源時保留原文");
    },
  );
});
