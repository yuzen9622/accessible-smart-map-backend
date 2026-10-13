/**
 * Pre-publication filter for user-generated text (reviews, hazard report descriptions).
 *
 * App Store Guideline 1.2 requires a method for filtering objectionable material
 * *before* it is posted, in addition to the report/block flow handled by the
 * content-safety module after publication. This is a deliberately conservative
 * blocklist: it only rejects unambiguous profanity, slurs and harassment so that
 * legitimate accessibility feedback (e.g. 幹道, "dickson street") still passes.
 */

/** Stable message returned as the zod issue message so clients can localize it. */
export const OBJECTIONABLE_CONTENT = "OBJECTIONABLE_CONTENT";

// CJK terms are matched as substrings after normalization. Single characters
// such as 幹 are intentionally excluded because they appear in everyday words
// (幹道, 幹線, 骨幹).
const CJK_TERMS = [
  "幹你娘",
  "幹您娘",
  "幹林娘",
  "幹拎娘",
  "幹恁娘",
  "操你媽",
  "操你妈",
  "肏你",
  "你媽的",
  "你妈的",
  "他媽的",
  "他妈的",
  "靠北",
  "靠杯",
  "靠夭",
  "雞掰",
  "機掰",
  "鷄掰",
  "王八蛋",
  "賤人",
  "贱人",
  "婊子",
  "去死",
  "智障",
  "殘廢",
  "残废",
  "低能兒",
  "腦殘",
  "脑残",
];

// Latin terms are matched on whole words so substrings inside place or
// person names are not rejected.
const LATIN_TERMS = [
  "fuck",
  "fucking",
  "fucker",
  "motherfucker",
  "shit",
  "bullshit",
  "bitch",
  "cunt",
  "asshole",
  "nigger",
  "nigga",
  "faggot",
  "retard",
  "retarded",
  "whore",
  "slut",
];

const ZERO_WIDTH = /[​-‍⁠﻿]/g;
// Separators people insert to dodge filters: whitespace, punctuation, symbols.
const SEPARATORS = /[\s\p{P}\p{S}]/gu;

const LATIN_PATTERN = new RegExp(`\\b(?:${LATIN_TERMS.join("|")})\\b`, "i");

function normalize(text: string): string {
  return text.normalize("NFKC").toLowerCase().replace(ZERO_WIDTH, "");
}

export function containsObjectionableText(text: string): boolean {
  const normalized = normalize(text);
  if (LATIN_PATTERN.test(normalized)) return true;
  const compact = normalized.replace(SEPARATORS, "");
  return CJK_TERMS.some((term) => compact.includes(term));
}

/** zod refinement helper for optional free-text fields. */
export function isAcceptableText(value: string | undefined): boolean {
  return value === undefined || !containsObjectionableText(value);
}
