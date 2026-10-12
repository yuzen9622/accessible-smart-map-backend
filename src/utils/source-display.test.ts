import { describe, expect, it } from "vitest";
import { SourceLangQuerySchema } from "../schemas/source-language.schema";
import { normalizeLang } from "../types/lang";
import { selectDisplayText } from "./source-display";

describe("source display selection", () => {
  it("changes only the display, preserving canonical text and source objects", () => {
    const source = Object.freeze({
      canonical: " 臺北車站 ",
      en: " Taipei Main Station ",
    });
    expect(selectDisplayText(source.canonical, source.en, "en")).toBe(
      "Taipei Main Station",
    );
    expect(selectDisplayText(source.canonical, source.en, "zh-TW")).toBe(
      source.canonical,
    );
    expect(selectDisplayText(source.canonical, source.en)).toBe(
      source.canonical,
    );
    expect(source.en).toBe(" Taipei Main Station ");
  });

  it.each([undefined, null, "", "   ", 12, {}, ["English"]])(
    "preserves original text for unavailable English (%j)",
    (english) => {
      expect(selectDisplayText("原始名稱", english, "en")).toBe("原始名稱");
    },
  );

  it("does not infer a source field's language from its characters", () => {
    expect(selectDisplayText("原名", "來源提供的混合 Taipei 名稱", "en")).toBe(
      "來源提供的混合 Taipei 名稱",
    );
  });
});

describe("optional source lang query", () => {
  it("does not default an omitted request", () => {
    expect(SourceLangQuerySchema.parse(undefined)).toBeUndefined();
  });
  it.each(["zh-TW", "zh-Hant-TW", "ZH-tw", "en-US", "en", "EN"])(
    "accepts the existing Places alias %s",
    (lang) => {
      const value = SourceLangQuerySchema.parse(lang);
      expect(normalizeLang(value)).toBe(
        lang.toLowerCase().startsWith("en") ? "en" : "zh-TW",
      );
    },
  );
  it.each(["", "fr", "english", "system", "en_US", " en ", null, ["en"]])(
    "rejects invalid tags (%j)",
    (lang) => {
      expect(SourceLangQuerySchema.safeParse(lang).success).toBe(false);
    },
  );
});
