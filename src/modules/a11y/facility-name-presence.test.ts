import { describe, expect, it, vi } from "vitest";
import type { IOsmA11y, IVisualA11y } from "../../types";
import type { SupportedLang } from "../../types/lang";

vi.mock("./a11y.repository", () => ({ findOsmByIds: vi.fn() }));
vi.mock("../visual-a11y/visual-a11y.repository", () => ({
  findNearbyVisualA11y: vi.fn(),
}));

import { displayFacility } from "./a11y.display";
import { findByOsmIds } from "./a11y.service";
import { findOsmByIds } from "./a11y.repository";
import { findNearby } from "../visual-a11y/visual-a11y.service";
import { findNearbyVisualA11y } from "../visual-a11y/visual-a11y.repository";

const cases = [
  { label: "English-only", name: undefined, english: " Source name " },
  { label: "empty canonical with English", name: "", english: " Source name " },
  {
    label: "blank canonical with English",
    name: "  ",
    english: " Source name ",
  },
  { label: "both absent", name: undefined, english: undefined },
  { label: "both blank", name: "", english: "  " },
  { label: "blank canonical without English", name: "  ", english: undefined },
  { label: "canonical fallback", name: " 原名 ", english: undefined },
] as const;
const languages: (SupportedLang | undefined)[] = [undefined, "en", "zh-TW"];

function expectedName(
  name: string | undefined,
  english: string | undefined,
  lang?: SupportedLang,
) {
  if (lang === undefined) return undefined;
  const selected =
    lang === "en" && english?.trim() ? english.trim() : (name ?? "");
  return selected.trim() ? selected : undefined;
}

function checkProjection(
  source: object,
  result: object & { displayName?: string },
  expected?: string,
) {
  if (expected === undefined) expect(result).not.toHaveProperty("displayName");
  else expect(result.displayName).toBe(expected);
  const { displayName: _displayName, ...canonical } = result;
  expect(canonical).toEqual(source);
  expect(source).not.toHaveProperty("displayName");
}

describe.each(languages)("source name presence (lang=%s)", (lang) => {
  it.each(cases)(
    "helper and real OSM read service: $label",
    async ({ name, english }) => {
      const source = Object.freeze({
        osmId: "12",
        name,
        tags: Object.freeze({ "name:en": english }),
      });
      const expected = expectedName(name, english, lang);
      checkProjection(source, displayFacility(source, lang), expected);
      // An explicitly supplied source English value follows the same selection.
      checkProjection(source, displayFacility(source, lang, english), expected);
      vi.mocked(findOsmByIds).mockResolvedValue([
        source,
      ] as unknown as IOsmA11y[]);
      const [result] = await findByOsmIds(["12"], lang);
      checkProjection(source, result, expected);
      if (lang === undefined) expect(result).toBe(source);
    },
  );

  it.each(cases)(
    "real visual read service: $label",
    async ({ name, english }) => {
      const source = Object.freeze({
        source: "osm",
        sourceId: "1",
        properties: Object.freeze({ name, nameEn: english }),
      });
      const rows = [source] as unknown as IVisualA11y[];
      vi.mocked(findNearbyVisualA11y).mockResolvedValue(rows);
      const result = await findNearby(25, 121.5, 500, undefined, lang);
      checkProjection(source, result[0], expectedName(name, english, lang));
      if (lang === undefined) expect(result).toBe(rows);
    },
  );
});
