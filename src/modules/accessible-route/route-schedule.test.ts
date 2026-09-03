import { describe, it, expect } from "vitest";
import {
  attachInternalSchedule,
  retainEarliestFutureRoute,
} from "./route-schedule";
import type { AccessibleRoute } from "../../types/route";

const makeRoute = (
  id: string,
  opts: {
    isTransit?: boolean;
    isFuture?: boolean;
    departureTime?: number;
    totalMinutes?: number;
  } = {},
): AccessibleRoute => {
  const isTransit = opts.isTransit ?? true;
  const isFuture = opts.isFuture ?? false;
  const departureTime = opts.departureTime ?? 1000;
  const totalMinutes = opts.totalMinutes ?? 30;

  const route: AccessibleRoute = {
    routeId: id,
    routeName: `Route ${id}`,
    totalMinutes,
    transferCount: 0,
    legs: isTransit
      ? [
          {
            type: "WALK",
            from: "A",
            to: "B",
            distanceM: 100,
            minutesEst: 2,
            polyline: [],
            a11yFacilities: [],
            maxSlopePercent: null,
            crossings: null,
            crossingsWithCurbRamp: null,
            minPathWidthCm: null,
            surfaceType: "unknown",
            restPoints: [],
          },
          {
            type: "BUS",
            routeName: "307",
            departureStop: "Stop A",
            arrivalStop: "Stop B",
            direction: 0,
            polyline: [],
            departureStopA11y: [],
            arrivalStopA11y: [],
            waitInfo: { time: null, source: "unavailable" },
          },
        ]
      : [
          {
            type: "WALK",
            from: "A",
            to: "B",
            distanceM: 3000,
            minutesEst: 45,
            polyline: [],
            a11yFacilities: [],
            maxSlopePercent: null,
            crossings: null,
            crossingsWithCurbRamp: null,
            minPathWidthCm: null,
            surfaceType: "unknown",
            restPoints: [],
          },
        ],
    accessibilityHighlights: [],
  };

  if (isFuture) {
    attachInternalSchedule(
      route,
      departureTime,
      departureTime + totalMinutes * 60_000,
      true,
    );
  }

  return route;
};

describe("attachInternalSchedule", () => {
  it("attaches non-enumerable schedule metadata", () => {
    const route = makeRoute("r1");
    attachInternalSchedule(route, 1000, 2000, true);

    expect(route._scheduledDepartureTime).toBe(1000);
    expect(route._scheduledEndTime).toBe(2000);
    expect(route._isFutureScheduled).toBe(true);

    // Non-enumerable: should not appear in Object.keys or JSON.stringify
    expect(Object.keys(route)).not.toContain("_scheduledDepartureTime");
    expect(JSON.stringify(route)).not.toContain("_scheduledDepartureTime");
  });
});

describe("retainEarliestFutureRoute", () => {
  it("returns empty array when limit <= 0", () => {
    const r1 = makeRoute("r1");
    expect(retainEarliestFutureRoute([r1], [r1], 0)).toEqual([]);
    expect(retainEarliestFutureRoute([r1], [r1], -1)).toEqual([]);
  });

  it("maintains ranked order when immediate valid transit routes exist", () => {
    // Current transit routes available right now (e.g. daytime)
    const currentTransit1 = makeRoute("current-1", { isTransit: true });
    const currentTransit2 = makeRoute("current-2", { isTransit: true });
    // A future route (e.g. tomorrow morning 06:00)
    const futureTransit = makeRoute("future-1", {
      isTransit: true,
      isFuture: true,
      departureTime: 5000,
    });

    const ranked = [currentTransit1, currentTransit2, futureTransit];
    const candidates = [currentTransit1, currentTransit2, futureTransit];

    const result = retainEarliestFutureRoute(ranked, candidates, 3);

    // Must NOT forcibly pin the future route to index 0
    expect(result[0].routeId).toBe("current-1");
    expect(result[1].routeId).toBe("current-2");
    expect(result[2].routeId).toBe("future-1");
  });

  it("promotes earliest future transit route to index 0 when NO current transit routes exist (late night walk only)", () => {
    // Only pure walk available right now (late night after service closed)
    const lateNightWalk = makeRoute("walk-only", { isTransit: false });
    // First buses tomorrow morning
    const tomorrowBus6am = makeRoute("bus-6am", {
      isTransit: true,
      isFuture: true,
      departureTime: 6000,
    });
    const tomorrowBus7am = makeRoute("bus-7am", {
      isTransit: true,
      isFuture: true,
      departureTime: 7000,
    });

    const ranked = [lateNightWalk, tomorrowBus7am, tomorrowBus6am];
    const candidates = [lateNightWalk, tomorrowBus7am, tomorrowBus6am];

    const result = retainEarliestFutureRoute(ranked, candidates, 3);

    // Earliest future route (6am) should be promoted to index 0
    expect(result[0].routeId).toBe("bus-6am");
    expect(result.map((r) => r.routeId)).toEqual([
      "bus-6am",
      "walk-only",
      "bus-7am",
    ]);
  });

  it("puts earliest future departure at index 0 when all candidates are future scheduled", () => {
    const futureBus2 = makeRoute("f2", {
      isTransit: true,
      isFuture: true,
      departureTime: 8000,
    });
    const futureBus1 = makeRoute("f1", {
      isTransit: true,
      isFuture: true,
      departureTime: 6000,
    });
    const futureBus3 = makeRoute("f3", {
      isTransit: true,
      isFuture: true,
      departureTime: 9000,
    });

    const ranked = [futureBus2, futureBus1, futureBus3];
    const candidates = [futureBus2, futureBus1, futureBus3];

    const result = retainEarliestFutureRoute(ranked, candidates, 3);

    expect(result[0].routeId).toBe("f1");
  });

  it("respects limit parameter", () => {
    const lateNightWalk = makeRoute("walk-only", { isTransit: false });
    const tomorrowBus6am = makeRoute("bus-6am", {
      isTransit: true,
      isFuture: true,
      departureTime: 6000,
    });
    const tomorrowBus7am = makeRoute("bus-7am", {
      isTransit: true,
      isFuture: true,
      departureTime: 7000,
    });

    const ranked = [lateNightWalk, tomorrowBus7am, tomorrowBus6am];
    const candidates = [lateNightWalk, tomorrowBus7am, tomorrowBus6am];

    const result = retainEarliestFutureRoute(ranked, candidates, 2);
    expect(result).toHaveLength(2);
    expect(result[0].routeId).toBe("bus-6am");
    expect(result[1].routeId).toBe("walk-only");
  });
});
