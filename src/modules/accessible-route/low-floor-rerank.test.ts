import { describe, expect, it } from "vitest";
import { rerankByLowFloor } from "./low-floor-rerank";
import type { AccessibleRoute, BusLeg, MetroLeg } from "../../types/route";

function busLeg(isLowFloor?: boolean): BusLeg {
  const leg: BusLeg = {
    type: "BUS",
    routeName: "299",
    subRouteUid: "29901",
    subRouteName: "299",
    departureStop: "起站",
    arrivalStop: "終站",
    waitInfo: { time: 5, source: "schedule" },
    direction: 0,
    polyline: [],
    departureStopA11y: [],
    arrivalStopA11y: [],
  };
  if (isLowFloor !== undefined) leg.isLowFloor = isLowFloor;
  return leg;
}

function metroLeg(): MetroLeg {
  return {
    type: "METRO",
    railSystem: "TRTC",
    lineId: "R",
    lineName: "淡水信義線",
    departureStation: "市政府",
    arrivalStation: "台北車站",
    departureStationId: "R10",
    arrivalStationId: "R11",
    waitInfo: { time: 3, source: "schedule" },
    polyline: [],
    departureStationA11y: [],
    arrivalStationA11y: [],
  } as unknown as MetroLeg;
}

function route(
  routeId: string,
  totalMinutes: number,
  leg: BusLeg | MetroLeg,
  overrides: Partial<AccessibleRoute> = {},
): AccessibleRoute {
  return {
    routeId,
    routeName: routeId,
    totalMinutes,
    transferCount: 0,
    legs: [leg],
    accessibilityHighlights: [],
    accessibilityScore: 80,
    totalWalkDistanceM: 200,
    ...overrides,
  };
}

describe("rerankByLowFloor", () => {
  it("promotes a confirmed low-floor boarding over a high-floor one at equal cost", () => {
    const a = route("A", 30, busLeg(false));
    const b = route("B", 30, busLeg(true));
    const routes = [a, b];

    rerankByLowFloor(routes, "wheelchair");

    expect(routes.map((r) => r.routeId)).toEqual(["B", "A"]);
  });

  it("cannot overturn a route that is 15 minutes slower", () => {
    const b = route("B", 30, busLeg(false));
    const a = route("A", 45, busLeg(true));
    const routes = [b, a];

    rerankByLowFloor(routes, "wheelchair");

    expect(routes.map((r) => r.routeId)).toEqual(["B", "A"]);
  });

  it("ranks unknown above a confirmed high-floor boarding", () => {
    const a = route("A", 30, busLeg(undefined));
    const b = route("B", 30, busLeg(false));
    const routes = [b, a];

    rerankByLowFloor(routes, "wheelchair");

    expect(routes.map((r) => r.routeId)).toEqual(["A", "B"]);
  });

  it("ranks unknown below a confirmed low-floor boarding", () => {
    const a = route("A", 30, busLeg(undefined));
    const b = route("B", 30, busLeg(true));
    const routes = [a, b];

    rerankByLowFloor(routes, "wheelchair");

    expect(routes.map((r) => r.routeId)).toEqual(["B", "A"]);
  });

  it("does not let a low-floor bus overtake a slightly faster metro boarding", () => {
    const a = route("A", 30, metroLeg());
    const b = route("B", 31, busLeg(true));
    const routes = [a, b];

    rerankByLowFloor(routes, "wheelchair");

    expect(routes.map((r) => r.routeId)).toEqual(["A", "B"]);
  });

  it("denies the credit to a route with a confirmed blocking hazard", () => {
    // Without the hazard A's low-floor credit (4) would beat its 2-minute
    // deficit and pull it to index 0; the hazard must keep it behind B.
    const a = route("A", 32, busLeg(true), {
      hazardAdvisory: {
        onRoute: [],
        avoided: [],
        blockingOnRoute: 1,
        penaltyPoints: 0,
      },
    });
    const b = route("B", 30, busLeg(false));
    const routes = [b, a];

    rerankByLowFloor(routes, "wheelchair");

    expect(routes.map((r) => r.routeId)).toEqual(["B", "A"]);
  });

  it("lets the same route win once the blocking hazard is gone", () => {
    const a = route("A", 32, busLeg(true));
    const b = route("B", 30, busLeg(false));
    const routes = [b, a];

    rerankByLowFloor(routes, "wheelchair");

    expect(routes.map((r) => r.routeId)).toEqual(["A", "B"]);
  });

  describe("preconditions leave the order untouched", () => {
    it("skips a single route", () => {
      const routes = [route("A", 30, busLeg(true))];
      rerankByLowFloor(routes, "wheelchair");
      expect(routes.map((r) => r.routeId)).toEqual(["A"]);
    });

    it("skips when any route is future-scheduled", () => {
      const routes = [
        route("A", 40, busLeg(false), { _isFutureScheduled: true }),
        route("B", 30, busLeg(true)),
      ];
      rerankByLowFloor(routes, "wheelchair");
      expect(routes.map((r) => r.routeId)).toEqual(["A", "B"]);
    });

    it("skips when scoring has not run", () => {
      const routes = [
        route("A", 40, busLeg(false), { accessibilityScore: undefined }),
        route("B", 30, busLeg(true)),
      ];
      rerankByLowFloor(routes, "wheelchair");
      expect(routes.map((r) => r.routeId)).toEqual(["A", "B"]);
    });

    it("skips when no route carries real low-floor evidence", () => {
      const routes = [
        route("A", 40, busLeg(undefined)),
        route("B", 30, busLeg(undefined)),
      ];
      rerankByLowFloor(routes, "wheelchair");
      expect(routes.map((r) => r.routeId)).toEqual(["A", "B"]);
    });
  });

  it("reorders the caller's array in place", () => {
    const a = route("A", 30, busLeg(false));
    const b = route("B", 30, busLeg(true));
    const routes = [a, b];

    const result = rerankByLowFloor(routes, "wheelchair");

    expect(result).toBeUndefined();
    expect(routes[0]).toBe(b);
    expect(routes[1]).toBe(a);
  });

  it("is stable across fully tied routes", () => {
    const a = route("A", 30, busLeg(true));
    const b = route("B", 30, busLeg(true));
    const c = route("C", 30, busLeg(true));
    const routes = [a, b, c];

    rerankByLowFloor(routes, "wheelchair");

    expect(routes.map((r) => r.routeId)).toEqual(["A", "B", "C"]);
  });
});

