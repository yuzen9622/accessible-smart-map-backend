import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const {
  tdxFetch,
  findRoutesServingCanonicalPair,
  findVehiclesByPlate,
  getPairTimetableTrips,
} = vi.hoisted(() => ({
  tdxFetch: vi.fn(),
  findRoutesServingCanonicalPair: vi.fn(),
  findVehiclesByPlate: vi.fn(),
  getPairTimetableTrips: vi.fn(),
}));
vi.mock("../../config/fetch", () => ({ tdxFetch }));
vi.mock("./bus-pair-timetable", () => ({ getPairTimetableTrips }));
vi.mock("./bus.repository", () => ({
  findRoutesServingCanonicalPair,
  findVehiclesByPlate,
  MAX_TRIPS_PER_ROUTE: 4,
}));
import {
  createCandidateRequestBudget,
  getBusStopPairRealtime,
  getBusVehicleStopTimes,
  getCanonicalBusPair,
} from "./bus-stop-pair-eta.service";
const now = Date.parse("2026-10-18T08:00:00+08:00");
let serial = 0;
const input = () => ({
  city: "Taipei",
  routeName: "14",
  subRouteUid: `test-${serial++}`,
  direction: 0 as const,
  departureStopId: "A",
  arrivalStopId: "B",
  now,
  signal: AbortSignal.timeout(1000),
});
const row = (stop: string, minutes: number, extra = {}) => ({
  StopUID: stop,
  SubRouteUID: "test",
  Direction: 0,
  EstimateTime: minutes * 60,
  PlateNumb: "BUS",
  SrcUpdateTime: new Date(now).toISOString(),
  ...extra,
});
const serve = (i: ReturnType<typeof input>, rows: object[]) =>
  tdxFetch.mockResolvedValue({
    ok: true,
    json: async () => rows.map((r) => ({ ...r, SubRouteUID: i.subRouteUid })),
  });
