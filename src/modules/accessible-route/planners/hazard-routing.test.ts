import { describe, expect, it } from "vitest";
import { ROUTE_WARNING } from "../../../constants/messages";
import type { AccessibleRoute, BusLeg, WalkLeg } from "../../../types/route";
import { attachInternalSchedule } from "../route-schedule";
import {
  HAZARD_ROUTE_CORRIDOR_M,
  MAX_HAZARD_QUERY_RADIUS_M,
  buildHazardQueryArea,
  matchConfirmedHazardsToRoute,
  planConfirmedHazardRoutes,
  pointToSegmentDistanceM,
  type ConfirmedHazardInput,
} from "./hazard-routing";

const walkLeg = (polyline: [number, number][]): WalkLeg => ({
  type: "WALK",
  from: "起點",
  to: "終點",
  distanceM: 120,
  minutesEst: 2,
  polyline,
  a11yFacilities: [],
  maxSlopePercent: null,
  crossings: null,
  crossingsWithCurbRamp: null,
  minPathWidthCm: null,
  surfaceType: "unknown",
  restPoints: [],
});

const walkRoute = (
  routeId: string,
  polyline: [number, number][],
): AccessibleRoute => ({
  routeId,
  routeName: routeId,
  totalMinutes: 10,
  transferCount: 0,
  legs: [walkLeg(polyline)],
  accessibilityHighlights: [],
});

const hazard = (
  id: string,
  coordinates: [number, number],
  severity: ConfirmedHazardInput["severity"] = "blocking",
): ConfirmedHazardInput => ({
  id,
  hazardType: "construction",
  severity,
  description: "人行道施工中",
  coordinates,
});

describe("confirmed hazard ground-geometry matching", () => {
  it("uses actual point-to-segment distance inside the small corridor", () => {
    const route = walkRoute("on-line", [
      [121, 25],
      [121.001, 25],
    ]);
    const onRouteHazard = hazard("h-on", [121.0005, 25.0001]);

    expect(
      pointToSegmentDistanceM(
        onRouteHazard.coordinates,
        route.legs[0].polyline[0],
        route.legs[0].polyline[1],
      ),
    ).toBeLessThan(HAZARD_ROUTE_CORRIDOR_M);
    expect(matchConfirmedHazardsToRoute(route, [onRouteHazard])).toMatchObject([
      { id: "h-on", severity: "blocking" },
    ]);
  });

  it("does not treat a diagonal polyline bounding box as an intersection", () => {
    const route = walkRoute("diagonal", [
      [121, 25],
      [121.001, 25.001],
    ]);
    // This point lies inside the segment's lat/lng bounding box but is roughly
    // 80 m away from the diagonal itself, so a bounding-box implementation
    // would be a false positive.
    const offLineHazard = hazard("h-off", [121, 25.001]);

    expect(
      pointToSegmentDistanceM(
        offLineHazard.coordinates,
        route.legs[0].polyline[0],
        route.legs[0].polyline[1],
      ),
    ).toBeGreaterThan(HAZARD_ROUTE_CORRIDOR_M);
    expect(matchConfirmedHazardsToRoute(route, [offLineHazard])).toEqual([]);
  });

  it("ignores transit-leg geometry and matches only WALK/DRIVE/MOTORCYCLE legs", () => {
    const busLeg: BusLeg = {
      type: "BUS",
      routeName: "示範公車",
      departureStop: "A",
      arrivalStop: "B",
      waitInfo: { time: null, source: "unavailable" },
      direction: 0,
      polyline: [
        [121, 25],
        [121.001, 25],
      ],
      departureStopA11y: [],
      arrivalStopA11y: [],
    };
    const route: AccessibleRoute = {
      ...walkRoute("bus-is-not-ground-proof", [
        [121, 25.003],
        [121.001, 25.003],
      ]),
      legs: [
        walkLeg([
          [121, 25.003],
          [121.001, 25.003],
        ]),
        busLeg,
      ],
    };

    expect(
      matchConfirmedHazardsToRoute(route, [hazard("bus-only", [121.0005, 25])]),
    ).toEqual([]);
  });
});

