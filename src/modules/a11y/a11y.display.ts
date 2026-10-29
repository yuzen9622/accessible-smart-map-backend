import type { SupportedLang } from "../../types/lang";
import { selectDisplayText } from "../../utils/source-display";

/** Projection after identity/geometry work; never edits source documents. */
export function displayFacility<T extends object>(
  source: T,
  lang?: SupportedLang,
  english?: unknown,
): T & {
  displayName?: string;
  displayAddress?: string;
  displaySchoolName?: string;
} {
  if (lang === undefined) return source;
  const raw = source as T & { toObject?: () => T };
  const doc = typeof raw.toObject === "function" ? raw.toObject() : source;
  const row = doc as Record<string, unknown>;
  const name = row.name ?? row["出入口電梯/無障礙坡道名稱"] ?? row.placeName;
  const tags = row.tags as Record<string, unknown> | undefined;
  const displayName = selectDisplayText(
    row.source === "campus" &&
      typeof row.displayName === "string" &&
      row.displayName.trim()
      ? row.displayName
      : typeof name === "string"
        ? name
        : "",
    english ?? tags?.["name:en"],
    lang,
  );
  return {
    ...doc,
    ...(displayName.trim() ? { displayName } : {}),
    ...(typeof row.address === "string"
      ? { displayAddress: selectDisplayText(row.address, undefined, lang) }
      : {}),
    ...(typeof row.schoolName === "string"
      ? { displaySchoolName: row.schoolName }
      : {}),
  };
}
