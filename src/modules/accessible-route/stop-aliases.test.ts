import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AccessibleRoute, BusLeg } from "../../types/route";

const { findStopAliases } = vi.hoisted(() => ({ findStopAliases: vi.fn() }));
vi.mock("../transit/stop-alias.repository", () => ({ findStopAliases }));

import { restoreRouteStopIds } from "./stop-aliases";

function busRoute(): AccessibleRoute {
  const leg: BusLeg = {
    type: "BUS",
    routeName: "307",
    subRouteUid: "TPE157462",
    subRouteName: "307",
    departureStop: "臺北車站",
    arrivalStop: "西門",
    departureStopId: "TPE100",
    arrivalStopId: "TPE200",
    waitInfo: { time: "10:00", source: "schedule" },
    direction: 1,
    polyline: [],
    departureStopA11y: [],
    arrivalStopA11y: [],
    intermediateStops: [{ name: "中山堂", stationUid: "TPE150" }],
  };
  return {
    routeId: "otp-0",
    routeName: "307",
    totalMinutes: 20,
    transferCount: 0,
    legs: [leg],
    accessibilityHighlights: [],
  };
}

describe("restoreRouteStopIds", () => {
  beforeEach(() => {
    findStopAliases.mockReset();
  });

  it("swaps merged stop ids back to the boarding route's own stops", async () => {
    findStopAliases.mockResolvedValue(
      new Map([
        ["TPE157462_1|TPE100", "TPE101"],
        ["TPE157462_1|TPE150", "TPE151"],
      ]),
    );
    const route = busRoute();

    await restoreRouteStopIds([route]);

    const leg = route.legs[0] as BusLeg;
    expect(findStopAliases).toHaveBeenCalledWith([
      { routeId: "TPE157462_1", stopId: "TPE100" },
      { routeId: "TPE157462_1", stopId: "TPE200" },
      { routeId: "TPE157462_1", stopId: "TPE150" },
    ]);
    expect(leg.departureStopId).toBe("TPE101");
    expect(leg.arrivalStopId).toBe("TPE200");
    expect(leg.intermediateStops?.[0].stationUid).toBe("TPE151");
  });

  it("keeps the merged ids when the lookup fails", async () => {
    findStopAliases.mockRejectedValue(new Error("mongo down"));
    const route = busRoute();

    await restoreRouteStopIds([route]);

    expect((route.legs[0] as BusLeg).departureStopId).toBe("TPE100");
  });

  it("does not query for routes without bus legs", async () => {
    await restoreRouteStopIds([{ ...busRoute(), legs: [] }]);
    expect(findStopAliases).not.toHaveBeenCalled();
  });
});
