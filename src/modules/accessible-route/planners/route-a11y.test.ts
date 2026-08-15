import { describe, it, expect } from "vitest";
import { buildAccessibilitySummary } from "./route-a11y";
import type { IOsmA11y } from "../../../types";

const node = (category: string, tags: Record<string, string> = {}): IOsmA11y =>
  ({ category, tags }) as unknown as IOsmA11y;

describe("buildAccessibilitySummary", () => {
  it("wheelchair: mentions elevator and a positive verdict when present + good label", () => {
    const s = buildAccessibilitySummary({
      mode: "wheelchair",
      walkDistanceM: 450,
      transferCount: 0,
      facilities: [node("elevator", { elevator: "yes" })],
      label: "good",
    });
    expect(s).toContain("電梯");
    expect(s).toContain("450");
    expect(s).toContain("適合輪椅通行");
  });

  it("wheelchair: flags limited info and a hard verdict when no facilities + poor label", () => {
    const s = buildAccessibilitySummary({
      mode: "wheelchair",
      walkDistanceM: 900,
      transferCount: 2,
      facilities: [],
      label: "poor",
    });
    expect(s).toContain("資訊有限");
    expect(s).toContain("通行較困難");
  });

  it("visual_impaired: mentions guidance facilities when tactile paving present", () => {
    const s = buildAccessibilitySummary({
      mode: "visual_impaired",
      walkDistanceM: 300,
      transferCount: 1,
      facilities: [node("crossing", { tactile_paving: "yes" })],
      label: "good",
    });
    expect(s).toContain("導盲");
    expect(s).toContain("轉乘 1 次");
  });

  it("elderly: emphasises walk distance and transfers", () => {
    const s = buildAccessibilitySummary({
      mode: "elderly",
      walkDistanceM: 200,
      transferCount: 0,
      facilities: [],
      label: "fair",
    });
    expect(s).toContain("步行");
    expect(s).toContain("全程直達");
  });

  it("always returns a non-empty string for every mode", () => {
    for (const mode of [
      "wheelchair",
      "elderly",
      "visual_impaired",
      "normal",
    ] as const) {
      const s = buildAccessibilitySummary({
        mode,
        walkDistanceM: 100,
        transferCount: 0,
        facilities: [],
        label: "fair",
      });
      expect(s.length).toBeGreaterThan(0);
    }
  });
});
