import { describe, it, expect, vi, beforeEach } from "vitest";
import type { AccessibleRoute } from "../../types/route";

// Mock the OTP planner so we exercise the segment fan-out + concatenation
// logic in findAccessibleRoutes without a live OTP sidecar.
vi.mock("./planners/otp-routing", () => ({
  planOtpRoute: vi.fn(),
  isOtpCircuitOpen: vi.fn(() => false),
}));

vi.mock("../environment/environment.service", () => ({
  getWeatherAndAirQuality: vi.fn().mockResolvedValue({}),
}));

import { findAccessibleRoutes } from "./accessible-route.service";
import * as otp from "./planners/otp-routing";
import { getWeatherAndAirQuality } from "../environment/environment.service";

const mockPlan = vi.mocked(otp.planOtpRoute);

const origin = { lat: 25.04, lng: 121.56 };
const waypoint = { lat: 25.05, lng: 121.55 };
const destination = { lat: 25.03, lng: 121.57 };

function walkOnlySegment(id: string, minutes: number): AccessibleRoute {
  return {
    routeId: id,
    routeName: id,
    totalMinutes: minutes,
    transferCount: 1,
    legs: [
      {
        type: "WALK",
        from: "a",
        to: "b",
        distanceM: 100,
        minutesEst: minutes,
        polyline: [],
        a11yFacilities: [],
      },
    ],
    accessibilityHighlights: [],
  };
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(otp.isOtpCircuitOpen).mockReturnValue(false);
  vi.mocked(getWeatherAndAirQuality).mockResolvedValue({});
});

describe("findAccessibleRoutes transit waypoint chaining", () => {
  it("plans segments sequentially, propagating arrival time to the next segment", async () => {
    const departureTime = new Date("2030-01-01T10:00:00Z");
    mockPlan
      .mockResolvedValueOnce([walkOnlySegment("seg1", 10)])
      .mockResolvedValueOnce([walkOnlySegment("seg2", 12)]);

    const routes = await findAccessibleRoutes(origin, destination, "Taipei" as any, {
      waypoints: [waypoint],
      departureTime,
    });

    // origin→waypoint, waypoint→destination
    expect(mockPlan).toHaveBeenCalledTimes(2);
    expect(mockPlan.mock.calls[0][0]).toEqual(origin);
    expect(mockPlan.mock.calls[0][1]).toEqual(waypoint);
    expect(mockPlan.mock.calls[1][0]).toEqual(waypoint);
    expect(mockPlan.mock.calls[1][1]).toEqual(destination);
    expect(mockPlan.mock.calls[0][2]).toMatchObject({ limit: 1 });

    // segment 1 departs at the requested time; segment 2 departs 10 min later
    // (seg1.totalMinutes) — NOT at the origin time.
    expect(mockPlan.mock.calls[0][2]!.departureTime).toEqual(departureTime);
    expect(mockPlan.mock.calls[1][2]!.departureTime).toEqual(
      new Date(departureTime.getTime() + 10 * 60_000),
    );

    expect(routes).toHaveLength(1);
    expect(routes[0].totalMinutes).toBe(22); // 10 + 12
    expect(routes[0].transferCount).toBe(2); // 1 + 1
    // the two boundary WALK legs are merged into one (no double-walk seam)
    expect(routes[0].legs).toHaveLength(1);
    const walk = routes[0].legs[0] as any;
    expect(walk.type).toBe("WALK");
    expect(walk.distanceM).toBe(200); // 100 + 100
    expect(walk.minutesEst).toBe(22); // 10 + 12
  });

  it("merges adjacent WALK legs across multiple waypoints", async () => {
    mockPlan
      .mockResolvedValueOnce([walkOnlySegment("s1", 5)])
      .mockResolvedValueOnce([walkOnlySegment("s2", 6)])
      .mockResolvedValueOnce([walkOnlySegment("s3", 7)]);

    const routes = await findAccessibleRoutes(origin, destination, "Taipei" as any, {
      waypoints: [waypoint, { lat: 25.06, lng: 121.54 }],
    });

    expect(mockPlan).toHaveBeenCalledTimes(3);
    expect(routes[0].legs).toHaveLength(1); // three walk segments collapse to one
    expect((routes[0].legs[0] as any).distanceM).toBe(300);
    expect(routes[0].totalMinutes).toBe(18); // 5 + 6 + 7
  });

  it("returns [] when any segment has no route", async () => {
    mockPlan
      .mockResolvedValueOnce([walkOnlySegment("seg1", 10)])
      .mockResolvedValueOnce([]); // second segment unroutable

    const routes = await findAccessibleRoutes(origin, destination, "Taipei" as any, {
      waypoints: [waypoint],
    });

    expect(routes).toEqual([]);
  });

  it("uses a single OTP query when there are no waypoints (unchanged path)", async () => {
    mockPlan.mockResolvedValueOnce([walkOnlySegment("direct", 15)]);

    const routes = await findAccessibleRoutes(origin, destination, "Taipei" as any, {});

    expect(mockPlan).toHaveBeenCalledTimes(1);
    expect(routes).toHaveLength(1);
    expect(routes[0].totalMinutes).toBe(15);
  });
});
