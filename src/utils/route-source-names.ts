import type { SupportedLang } from "../types/lang";
import type { WalkLeg, WalkStepStreetName } from "../types/route";
import { selectDisplayText } from "./source-display";

/** Copy presentation fields without losing hidden schedule metadata. */
export function copyWithDescriptors<T extends object>(
  value: T,
  patch: Partial<NoInfer<T>>,
): T {
  return Object.defineProperties(
    { ...value, ...patch },
    Object.fromEntries(
      Object.entries(Object.getOwnPropertyDescriptors(value)).filter(
        ([, d]) => !d.enumerable,
      ),
    ),
  ) as T;
}

/** Duplicate indexes are rejected entirely, including otherwise valid entries. */
export function validStreetNames(
  leg: Pick<WalkLeg, "steps" | "stepStreetNames">,
): Map<number, WalkStepStreetName> {
  const entries = Array.isArray(leg.stepStreetNames)
    ? leg.stepStreetNames.filter((entry) => entry && typeof entry === "object")
    : [];
  const counts = new Map<number, number>();
  for (const entry of entries)
    counts.set(entry.index, (counts.get(entry.index) ?? 0) + 1);
  const valid = new Map<number, WalkStepStreetName>();
  for (const entry of entries) {
    if (
      counts.get(entry.index) !== 1 ||
      !Number.isInteger(entry.index) ||
      entry.index < 0 ||
      leg.steps?.[entry.index]?.streetName !== entry.streetName ||
      typeof entry.nameEn !== "string" ||
      !entry.nameEn.trim()
    )
      continue;
    valid.set(entry.index, entry);
  }
  return valid;
}

export function presentStreetNames(
  leg: WalkLeg,
  language?: SupportedLang,
): WalkStepStreetName[] {
  return [...validStreetNames(leg).values()].map((entry) => ({
    ...entry,
    displayName: selectDisplayText(entry.streetName, entry.nameEn, language),
  }));
}
