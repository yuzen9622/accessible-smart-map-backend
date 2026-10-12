import type { SupportedLang } from "../types/lang";

/**
 * Selects a source-backed display string without changing its canonical value.
 * Missing/blank English falls back verbatim; source language is never guessed
 * from script, and this helper must not be used to form matching keys or IDs.
 */
export function selectDisplayText(
  canonical: string,
  english: unknown,
  language?: SupportedLang,
): string {
  if (language === "en" && typeof english === "string" && english.trim()) {
    return english.trim();
  }
  return canonical;
}
