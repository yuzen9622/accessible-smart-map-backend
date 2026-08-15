import { describe, it, expect } from "vitest";
import {
  buildAliasNames,
  buildSearchName,
  cityFilter,
  normalizeName,
  taiwanClass,
  toPublicId,
  toRawId,
} from "./campus.util";

describe("normalizeName", () => {
  it("unifies 臺 to 台", () => {
    expect(normalizeName("國立臺中科技大學")).toBe("國立台中科技大學");
  });

  it("strips whitespace (incl. full-width) and lowercases latin", () => {
    expect(normalizeName("  Ｎ Ｔ ＵＴ  ")).toBe("ntut");
    expect(normalizeName("台大 校總區")).toBe("台大校總區");
  });
});

describe("toPublicId / toRawId", () => {
  it("maps negative MOE ids to compact positive ids", () => {
    expect(toPublicId(-2147483619)).toBe(29);
    expect(toPublicId(-2147473183)).toBe(10465);
  });

  it("round-trips", () => {
    for (const raw of [-2147483619, -2147473183, -2147483648, -1]) {
      expect(toRawId(toPublicId(raw))).toBe(raw);
    }
  });

  it("keeps public ids within [0, 2^31)", () => {
    expect(toPublicId(-2147483648)).toBe(0);
    expect(toPublicId(-1)).toBeLessThan(2 ** 31);
  });
});

describe("buildSearchName", () => {
  it("concatenates and normalizes school + branch", () => {
    expect(buildSearchName("國立臺中科技大學", "三民校區")).toBe(
      "國立台中科技大學三民校區",
    );
  });
});

describe("buildAliasNames", () => {
  it("produces the common abbreviation for 臺中科技大學", () => {
    const aliases = buildAliasNames("國立臺中科技大學");
    expect(aliases).toContain("中科大");
    expect(aliases).toContain("台中科大");
    expect(aliases).toContain("台中科技大學");
  });

  it("does not include the plain normalized name", () => {
    expect(buildAliasNames("國立臺中科技大學")).not.toContain(
      "國立台中科技大學",
    );
  });
});

describe("cityFilter / taiwanClass", () => {
  it("matches 台/臺 interchangeably", () => {
    const { $regex } = cityFilter("台北市");
    expect(new RegExp($regex).test("臺北市")).toBe(true);
    expect(new RegExp($regex).test("台北市")).toBe(true);
    expect(new RegExp($regex).test("新北市")).toBe(false);
  });

  it("taiwanClass rewrites both characters to the class", () => {
    expect(taiwanClass("台中")).toBe("[臺台]中");
    expect(taiwanClass("臺南")).toBe("[臺台]南");
  });
});