describe("confirmed hazard candidate planning", () => {
  it("uses a bounded candidate corridor and skips an oversized one", () => {
    const localRoutes = [
      walkRoute("local-a", [
        [121, 25],
        [121.001, 25],
      ]),
      walkRoute("local-b", [
        [121, 25.002],
        [121.001, 25.002],
      ]),
    ];
    const area = buildHazardQueryArea(localRoutes);

    expect(area).toBeDefined();
    expect(area!.radiusM).toBeGreaterThanOrEqual(HAZARD_ROUTE_CORRIDOR_M);
    expect(area!.radiusM).toBeLessThanOrEqual(MAX_HAZARD_QUERY_RADIUS_M);
    expect(
      buildHazardQueryArea([
        walkRoute("too-wide", [
          [121, 25],
          [122, 25],
        ]),
      ]),
    ).toBeUndefined();
  });

  it("ranks an unaffected candidate ahead of a faster blocking-hazard candidate", () => {
    const affected = walkRoute("fast-but-blocked", [
      [121, 25],
      [121.001, 25],
    ]);
    const unaffected = walkRoute("clear-alternative", [
      [121, 25.002],
      [121.001, 25.002],
    ]);
    const plan = planConfirmedHazardRoutes(
      [affected, unaffected],
      [hazard("blocking-1", [121.0005, 25.00005])],
    );

    expect(plan.selectionApplied).toBe(true);
    expect(plan.routes.map((route) => route.routeId)).toEqual([
      "clear-alternative",
      "fast-but-blocked",
    ]);
    expect(plan.routes[0].hazardAdvisory).toMatchObject({
      onRoute: [],
      avoided: [{ id: "blocking-1" }],
      penaltyPoints: 0,
    });
    expect(plan.routes[1].hazardAdvisory).toMatchObject({
      onRoute: [{ id: "blocking-1", severity: "blocking" }],
      penaltyPoints: 1000,
    });
  });

  it("preserves non-enumerable schedule metadata through advisory decoration", () => {
    const affected = attachInternalSchedule(
      walkRoute("blocked-scheduled", [
        [121, 25],
        [121.001, 25],
      ]),
      100,
      200,
      true,
    );
    const clear = attachInternalSchedule(
      walkRoute("clear-scheduled", [
        [121, 25.002],
        [121.001, 25.002],
      ]),
      300,
      400,
      true,
    );
    const plan = planConfirmedHazardRoutes(
      [affected, clear],
      [hazard("blocking-1", [121.0005, 25.00005])],
    );

    expect(plan.routes.map((route) => route.routeId)).toEqual([
      "clear-scheduled",
      "blocked-scheduled",
    ]);
    for (const [route, departureTime, endTime] of [
      [plan.routes[0], 300, 400],
      [plan.routes[1], 100, 200],
    ] as const) {
      expect(
        Object.getOwnPropertyDescriptor(route, "_scheduledDepartureTime"),
      ).toMatchObject({
        value: departureTime,
        writable: true,
        enumerable: false,
      });
      expect(
        Object.getOwnPropertyDescriptor(route, "_scheduledEndTime"),
      ).toMatchObject({ value: endTime, writable: true, enumerable: false });
      expect(
        Object.getOwnPropertyDescriptor(route, "_isFutureScheduled"),
      ).toMatchObject({ value: true, writable: true, enumerable: false });
    }
  });

  it("keeps the least harmful route and marks it degraded when all candidates are affected", () => {
    const blocking = walkRoute("blocking-route", [
      [121, 25],
      [121.001, 25],
    ]);
    const difficult = attachInternalSchedule(
      walkRoute("difficult-route", [
        [121, 25.002],
        [121.001, 25.002],
      ]),
      100,
      200,
      true,
    );
    const plan = planConfirmedHazardRoutes(
      [blocking, difficult],
      [
        hazard("blocking-1", [121.0005, 25.00005], "blocking"),
        hazard("difficult-1", [121.0005, 25.00205], "difficult"),
      ],
    );

    expect(plan.allCandidatesAffected).toBe(true);
    expect(plan.routes[0]).toMatchObject({
      routeId: "difficult-route",
      degraded: true,
      hazardAdvisory: {
        onRoute: [{ id: "difficult-1", severity: "difficult" }],
        penaltyPoints: 250,
      },
    });
    expect(plan.routes[0].warnings).toContain(
      ROUTE_WARNING.HAZARD_ALL_ROUTES_BLOCKED,
    );
    expect(
      Object.getOwnPropertyDescriptor(
        plan.routes[0],
        "_scheduledDepartureTime",
      ),
    ).toMatchObject({ value: 100, writable: true, enumerable: false });
  });

  it("does not make an avoided-hazard claim with one candidate or no match", () => {
    const oneRoute = walkRoute("only-route", [
      [121, 25],
      [121.001, 25],
    ]);
    const singlePlan = planConfirmedHazardRoutes(
      [oneRoute],
      [hazard("blocking-1", [121.0005, 25.00005])],
    );
    expect(singlePlan.selectionApplied).toBe(false);
    expect(singlePlan.routes[0].hazardAdvisory?.avoided).toEqual([]);
    expect(singlePlan.routes[0].warnings).not.toContain(
      ROUTE_WARNING.HAZARD_ALL_ROUTES_BLOCKED,
    );

    const noMatchRoutes = [
      walkRoute("no-match-a", [
        [121, 25],
        [121.001, 25],
      ]),
      walkRoute("no-match-b", [
        [121, 25.002],
        [121.001, 25.002],
      ]),
    ];
    const noMatchPlan = planConfirmedHazardRoutes(noMatchRoutes, [
      hazard("far-away", [121, 25.01]),
    ]);
    expect(noMatchPlan.selectionApplied).toBe(false);
    expect(noMatchPlan.routes).toBe(noMatchRoutes);
    expect(noMatchPlan.routes.some((route) => route.hazardAdvisory)).toBe(
      false,
    );
  });
});
