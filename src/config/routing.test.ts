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

  // Keep both wheelchair flags warm for every supported walking speed.
  // A cold speed/flag pair blocks OTP while its transfer cache is built.
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
      walkPlanner: "csr",
      planBudgetMs: 45_000,
      otpNumItineraries: 8,
      otpNumItinerariesWide: 15,
      lowFloorEvidence: {
        minDistinctPlates: 5,
        maxAgeDays: 30,
        minTypeCoverage: 0.8,
      },
      fleetSightingTtlDays: 30,
      venue: {
        stairsAvoidanceMultiplier: 4,
        elevatorWaitS: 30,
        elevatorPerFloorS: 3,
      },
    });
  });

  it.each(["csr", "otp"] as const)(
    "selects the %s walking planner",
    (planner) => {
      vi.stubEnv("ROUTE_WALK_PLANNER", planner);
      expect(getRoutingConfig().walkPlanner).toBe(planner);
    },
  );

  it("reads overrides from the environment", () => {
    vi.stubEnv("ROUTE_PLAN_BUDGET_MS", "12000");
    vi.stubEnv("LOW_FLOOR_MIN_TYPE_COVERAGE", "0.5");
    vi.stubEnv("VENUE_STAIRS_AVOIDANCE_MULTIPLIER", "1");
    vi.stubEnv("VENUE_ELEVATOR_WAIT_S", "45.5");
    const config = getRoutingConfig();
    expect(config.planBudgetMs).toBe(12_000);
    expect(config.lowFloorEvidence.minTypeCoverage).toBe(0.5);
    expect(config.venue.stairsAvoidanceMultiplier).toBe(1);
    expect(config.venue.elevatorWaitS).toBe(45.5);
  });

  it.each([
    ["ROUTE_WALK_PLANNER", "other"],
    ["ROUTE_PLAN_BUDGET_MS", "-1"],
    ["ROUTE_PLAN_BUDGET_MS", "fast"],
    ["OTP_NUM_ITINERARIES", "2.5"],
    ["LOW_FLOOR_MIN_TYPE_COVERAGE", "1.5"],
    ["BUS_FLEET_SIGHTING_TTL_DAYS", "0"],
    ["VENUE_STAIRS_AVOIDANCE_MULTIPLIER", "0.5"],
    ["VENUE_STAIRS_AVOIDANCE_MULTIPLIER", "Infinity"],
    ["VENUE_ELEVATOR_WAIT_S", "0"],
    ["VENUE_ELEVATOR_PER_FLOOR_S", "-3"],
    // finite but large enough to overflow a weighted stair edge to Infinity
    ["VENUE_STAIRS_AVOIDANCE_MULTIPLIER", "1e308"],
    ["VENUE_STAIRS_AVOIDANCE_MULTIPLIER", "101"],
    ["VENUE_ELEVATOR_WAIT_S", "601"],
    ["VENUE_ELEVATOR_PER_FLOOR_S", "1e308"],
  ])(
    "rejects an invalid %s=%s instead of silently defaulting",
    (name, value) => {
      vi.stubEnv(name, value);
      expect(() => getRoutingConfig()).toThrow(`Invalid ${name}`);
    },
  );
});
