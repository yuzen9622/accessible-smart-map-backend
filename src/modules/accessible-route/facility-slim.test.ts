import { describe, expect, it } from "vitest";
import { slimFacility } from "./facility-slim";
import type { IOsmA11y } from "../../types";

const baseFacility: IOsmA11y = {
  _id: "1",
  osmId: "way/1",
  category: "wheelchair_accessible",
  location: { type: "Point", coordinates: [121.5, 25.03] },
  importedAt: new Date(),
} as unknown as IOsmA11y;

describe("slimFacility", () => {
  it("keeps the handrail tag, so a downstream stairs/handrail check can still see it after slimming", () => {
    const slim = slimFacility({
      ...baseFacility,
      tags: { highway: "steps", handrail: "yes", some_unrelated_tag: "x" },
    });

    expect(slim.tags).toEqual({ highway: "steps", handrail: "yes" });
  });
});
