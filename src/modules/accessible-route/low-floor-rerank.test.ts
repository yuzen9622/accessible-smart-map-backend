import { describe, expect, it } from "vitest";
import { rerankByLowFloor } from "./low-floor-rerank";
import type { AccessibleRoute, BusLeg, MetroLeg } from "../../types/route";

function busLeg(isLowFloor?: boolean): BusLeg {
  const leg: BusLeg = {
    type: "BUS",
    routeName: "299",
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
