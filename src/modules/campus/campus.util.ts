/**
 * Shared helpers for the campus module: MOE-id ⇄ public-id conversion, name
 * normalization for fuzzy search, and school-alias generation.
 *
 * The MOE source assigns every institution/branch id in the negative signed
 * 32-bit range (`-2^31 + n`), so raw ids are always negative. The public API
 * exposes a positive `campusId` by offsetting them into `[0, 2^31)`.
 */

/** Offset that maps a raw MOE id (in `[-2^31, 0)`) to a positive public id. */
const ID_OFFSET = 2 ** 31; // 2147483648

/** Public ids are bounded to `[0, 2^31)`. */
export const PUBLIC_ID_MAX = 2 ** 31; // exclusive upper bound

/**
 * Converts a raw MOE id (negative) to a positive public id.
 * @param rawId raw MOE institution/branch id
 * @returns positive public id in `[0, 2^31)`
 */
export function toPublicId(rawId: number): number {
  return rawId + ID_OFFSET;
}

/**
 * Converts a positive public id back to the raw MOE id used in the database.
 * @param publicId positive public id
 * @returns raw MOE id (negative)
 */
export function toRawId(publicId: number): number {
  return publicId - ID_OFFSET;
}

/**
 * Normalizes a school/campus name or search keyword for fuzzy matching:
 * NFKC (full-width → half-width), whitespace removal, 臺→台 unification, and
 * lower-casing of Latin characters. Applied to both stored search fields and
 * incoming keywords so they compare on equal footing.
 * @param s raw name or keyword
 * @returns normalized string
 */
export function normalizeName(s: string): string {
  return s
    .normalize("NFKC")
    .replace(/[\s　]/g, "")
    .replace(/臺/g, "台")
    .toLowerCase();
}

/**
 * Builds the normalized searchable string for a campus (school + branch name),
 * stored as `searchName` and matched against normalized keywords.
 * @param schoolName official institution name
 * @param branchName campus/branch name
 * @returns normalized search string
 */
export function buildSearchName(
  schoolName: string,
  branchName: string,
): string {
  return normalizeName(`${schoolName}${branchName}`);
}

/**
 * Curated common abbreviations, keyed by the normalized official school name.
 * These cover irregular acronyms (e.g. 中科大, 北科大) that no rule derives
 * reliably; the algorithmic forms below handle the regular cases. Extend as
 * needed — values are normalized before storage.
 */
const CURATED_ALIASES: Record<string, string[]> = {
  國立台灣大學: ["台大"],
  國立台灣師範大學: ["台師大", "師大"],
  國立政治大學: ["政大"],
  國立成功大學: ["成大"],
  國立清華大學: ["清大"],
  國立陽明交通大學: ["陽交大", "交大"],
  國立中央大學: ["中大"],
  國立中山大學: ["中山大"],
  國立中興大學: ["興大"],
  國立中正大學: ["中正大"],
  國立台灣海洋大學: ["海大"],
  國立台北科技大學: ["北科大", "台北科大"],
  國立台灣科技大學: ["台科大"],
  國立台中科技大學: ["中科大", "台中科大"],
  國立雲林科技大學: ["雲科大"],
  國立高雄科技大學: ["高科大"],
  國立屏東科技大學: ["屏科大"],
  國立台北大學: ["北大"],
  國立高雄大學: ["高大"],
  國立東華大學: ["東華"],
  國立暨南國際大學: ["暨大"],
};

/**
 * Generates the normalized alias list for a school. Combines the curated
 * abbreviation table with rule-based forms (institution-prefix stripping and
 * 科技大學→科大 contraction) so both "台中科技大學" and "中科大" resolve.
 * @param schoolName official institution name
 * @returns unique normalized aliases (excluding the plain normalized name)
 */
export function buildAliasNames(schoolName: string): string[] {
  const base = normalizeName(schoolName);
  const set = new Set<string>();

  for (const alias of CURATED_ALIASES[base] ?? []) {
    set.add(normalizeName(alias));
  }

  const noPrefix = base.replace(/^(國立|市立|縣立|私立)/, "");
  if (noPrefix && noPrefix !== base) set.add(noPrefix);

  const contracted = noPrefix.replace(/科技大學$/, "科大");
  if (contracted !== noPrefix) set.add(contracted);

  set.delete(base);
  return [...set].filter(Boolean);
}

/**
 * Builds a Mongo filter for a city name that treats 臺 and 台 as equivalent,
 * so "台北市" matches the stored "臺北市" without a separate normalized field.
 * @param city city name from the request
 * @returns a case-anchored `$regex` filter value
 */
export function cityFilter(city: string): { $regex: string } {
  return { $regex: `^${taiwanClass(escapeRegExp(city))}$` };
}

/** Escapes regex metacharacters so user input matches literally. */
export function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Rewrites 臺/台 in an (already regex-escaped) string to the `[臺台]` class so a
 * query written with either character matches names stored with the other.
 * @param escaped a regex-escaped string
 * @returns the pattern with 臺/台 treated as interchangeable
 */
export function taiwanClass(escaped: string): string {
  return escaped.replace(/[臺台]/g, "[臺台]");
}
