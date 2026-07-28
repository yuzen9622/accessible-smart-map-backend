export type SupportedLang = "zh-TW" | "en";

export const SUPPORTED_LANGS: SupportedLang[] = ["zh-TW", "en"];

export const DEFAULT_LANG: SupportedLang = "zh-TW";

/**
 * Normalizes a client-supplied language tag onto the two languages the place
 * data can actually be served in. Only the primary subtag is inspected, so
 * `zh`, `zh-tw` and `zh-Hant-TW` all resolve to `zh-TW` and `en-US` to `en`.
 *
 * @param value The raw tag from the request, if any.
 * @returns The supported language, falling back to DEFAULT_LANG.
 */
export function normalizeLang(value?: string | null): SupportedLang {
  const primary = (value ?? "").trim().toLowerCase().split("-")[0];
  if (primary === "en") return "en";
  if (primary === "zh") return "zh-TW";
  return DEFAULT_LANG;
}
