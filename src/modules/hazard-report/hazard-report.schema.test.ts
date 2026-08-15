import { describe, expect, it } from "vitest";
import { CreateHazardReportSchema } from "./hazard-report.schema";

const BASE = {
  hazardType: "obstacle" as const,
  severity: "difficult" as const,
  latitude: 25.033,
  longitude: 121.5654,
};

describe("CreateHazardReportSchema", () => {
  it("accepts a report without expectedUntil", () => {
    expect(CreateHazardReportSchema.safeParse(BASE).success).toBe(true);
  });

  it("requires severity", () => {
    const { severity: _severity, ...rest } = BASE;
    expect(CreateHazardReportSchema.safeParse(rest).success).toBe(false);
  });

  it("rejects an unknown severity", () => {
    expect(
      CreateHazardReportSchema.safeParse({ ...BASE, severity: "catastrophic" })
        .success,
    ).toBe(false);
  });

  it("accepts an expectedUntil within the future window", () => {
    const inTenDays = new Date(Date.now() + 10 * 86_400_000).toISOString();
    expect(
      CreateHazardReportSchema.safeParse({ ...BASE, expectedUntil: inTenDays })
        .success,
    ).toBe(true);
  });

  it("rejects an expectedUntil in the past", () => {
    const yesterday = new Date(Date.now() - 86_400_000).toISOString();
    expect(
      CreateHazardReportSchema.safeParse({ ...BASE, expectedUntil: yesterday })
        .success,
    ).toBe(false);
  });

  it("rejects an expectedUntil beyond the 180-day cap", () => {
    const tooFar = new Date(Date.now() + 200 * 86_400_000).toISOString();
    expect(
      CreateHazardReportSchema.safeParse({ ...BASE, expectedUntil: tooFar })
        .success,
    ).toBe(false);
  });

  it("rejects a non-datetime string for expectedUntil", () => {
    expect(
      CreateHazardReportSchema.safeParse({
        ...BASE,
        expectedUntil: "2026-09-30",
      }).success,
    ).toBe(false);
  });
});
