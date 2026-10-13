import { describe, expect, it } from "vitest";
import {
  containsObjectionableText,
  isAcceptableText,
} from "./content-safety.text-filter";

describe("containsObjectionableText", () => {
  it.each([
    "這家店員工是智障",
    "靠 北 電梯又壞了",
    "幹.你.娘",
    "what the FUCK is this ramp",
    "staff called me a retard",
    "ｆｕｃｋ",
    "雞​掰",
  ])("rejects %s", (text) => {
    expect(containsObjectionableText(text)).toBe(true);
  });

  it.each([
    "電梯在主幹道旁，入口有坡道",
    "幹線公車站有無障礙月台",
    "Dickson Street entrance is step-free",
    "Scunthorpe station has an elevator",
    "廁所空間寬敞，扶手穩固",
    "",
  ])("accepts %s", (text) => {
    expect(containsObjectionableText(text)).toBe(false);
  });
});

describe("isAcceptableText", () => {
  it("treats a missing field as acceptable", () => {
    expect(isAcceptableText(undefined)).toBe(true);
  });

  it("rejects objectionable text", () => {
    expect(isAcceptableText("去死")).toBe(false);
  });
});
