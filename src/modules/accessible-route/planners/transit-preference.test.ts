import { describe, expect, it } from "vitest";
import type { AccessibleRoute, TransitPreference } from "../../../types/route";
import {
  transitModeWeights,
  transitPreferencePenalty,
} from "./transit-preference";

const MODES = [
  "BUS",
  "TROLLEYBUS",
  "RAIL",
  "SUBWAY",
  "TRAM",
  "MONORAIL",
] as const;

const expected: Record<"bus" | "rail" | "metro", number[]> = {
  bus: [1, 1, 1.5, 1.5, 1.5, 1.5],
  rail: [1.5, 1.5, 1, 1.5, 1.5, 1.5],
  metro: [1.5, 1.5, 1.5, 1, 1, 1],
};

const leg = (type: string, rideMinutes?: unknown) =>
  ({ type, rideMinutes }) as unknown as AccessibleRoute["legs"][number];
const route = (...legs: AccessibleRoute["legs"]) =>
  ({ legs }) as unknown as AccessibleRoute;

describe("transitModeWeights", () => {
  it.each(["bus", "rail", "metro"] as const)(
    "gives all six OTP modes exact weights for %s",
    (preference) => {
      const weights = transitModeWeights(preference) ?? {};
      expect(MODES.map((m) => weights[m])).toEqual(expected[preference]);
      expect(Object.keys(weights).sort()).toEqual([...MODES].sort());
    },
  );
  it.each([undefined, "none"] as const)("sends no weights for %s", (p) => {
    expect(
      transitModeWeights(p as TransitPreference | undefined),
    ).toBeUndefined();
  });
});

describe("transitPreferencePenalty", () => {
  const mixed = route(
    leg("WALK", 99),
    leg("BUS", 10),
    leg("METRO", 20),
    leg("TRA", 30),
    leg("THSR", 40),
  );
  it("penalizes only non-preferred ride minutes by 0.5/minute for metro", () => {
    expect(transitPreferencePenalty(mixed, "metro")).toBe((10 + 30 + 40) * 0.5);
  });
  it("keeps bus and rail penalties unchanged and treats metro as other transit", () => {
    expect(transitPreferencePenalty(mixed, "bus")).toBe((20 + 30 + 40) * 0.5);
    expect(transitPreferencePenalty(mixed, "rail")).toBe((10 + 20) * 0.5);
  });
  it.each([undefined, "none"] as const)("is zero for %s", (p) => {
    expect(transitPreferencePenalty(mixed, p)).toBe(0);
  });
  it("ignores malformed, negative and nonfinite ride minutes", () => {
    const bad = route(
      leg("BUS", Number.NaN),
      leg("BUS", Infinity),
      leg("TRA", "20"),
      leg("THSR", -10),
      leg("BUS", undefined),
      leg("BUS", 4),
    );
    expect(transitPreferencePenalty(bad, "metro")).toBe(2);
  });
});
