import { describe, expect, it } from "vitest";
import { UpdateA11yProfileBodySchema } from "./user.schema";

describe("UpdateA11yProfileBodySchema", () => {
  it("accepts an empty body (no-op update)", () => {
    expect(UpdateA11yProfileBodySchema.safeParse({}).success).toBe(true);
  });

  it("accepts a partial update with only some fields", () => {
    expect(
      UpdateA11yProfileBodySchema.safeParse({ mobilityAid: "power_wheelchair", canUseStairs: false })
        .success,
    ).toBe(true);
  });

  it("rejects an unknown mobilityAid value", () => {
    expect(UpdateA11yProfileBodySchema.safeParse({ mobilityAid: "scooter" }).success).toBe(false);
  });

  it("rejects maxSlopePercent outside 0-100", () => {
    expect(UpdateA11yProfileBodySchema.safeParse({ maxSlopePercent: -1 }).success).toBe(false);
    expect(UpdateA11yProfileBodySchema.safeParse({ maxSlopePercent: 101 }).success).toBe(false);
    expect(UpdateA11yProfileBodySchema.safeParse({ maxSlopePercent: 5 }).success).toBe(true);
  });

  it("rejects preferredFontScale outside 0.5-3", () => {
    expect(UpdateA11yProfileBodySchema.safeParse({ preferredFontScale: 0.1 }).success).toBe(false);
    expect(UpdateA11yProfileBodySchema.safeParse({ preferredFontScale: 4 }).success).toBe(false);
    expect(UpdateA11yProfileBodySchema.safeParse({ preferredFontScale: 1.25 }).success).toBe(true);
  });

  it("accepts explicit null to clear a field", () => {
    expect(UpdateA11yProfileBodySchema.safeParse({ mobilityAid: null }).success).toBe(true);
  });

  it("rejects unknown keys", () => {
    expect(UpdateA11yProfileBodySchema.safeParse({ unknownField: true }).success).toBe(false);
  });
});