it("keeps the requested transit preference when applying boarding credits", () => {
  const bus = route("bus", 30, { ...busLeg(true), rideMinutes: 20 });
  const metro = route("metro", 29, { ...metroLeg(), rideMinutes: 20 });
  const routes = [bus, metro];
  rerankByLowFloor(routes, "wheelchair", "bus");
  expect(routes.map((r) => r.routeId)).toEqual(["bus", "metro"]);
  rerankByLowFloor(routes, "wheelchair", "none");
  expect(routes.map((r) => r.routeId)).toEqual(["metro", "bus"]);
});

describe("rerankByLowFloor with route low-floor history", () => {
  function onRoute(subRouteUid: string, isLowFloor?: boolean): BusLeg {
    return { ...busLeg(isLowFloor), subRouteUid };
  }
  const history = (
    entries: [string, number, number, number][],
  ): Map<string, import("../../types").RouteLowFloorEvidence> =>
    new Map(
      entries.map(([sub, distinctPlates, knownTypePlates, lowFloorPlates]) => [
        sub,
        {
          distinctPlates,
          knownTypePlates,
          lowFloorPlates,
          lastSeenAt: new Date(),
          sources: ["tdx-realtime"],
        },
      ]),
    );

  it("prefers the route with a mostly low-floor history when live plates are unknown", () => {
    const routes = [
      route("mostly-high", 20, onRoute("A")),
      route("mostly-low", 20, onRoute("B")),
    ];
    rerankByLowFloor(
      routes,
      "wheelchair",
      undefined,
      history([
        ["A", 10, 10, 1],
        ["B", 10, 10, 9],
      ]),
    );
    expect(routes.map((r) => r.routeId)).toEqual(["mostly-low", "mostly-high"]);
  });

  it("never lets history outrank a confirmed live plate", () => {
    const routes = [
      route("history-all-low", 20, onRoute("A")),
      route("live-low", 20, onRoute("B", true)),
    ];
    rerankByLowFloor(
      routes,
      "wheelchair",
      undefined,
      history([["A", 20, 20, 20]]),
    );
    expect(routes[0].routeId).toBe("live-low");

    const highRoutes = [
      route("live-high", 20, onRoute("C", false)),
      route("history-all-high", 20, onRoute("D")),
    ];
    rerankByLowFloor(
      highRoutes,
      "wheelchair",
      undefined,
      history([["D", 20, 20, 0]]),
    );
    expect(highRoutes[0].routeId).toBe("history-all-high");
  });

  it("ignores a history with too few plates or too many unknown car types", () => {
    const thin = [
      route("thin-high", 20, onRoute("A")),
      route("other", 20, onRoute("B")),
    ];
    rerankByLowFloor(thin, "wheelchair", undefined, history([["A", 2, 2, 0]]));
    expect(thin.map((r) => r.routeId)).toEqual(["thin-high", "other"]);

    const unknownTypes = [
      route("unknown-high", 20, onRoute("A")),
      route("other", 20, onRoute("B")),
    ];
    // 10 plates seen, only 5 with a known car type: coverage 0.5 < 0.8.
    rerankByLowFloor(
      unknownTypes,
      "wheelchair",
      undefined,
      history([["A", 10, 5, 0]]),
    );
    expect(unknownTypes.map((r) => r.routeId)).toEqual([
      "unknown-high",
      "other",
    ]);
  });

  it("keeps history a tie-breaker, not a re-scoring", () => {
    const routes = [
      route("fast-high-history", 20, onRoute("A")),
      route("slow-low-history", 40, onRoute("B")),
    ];
    rerankByLowFloor(
      routes,
      "wheelchair",
      undefined,
      history([
        ["A", 10, 10, 0],
        ["B", 10, 10, 10],
      ]),
    );
    expect(routes[0].routeId).toBe("fast-high-history");
  });
});
