import { describe, expect, it, vi } from "vitest";
const { getCanonicalBusPair } = vi.hoisted(() => ({
  getCanonicalBusPair: vi.fn(),
}));
vi.mock("../transit/bus-stop-pair-eta.service", async (original) => ({
  ...(await original<typeof import("../transit/bus-stop-pair-eta.service")>()),
  getCanonicalBusPair,
}));
import {
  resolveCandidateGroup,
  getBusCandidateContext,
} from "./bus-stop-pair-candidates";
import { createCandidateRequestBudget } from "../transit/bus-stop-pair-eta.service";
import { storeBusPlan } from "./bus-plan.repository";
const { redisSet } = vi.hoisted(() => ({ redisSet: vi.fn() }));
vi.mock("../../config/redis", () => ({ redisSet, redisGet: vi.fn() }));
import type { AccessibleRoute, BusLeg } from "../../types/route";
const start = Date.parse("2026-10-18T08:00:00+08:00");
const base = (): AccessibleRoute => ({
  routeId: "physical-pair",
  routeName: "14",
  totalMinutes: 60,
  transferCount: 0,
  accessibilityHighlights: [],
  legs: [
    {
      type: "BUS",
      routeName: "14",
      subRouteUid: "14",
      subRouteName: "14",
      departureStop: "A",
      arrivalStop: "B",
      departureStopId: "14A",
      arrivalStopId: "14B",
      _canonicalDepartureStopId: "A",
      _canonicalArrivalStopId: "B",
      direction: 0,
      tdxCity: "Taipei",
      polyline: [
        [121, 25],
        [121.1, 25.1],
      ],
      waitInfo: { time: null, source: "unavailable" },
      departureStopA11y: [],
      arrivalStopA11y: [],
    },
  ],
});
const live = (id: string, minute: number, end: number) => {
  const board = {
      seq: 1,
      stopUID: id + "A",
      lat: 25,
      lng: 121,
      stopName: { Zh_tw: "A" },
    },
    alight = {
      seq: 2,
      stopUID: id + "B",
      lat: 25.1,
      lng: 121.1,
      stopName: { Zh_tw: "B" },
    };
  return {
    route: {
      subRouteUid: id,
      routeName: { Zh_tw: id },
      direction: 1,
      board,
      alight,
      stops: [board, alight],
    },
    eta: [
      {
        plateNumb: id,
        boardingAt: start + minute * 60000,
        alightingAt: start + end * 60000,
      },
    ],
  };
};
async function resolve(
  extra: Partial<Parameters<typeof resolveCandidateGroup>[0]> = {},
) {
  const budget = createCandidateRequestBudget();
  try {
    return await resolveCandidateGroup({
      members: [base()],
      mode: "normal",
      planningNow: start,
      budget,
      memo: new Map(),
      ...extra,
    });
  } finally {
    budget.close();
  }
}
describe("all-candidate materialization and chain integration", () => {
  it("does not let today's ETA suppress a future stop-specific schedule", async () => {
    const route = base(),
      leg = route.legs[0] as BusLeg;
    leg._scheduledDepartureTime = start + 86400000;
    leg._scheduledArrivalTime = start + 86400000 + 600000;
    getCanonicalBusPair.mockResolvedValue({
      complete: true,
      vehicles: [],
      routes: [
        {
          ...live("14", 1, 10),
          route: { ...live("14", 1, 10).route, direction: 0 },
        },
      ],
    });
    const [resolved] = await resolve({
      members: [route],
      planningNow: start + 86400000,
      realtimeNow: start,
    });
    expect(resolved.legs[0]).toMatchObject({
      departureCandidates: [{ boardingTimeSource: "schedule", selected: true }],
    });
    expect(getCanonicalBusPair.mock.calls.at(-1)?.[0].now).toBe(start);
  });
  it("shows boarding-only realtime on the timetable trip, whose schedule chain still decides arrival", async () => {
    const route = base(),
      leg = route.legs[0] as BusLeg;
    leg._scheduledDepartureTime = start + 120000;
    leg._scheduledArrivalTime = start + 1200000;
    const partial = live("14", 1, 10);
    partial.route.direction = 0;
    getCanonicalBusPair.mockResolvedValue({
      complete: true,
      vehicles: [],
      routes: [
        {
          ...partial,
          eta: partial.eta.map((row) => ({ ...row, alightingAt: null })),
        },
      ],
    });
    const [resolved] = await resolve({ members: [route] });
    const bus = resolved.legs[0] as BusLeg;
    expect(bus.departureCandidates).toMatchObject([
      {
        boardingTimeSource: "realtime",
        alightingTimeSource: "schedule",
        selected: true,
      },
    ]);
    expect(resolved.arrivalTime).toBe("2026-10-18T08:20:00.000+08:00");
  });
  it("offers a late-running live bus that leaves before the timetable trip OTP shifted the route start to", async () => {
    const route = base(),
      leg = route.legs[0] as BusLeg;
    route._scheduledDepartureTime = start + 40 * 60000;
    leg._scheduledDepartureTime = start + 41 * 60000;
    leg._scheduledArrivalTime = start + 51 * 60000;
    const late = live("14", 8, 18);
    late.route.direction = 0;
    getCanonicalBusPair.mockResolvedValue({
      complete: true,
      vehicles: [],
      routes: [late],
    });
    const [resolved] = await resolve({ members: [route] });
    expect(resolved.legs[0]).toMatchObject({
      plateNumb: "14",
      departureCandidates: [
        { plateNumb: "14", boardingTimeSource: "realtime", selected: true },
        { boardingTimeSource: "schedule", selected: false },
      ],
    });
    expect(resolved.arrivalTime).toBe("2026-10-18T08:18:00.000+08:00");
  });
  it("selects a non-OTP sixth service with only two trustworthy realtime endpoints, retains its geometry/identity, and persists no-schedule v2", async () => {
    getCanonicalBusPair.mockResolvedValue({
      complete: true,
      vehicles: [],
      routes: [
        ...Array.from({ length: 5 }, (_, n) => live(String(n + 1), n + 1, 60)),
        live("105", 6, 20),
      ],
    });
    const [route] = await resolve();
    const leg = route.legs[0] as BusLeg;
    expect(leg).toMatchObject({
      routeName: "105",
      subRouteUid: "105",
      departureStopId: "105A",
      arrivalStopId: "105B",
      direction: 1,
      departureTime: "08:06",
      arrivalTime: "08:20",
      geometrySource: "route_stops",
      candidateSearchComplete: true,
    });
    expect(leg.scheduledTrip).toBeUndefined();
    expect(leg.departureCandidates?.map((c) => c.routeName)).toEqual([
      "1",
      "2",
      "3",
      "4",
      "105",
    ]);
    expect(route.arrivalTime).toBe("2026-10-18T08:20:00.000+08:00");
    expect(route.totalMinutes).toBe(20);
    expect(
      getBusCandidateContext(route)?.legs[0].selectedCandidateId,
    ).toContain("105");
    await storeBusPlan("token", route);
    const snapshot = JSON.parse(redisSet.mock.calls.at(-1)?.[1]);
    expect(snapshot).toMatchObject({
      schemaVersion: 2,
      mode: "normal",
      legs: {
        0: {
          canonicalDepartureStopId: "A",
          canonicalArrivalStopId: "B",
          selectedCandidateId: leg.departureCandidates?.find((c) => c.selected)
            ?.candidateId,
        },
      },
    });
  });
  it("derives a downstream bus ready time from the newly selected upstream arrival", async () => {
    const route = base();
    const first = route.legs[0] as BusLeg;
    const second: BusLeg = {
      ...first,
      routeName: "legacy-second",
      subRouteUid: "legacy-second",
      subRouteName: "legacy-second",
      departureStopId: "legacyC",
      arrivalStopId: "legacyD",
      _canonicalDepartureStopId: "C",
      _canonicalArrivalStopId: "D",
      // The original OTP chain was later. It must not exclude a newly
      // reachable 08:25 connection after the replacement arrives at 08:20.
      _boardingReadyTime: start + 35 * 60000,
    };
    route.legs = [
      first,
      {
        type: "WALK",
        from: "B",
        to: "C",
        distanceM: 200,
        minutesEst: 4,
        polyline: [],
        a11yFacilities: [],
        maxSlopePercent: null,
        crossings: null,
        crossingsWithCurbRamp: null,
        minPathWidthCm: null,
        surfaceType: "unknown",
        restPoints: [],
      },
      second,
    ];
    route.transferCount = 1;
    getCanonicalBusPair.mockImplementation(
      async (input: { canonicalBoardStopId: string }) => ({
        complete: true,
        vehicles: [],
        routes:
          input.canonicalBoardStopId === "A"
            ? [live("first", 1, 20)]
            : [live("connection", 25, 40)],
      }),
    );

    const [resolved] = await resolve({ members: [route] });
    expect(resolved.legs[2]).toMatchObject({
      routeName: "connection",
      departureTime: "08:25",
      arrivalTime: "08:40",
      departureCandidates: [{ selected: true }],
    });
  });
  it("will not select a service lacking trusted geometry, and reports an incomplete search", async () => {
    const missing = live("bad", 1, 10);
    missing.route.stops = [];
    getCanonicalBusPair.mockResolvedValue({
      complete: true,
      vehicles: [],
      routes: [missing, live("safe", 2, 20)],
    });
    const [route] = await resolve();
    expect(route.legs[0]).toMatchObject({
      routeName: "safe",
      candidateSearchComplete: false,
    });
  });
  it("retries a slower candidate when materialization fails the hard safety recheck", async () => {
    getCanonicalBusPair.mockResolvedValue({
      complete: true,
      vehicles: [],
      routes: [live("unsafe", 1, 10), live("safe", 2, 20)],
    });
    const [route] = await resolve({
      validateMaterialized: async (_base, collections) => {
        for (const c of collections.values())
          for (const [id, leg] of c.materialized)
            if (leg.routeName === "unsafe") c.materialized.delete(id);
      },
    });
    expect(route.legs[0]).toMatchObject({ routeName: "safe" });
  });
  it("never revives confirmed high-floor via schedule fallback", async () => {
    const route = base();
    const leg = route.legs[0] as BusLeg;
    leg.isLowFloor = false;
    leg._scheduledDepartureTime = start + 60000;
    leg._scheduledArrivalTime = start + 600000;
    getCanonicalBusPair.mockRejectedValue(Error("TDX offline"));
    expect(await resolve({ members: [route], mode: "wheelchair" })).toEqual([]);
    const [normal] = await resolve({ members: [route], mode: "normal" });
    expect(normal.legs[0]).toMatchObject({
      candidateSearchComplete: false,
      departureCandidates: [
        {
          boardingTimeSource: "schedule",
          vehicleAccessibility: "high_floor",
          selected: true,
        },
      ],
    });
  });
});
