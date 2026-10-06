import fs from "fs";
import path from "path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getRoutingConfig, WALK_SPEED_MPS } from "./routing";

interface CacheRequest {
  modes: string;
  walk?: { speed?: number; reluctance?: number };
  wheelchairAccessibility?: { enabled?: boolean };
}

const routerConfig = JSON.parse(
  fs.readFileSync(
    path.resolve(__dirname, "../../otp-data/router-config.json"),
    "utf8",
  ),
) as { transit: { transferCacheRequests: CacheRequest[] } };

describe("OTP transfer cache coverage", () => {
  const entries = routerConfig.transit.transferCacheRequests;

  // The backend sends walkSpeed = WALK_SPEED_MPS[mode] and wheelchair = the
  // resolved avoidStairs flag, which a profile or request can set either way
  // for every mode. Any pair missing here blocks OTP for 40 s+ on first use.
  it.each(
    Object.entries(WALK_SPEED_MPS).flatMap(([mode, speed]) =>
      [true, false].map((wheelchair) => ({ mode, speed, wheelchair })),
    ),
  )(
    "pre-warms $mode at $speed m/s with wheelchair=$wheelchair",
    ({ speed, wheelchair }) => {
      const match = entries.filter(
        (e) =>
          e.modes === "WALK" &&
          e.walk?.speed === speed &&
          (e.wheelchairAccessibility?.enabled ?? false) === wheelchair,
      );
      expect(match).toHaveLength(1);
    },
  );

  it("keeps the default request for queries that send no walk preferences", () => {
    expect(entries).toContainEqual({ modes: "WALK" });
  });

  it("never pre-warms a per-request walk reluctance the backend does not send", () => {
    expect(entries.every((e) => e.walk?.reluctance === undefined)).toBe(true);
  });
});

describe("getRoutingConfig", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("uses the documented defaults", () => {
    expect(getRoutingConfig()).toEqual({
      planBudgetMs: 45_000,
      otpNumItineraries: 8,
      otpNumItinerariesWide: 15,
      lowFloorEvidence: {
        minDistinctPlates: 5,
        maxAgeDays: 30,
        minTypeCoverage: 0.8,
      },
      fleetSightingTtlDays: 30,
    });
  });

  it("reads overrides from the environment", () => {
    vi.stubEnv("ROUTE_PLAN_BUDGET_MS", "12000");
    vi.stubEnv("LOW_FLOOR_MIN_TYPE_COVERAGE", "0.5");
    const config = getRoutingConfig();
    expect(config.planBudgetMs).toBe(12_000);
    expect(config.lowFloorEvidence.minTypeCoverage).toBe(0.5);
  });

  it.each([
    ["ROUTE_PLAN_BUDGET_MS", "-1"],
    ["ROUTE_PLAN_BUDGET_MS", "fast"],
    ["OTP_NUM_ITINERARIES", "2.5"],
    ["LOW_FLOOR_MIN_TYPE_COVERAGE", "1.5"],
    ["BUS_FLEET_SIGHTING_TTL_DAYS", "0"],
  ])(
    "rejects an invalid %s=%s instead of silently defaulting",
    (name, value) => {
      vi.stubEnv(name, value);
      expect(() => getRoutingConfig()).toThrow(`Invalid ${name}`);
    },
  );
});