beforeEach(() => {
  vi.resetAllMocks();
  findVehiclesByPlate.mockResolvedValue([]);
  getPairTimetableTrips.mockResolvedValue([]);
});
afterEach(() => vi.useRealTimers());
describe("bounded exact stop-pair provider", () => {
  it("joins only a unique downstream vehicle with nondecreasing timestamps", async () => {
    const i = input();
    serve(i, [row("A", 1), row("B", 10), row("B", 2, { PlateNumb: "OTHER" })]);
    expect(await getBusStopPairRealtime(i)).toEqual([
      { plateNumb: "BUS", boardingAt: now + 60000, alightingAt: now + 600000 },
    ]);
  });
  it("finds a following bus listed only in a stop's Estimates", async () => {
    const i = input();
    const ahead = (stop: string, first: number) =>
      row(stop, first, {
        PlateNumb: "NEAR",
        Estimates: [
          { PlateNumb: "NEAR", EstimateTime: first * 60 },
          { PlateNumb: "NEXT", EstimateTime: (first + 9) * 60 },
        ],
      });
    serve(i, [ahead("A", 13), ahead("M", 20), ahead("B", 44)]);
    const times = await getBusVehicleStopTimes({
      ...i,
      plateNumb: "NEXT",
      stopIds: ["A", "M", "B"],
    });
    expect([...times]).toEqual([
      ["A", now + 22 * 60000],
      ["M", now + 29 * 60000],
      ["B", now + 53 * 60000],
    ]);
  });
  it.each([
    "duplicate-board",
    "duplicate-end",
    "reversed",
    "missing-subroute",
    "stale",
  ])("does not guess %s", async (kind) => {
    const i = input();
    let rows = [row("A", 2), row("B", 10)];
    if (kind === "duplicate-board") rows.push(row("A", 3));
    if (kind === "duplicate-end") rows.push(row("B", 11));
    if (kind === "reversed") rows[1] = row("B", 1);
    if (kind === "stale")
      rows = rows.map((r) => ({
        ...r,
        SrcUpdateTime: "2026-10-17T08:00:00+08:00",
        NextBusTime: "2026-10-18T08:03:00+08:00",
      }));
    if (kind === "missing-subroute")
      tdxFetch.mockResolvedValue({
        ok: true,
        json: async () => rows.map((r) => ({ ...r, SubRouteUID: undefined })),
      });
    else serve(i, rows);
    const found = await getBusStopPairRealtime(i);
    if (kind === "missing-subroute" || kind === "stale")
      expect(found).toEqual([]);
    else expect(found.every((r) => r.alightingAt === null)).toBe(true);
  });
  it.each([
    [true, 1],
    [false, 0],
  ])(
    "reads route-level rows without SubRouteUID only at an unshared boarding stop (exclusive=%s)",
    async (boardStopExclusive, expected) => {
      const i = { ...input(), routeUid: `R-${serial++}`, boardStopExclusive };
      tdxFetch.mockResolvedValue({
        ok: true,
        json: async () =>
          [
            row("A", 6, { RouteUID: i.routeUid }),
            row("B", 15, { RouteUID: i.routeUid }),
            row("A", 2, { RouteUID: "OTHER" }),
            row("A", 3, { RouteUID: i.routeUid, Direction: 1 }),
          ].map((r) => ({
            ...r,
            SubRouteUID: undefined,
            PlateNumb: undefined,
          })),
      });
      const found = await getBusStopPairRealtime(i);
      expect(decodeURIComponent(tdxFetch.mock.calls[0][0])).toContain(
        `RouteUID eq '${i.routeUid}' and Direction eq 0`,
      );
      expect(found).toEqual(
        expected
          ? [
              {
                plateNumb: undefined,
                boardingAt: now + 6 * 60000,
                alightingAt: null,
              },
            ]
          : [],
      );
    },
  );
  it("reuses one bounded cache/inflight fetch for identical route requests", async () => {
    const i = input();
    serve(i, [row("A", 1), row("B", 2)]);
    await Promise.all([getBusStopPairRealtime(i), getBusStopPairRealtime(i)]);
    await getBusStopPairRealtime(i);
    expect(tdxFetch).toHaveBeenCalledTimes(1);
  });
  it("uses a single concurrency-three limiter across pairs", async () => {
    const budget = createCandidateRequestBudget(1000);
    let active = 0,
      max = 0;
    try {
      await Promise.all(
        Array.from({ length: 30 }, () =>
          budget.run(async () => {
            max = Math.max(max, ++active);
            await new Promise((r) => setTimeout(r, 2));
            active--;
          }),
        ),
      );
      expect(max).toBe(3);
    } finally {
      budget.close();
    }
  });
  it("deadlines settle even providers that ignore cancellation and stop queued work", async () => {
    const budget = createCandidateRequestBudget(10);
    let launched = 0;
    const results = await Promise.allSettled(
      Array.from({ length: 9 }, () =>
        budget.run(async () => {
          launched++;
          return new Promise(() => {});
        }),
      ),
    );
    budget.close();
    expect(results.every((r) => r.status === "rejected")).toBe(true);
    expect(launched).toBe(3);
  });
  it.each([
    "complete",
    "route-overflow",
    "trip-overflow",
    "partial-failure",
    "vehicle-failure",
    "timetable-failure",
  ])("propagates %s completeness and batches plate lookup", async (kind) => {
    const a = input(),
      b = input();
    const route = (i: ReturnType<typeof input>) => ({
      subRouteUid: i.subRouteUid,
      routeName: { Zh_tw: i.routeName },
      direction: 0,
      board: { stopUID: "A" },
      alight: { stopUID: "B" },
    });
    findRoutesServingCanonicalPair.mockResolvedValue({
      complete: kind !== "route-overflow",
      routes: [route(a), route(b)],
    });
    tdxFetch.mockImplementation(async (url: string) => {
      const id = decodeURIComponent(url).includes(a.subRouteUid)
        ? a.subRouteUid
        : b.subRouteUid;
      if (kind === "partial-failure" && id === a.subRouteUid)
        throw Error("one route offline");
      return {
        ok: true,
        json: async () =>
          Array.from({ length: kind === "trip-overflow" ? 5 : 2 }, (_, n) => [
            row("A", n + 1, { SubRouteUID: id, PlateNumb: `P${n}` }),
            row("B", 20 + n, { SubRouteUID: id, PlateNumb: `P${n}` }),
          ]).flat(),
      };
    });
    if (kind === "vehicle-failure")
      findVehiclesByPlate.mockRejectedValue(Error("vehicle offline"));
    if (kind === "timetable-failure")
      getPairTimetableTrips.mockRejectedValue(Error("OTP offline"));
    const budget = createCandidateRequestBudget();
    try {
      const result = await getCanonicalBusPair(
        {
          city: "Taipei",
          canonicalBoardStopId: "A",
          canonicalAlightStopId: "B",
          now,
        },
        budget,
      );
      expect(result.complete).toBe(kind === "complete");
      expect(result.routes.every((r) => r.eta.length <= 4)).toBe(true);
      expect(findVehiclesByPlate).toHaveBeenCalledTimes(1);
      if (kind === "partial-failure")
        expect(result.routes[1].eta).toHaveLength(2);
    } finally {
      budget.close();
    }
  });
});
