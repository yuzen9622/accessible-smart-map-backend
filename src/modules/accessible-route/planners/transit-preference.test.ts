import { describe, expect, it } from "vitest";
import type { AccessibleRoute, TransitPreference } from "../../../types/route";
import {
  preferredOtpModes,
  reservePreferredRoute,
  routeUsesPreferredMode,
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

describe("preferredOtpModes", () => {
  it("maps each preference to the OTP modes it rides", () => {
    expect(preferredOtpModes("bus")).toEqual(["BUS", "TROLLEYBUS"]);
    expect(preferredOtpModes("rail")).toEqual(["RAIL"]);
    expect(preferredOtpModes("metro")).toEqual(["SUBWAY", "TRAM", "MONORAIL"]);
  });
  it.each([undefined, "none"] as const)("is undefined for %s", (p) => {
    expect(preferredOtpModes(p)).toBeUndefined();
  });
});

describe("routeUsesPreferredMode", () => {
  it("treats TRA and THSR as rail and leaves metro separate", () => {
    expect(routeUsesPreferredMode(route(leg("THSR")), "rail")).toBe(true);
    expect(routeUsesPreferredMode(route(leg("TRA")), "rail")).toBe(true);
    expect(routeUsesPreferredMode(route(leg("METRO")), "rail")).toBe(false);
    expect(routeUsesPreferredMode(route(leg("METRO")), "metro")).toBe(true);
    expect(routeUsesPreferredMode(route(leg("BUS")), "none")).toBe(false);
  });
});

describe("reservePreferredRoute", () => {
  const metro = () => route(leg("WALK"), leg("METRO", 39));
  const bus = () => route(leg("WALK"), leg("BUS", 67));

  it("puts the best eligible preferred route in the last slot", () => {
    const [m1, m2, m3, b1, b2] = [metro(), metro(), metro(), bus(), bus()];
    const pool = [m1, m2, m3, b1, b2];
    expect(reservePreferredRoute(pool.slice(0, 3), pool, 3, "bus")).toEqual([
      m1,
      m2,
      b1,
    ]);
    expect(
      reservePreferredRoute(pool.slice(0, 3), pool, 3, "bus", (r) => r !== b1),
    ).toEqual([m1, m2, b2]);
  });

  it("appends instead of replacing when the list is below the limit", () => {
    const [m1, b1] = [metro(), bus()];
    expect(reservePreferredRoute([m1], [m1, b1], 3, "bus")).toEqual([m1, b1]);
  });

  it("leaves the list unchanged when it already rides the mode or nothing qualifies", () => {
    const [m1, b1, m2] = [metro(), bus(), metro()];
    const hasBus = [m1, b1];
    expect(reservePreferredRoute(hasBus, [...hasBus, m2], 2, "bus")).toBe(
      hasBus,
    );
    const noBus = [m1, m2];
    expect(
      reservePreferredRoute(noBus, [...noBus, b1], 2, "bus", () => false),
    ).toBe(noBus);
    expect(reservePreferredRoute(noBus, [...noBus, b1], 2, "none")).toBe(noBus);
    expect(reservePreferredRoute([m1], [m1, b1], 1, "bus")).toEqual([m1]);
  });
});
