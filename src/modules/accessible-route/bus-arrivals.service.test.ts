import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const { redisGet, redisSet, tdxFetch, getCanonicalBusPair } = vi.hoisted(
  () => ({
    getCanonicalBusPair: vi.fn(),
    redisGet: vi.fn(),
    redisSet: vi.fn(),
    tdxFetch: vi.fn(),
  }),
);
vi.mock("../../config/redis", () => ({
  redisGet,
  redisSet,
  redisClient: {},
  redisReady: vi.fn(),
}));
vi.mock("../../config/fetch", () => ({ tdxFetch }));
vi.mock("../transit/bus-stop-pair-eta.service", async (original) => ({
  ...(await original<typeof import("../transit/bus-stop-pair-eta.service")>()),
  getCanonicalBusPair,
}));
import { storeBusPlan } from "./bus-plan.repository";
import type { AccessibleRoute } from "../../types/route";
import { getPlannedBusArrivals } from "./bus-arrivals.service";

const at = (time: string) => Date.parse(`2030-01-01T${time}:00+08:00`);
function plan(departure = "10:00") {
  return {
    legs: [
      { type: "WALK" },
      {
        type: "BUS",
        routeName: "307",
        subRouteName: "307 往撫遠街",
        subRouteUid: "TPE307",
        tdxCity: "Taipei",
        direction: 0,
        departureStop: "A",
        arrivalStop: "C",
        departureStopId: "TPE1",
        arrivalStopId: "TPE3",
        polyline: [
          [121, 25],
          [121.1, 25.1],
        ],
        scheduledTrip: {
          tripId: "trip-10",
          boardingReadyAt: at("09:58"),
          stops: [
            {
              stopUid: "TPE1",
              name: "A",
              arrivalAt: at(departure),
              departureAt: at(departure),
              lat: 25,
              lng: 121,
            },
            {
              stopUid: "TPE2",
              name: "B",
              arrivalAt: at("10:10"),
              departureAt: at("10:11"),
              lat: 25.05,
              lng: 121.05,
            },
            {
              stopUid: "TPE3",
              name: "C",
              arrivalAt: at("10:20"),
              lat: 25.1,
              lng: 121.1,
            },
          ],
        },
      },
    ],
  };
}
function eta(
  stop: number,
  minutes: number,
  plate = "BUS-10",
  scheduled = "10:00",
) {
  return {
    SubRouteUID: "TPE307",
    StopUID: `TPE${stop}`,
    Direction: 0,
    StopSequence: stop,
    PlateNumb: plate,
    ScheduledTime: scheduled,
    EstimateTime: minutes * 60,
    StopStatus: 0,
    UpdateTime: new Date().toISOString(),
  };
}
async function stops(token = "plan") {
  const result = await getPlannedBusArrivals(token, 1);
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(result.error);
  return result.directions[0].stops;
}
beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(at("09:55"));
  // Round-trip JSON is intentional: internal non-enumerable OTP fields are gone.
  redisGet.mockResolvedValue(JSON.stringify(plan()));
  tdxFetch.mockResolvedValue({ ok: true, json: async () => [] });
});
afterEach(() => vi.useRealTimers());

it("prefers v2 trusted pair even while the navigation envelope survives, selecting another line without a fake trip", async () => {
  const original = plan().legs[1];
  const snapshot = {
    schemaVersion: 2,
    mode: "normal",
    routeDepartureTime: at("09:55"),
    timeline: [{ type: "BUS", legIndex: 1, minimumBoardingSlackMs: 0 }],
    legs: {
      1: {
        leg: original,
        canonicalDepartureStopId: "canonical-A",
        canonicalArrivalStopId: "canonical-C",
        effectiveBoardingReadyAt: at("09:58"),
        scheduledSeeds: [],
        candidateSearchComplete: true,
      },
    },
  };
  redisGet.mockImplementation(async (key: string) =>
    JSON.stringify(key.startsWith("bus-plan:") ? snapshot : plan()),
  );
  const board = {
    seq: 1,
    stopUID: "105A",
    lat: 25,
    lng: 121,
    stopName: { Zh_tw: "A" },
  };
  const alight = {
    seq: 2,
    stopUID: "105C",
    lat: 25.1,
    lng: 121.1,
    stopName: { Zh_tw: "C" },
  };
  getCanonicalBusPair.mockResolvedValue({
    complete: true,
    vehicles: [],
    routes: [
      {
        route: {
          subRouteUid: "TPE105",
          routeName: { Zh_tw: "105" },
          direction: 1,
          board,
          alight,
          stops: [board, alight],
        },
        eta: [
          {
            plateNumb: "NEW",
            boardingAt: at("10:01"),
            alightingAt: at("10:10"),
          },
        ],
      },
    ],
  });
  const result = await getPlannedBusArrivals("plan", 1);
  expect(result).toMatchObject({
    ok: true,
    routeName: "105",
    candidateSearchComplete: true,
    departureCandidates: [{ routeName: "105", selected: true }],
  });
  expect(getCanonicalBusPair.mock.calls[0][0]).toMatchObject({
    canonicalBoardStopId: "canonical-A",
    canonicalAlightStopId: "canonical-C",
  });
});

describe("planned stop-by-stop arrivals through the stored route capability", () => {
  it("keeps every planned stop time at 09:00 for the 10:00 trip", async () => {
    vi.setSystemTime(at("09:00"));
    const rows = await stops();
    expect(rows.map((s) => [s.estimateMinutes, s.statusLabel])).toEqual([
      [null, "10:00"],
      [null, "10:10"],
      [null, "10:20"],
    ]);
    expect(tdxFetch).not.toHaveBeenCalled();
  });
  it("does not substitute the next run even when its ETA is close", async () => {
    tdxFetch.mockResolvedValue({
      ok: true,
      json: async () => [eta(1, 5, "BUS-OLD", "09:50"), eta(2, 8, "BUS-OLD")],
    });
    expect(
      (await stops()).every((s) => s.estimateMinutes === null && !s.plateNumb),
    ).toBe(true);
  });
  it("uses one matched vehicle at each stop, with schedule fallback for a missing stop", async () => {
    tdxFetch.mockResolvedValue({
      ok: true,
      json: async () => [eta(1, 8), eta(2, 1, "BUS-OLD"), eta(3, 25)],
    });
    expect(
      (await stops()).map((s) => [
        s.estimateMinutes,
        s.statusLabel,
        s.plateNumb,
      ]),
    ).toEqual([
      [8, "正常", "BUS-10"],
      [null, "10:10", undefined],
      [25, "正常", "BUS-10"],
    ]);
  });
  it("queries the public route name and scopes by UID rather than a display headsign", async () => {
    await stops();
    const url = tdxFetch.mock.calls[0][0];
    expect(url).toContain("/Taipei/307?");
    expect(url).toContain("SubRouteUID eq 'TPE307'");
    expect(url).not.toContain(encodeURIComponent("往撫遠街"));
  });
  it("returns the original schedule after a later poll fails", async () => {
    tdxFetch.mockResolvedValue({
      ok: true,
      json: async () => [eta(1, 8), eta(2, 15)],
    });
    expect((await stops())[0].estimateMinutes).toBe(8);
    tdxFetch.mockRejectedValue(new Error("provider unavailable"));
    expect((await stops()).map((s) => s.statusLabel)).toEqual([
      "10:00",
      "10:10",
      "10:20",
    ]);
  });
  it("does not share matched ETAs across two tokens for the same bus line", async () => {
    redisGet.mockImplementation(async (key: string) =>
      JSON.stringify(plan(key.endsWith("later") ? "11:00" : "10:00")),
    );
    tdxFetch.mockResolvedValue({ ok: true, json: async () => [eta(1, 8)] });
    expect((await stops("earlier"))[0].estimateMinutes).toBe(8);
    expect((await stops("later"))[0]).toMatchObject({
      estimateMinutes: null,
      statusLabel: "11:00",
    });
  });
  it("rejects expired tokens and invalid/non-bus leg indexes without querying a next bus", async () => {
    expect(await getPlannedBusArrivals("plan", 0)).toMatchObject({
      ok: false,
      status: 400,
    });
    expect(await getPlannedBusArrivals("plan", 99)).toMatchObject({
      ok: false,
      status: 400,
    });
    redisGet.mockResolvedValue(null);
    expect(await getPlannedBusArrivals("expired", 1)).toMatchObject({
      ok: false,
      status: 404,
    });
    expect(tdxFetch).not.toHaveBeenCalled();
  });
});

it("keeps a 09:00 plan matchable at 09:55 without extending the navigation token", async () => {
  vi.setSystemTime(at("09:00"));
  await storeBusPlan("long-plan", plan() as unknown as AccessibleRoute);
  expect(redisSet).toHaveBeenCalledTimes(1);
  const [key, raw, ttl] = redisSet.mock.calls[0];
  expect(key).toBe("bus-plan:long-plan");
  expect(ttl).toBe(110 * 60); // final arrival 10:20 + 30-minute grace
  const cached = JSON.parse(raw);
  expect(Object.keys(cached.legs)).toEqual(["1"]); // original all-modes index
  expect(cached.legs[1]).not.toHaveProperty("_scheduledTripId");
  const expiresAt = Date.now() + ttl * 1000;
  redisGet.mockImplementation(async (asked: string) =>
    asked === key && Date.now() < expiresAt ? raw : null,
  );
  vi.setSystemTime(at("09:55"));
  tdxFetch.mockResolvedValue({
    ok: true,
    json: async () => [eta(1, 8), eta(3, 25)],
  });
  expect((await stops("long-plan"))[0]).toMatchObject({
    estimateMinutes: 8,
    plateNumb: "BUS-10",
  });
  expect(redisSet).toHaveBeenCalledTimes(1); // reads cannot renew retention
  vi.setSystemTime(at("10:51"));
  expect(await getPlannedBusArrivals("long-plan", 1)).toMatchObject({
    ok: false,
    status: 404,
  });
});

it("caps bus-only snapshot retention and excludes unrelated route data", async () => {
  const route = plan();
  route.legs[1].scheduledTrip!.stops[2].arrivalAt =
    Date.now() + 72 * 60 * 60_000;
  await storeBusPlan("future", {
    ...route,
    userId: "private",
    canonicalRequest: { origin: "home" },
  } as unknown as AccessibleRoute);
  expect(redisSet.mock.calls[0][2]).toBe(48 * 60 * 60);
  expect(redisSet.mock.calls[0][1]).not.toContain("private");
  expect(redisSet.mock.calls[0][1]).not.toContain("home");
});

function pairResult(
  subRouteUid: string,
  boardAt: number,
  endAt: number,
  complete = true,
) {
  const board = {
    seq: 1,
    stopUID: `${subRouteUid}A`,
    lat: 25,
    lng: 121,
    stopName: { Zh_tw: "A" },
  };
  const alight = {
    seq: 2,
    stopUID: `${subRouteUid}B`,
    lat: 25.1,
    lng: 121.1,
    stopName: { Zh_tw: "B" },
  };
  return {
    complete,
    vehicles: [],
    routes: [
      {
        route: {
          subRouteUid,
          routeName: { Zh_tw: subRouteUid },
          direction: 0,
          board,
          alight,
          stops: [board, alight],
        },
        eta: [
          { plateNumb: subRouteUid, boardingAt: boardAt, alightingAt: endAt },
        ],
      },
    ],
  };
}
describe("v2 suffix replay from trusted context", () => {
  it.each([true, false])(
    "replays BUS → WALK → BUS with envelope=%s and no scheduledTrip",
    async (envelope) => {
      const first = { ...plan().legs[1] };
      delete first.scheduledTrip;
      const snapshot = {
        schemaVersion: 2,
        mode: "normal",
        routeDepartureTime: at("09:55"),
        timeline: [
          { type: "BUS", legIndex: 1, minimumBoardingSlackMs: 0 },
          { type: "WALK", durationMs: 5 * 60000 },
          { type: "BUS", legIndex: 3, minimumBoardingSlackMs: 0 },
        ],
        legs: {
          1: {
            leg: first,
            canonicalDepartureStopId: "A",
            canonicalArrivalStopId: "B",
            effectiveBoardingReadyAt: at("09:58"),
            scheduledSeeds: [],
            candidateSearchComplete: true,
          },
          3: {
            leg: first,
            canonicalDepartureStopId: "C",
            canonicalArrivalStopId: "D",
            // The original plan was ready much later; a refreshed upstream
            // arrival can make an earlier downstream service reachable.
            effectiveBoardingReadyAt: at("10:35"),
            scheduledSeeds: [],
            candidateSearchComplete: true,
          },
        },
      };
      redisGet.mockImplementation(async (key: string) =>
        key.startsWith("bus-plan:")
          ? JSON.stringify(snapshot)
          : envelope
            ? JSON.stringify(plan())
            : null,
      );
      getCanonicalBusPair.mockImplementation(
        async (input: { canonicalBoardStopId: string }) =>
          input.canonicalBoardStopId === "A"
            ? pairResult("first", at("10:00"), at("10:23"))
            : pairResult("second", at("10:26"), at("10:40")),
      );
      const missed = await getPlannedBusArrivals("plan", 1);
      expect(missed).toMatchObject({
        ok: true,
        routeName: "307",
        departureCandidates: [{ routeName: "first", selected: false }],
      });
      getCanonicalBusPair.mockImplementation(
        async (input: { canonicalBoardStopId: string }) =>
          input.canonicalBoardStopId === "A"
            ? pairResult("first", at("10:00"), at("10:23"))
            : pairResult("second", at("10:28"), at("10:40"), false),
      );
      expect(await getPlannedBusArrivals("plan", 1)).toMatchObject({
        ok: true,
        routeName: "first",
        candidateSearchComplete: false,
        departureCandidates: [{ routeName: "first", selected: true }],
      });
      expect(redisSet).not.toHaveBeenCalled();
    },
  );
  it.each([true, false])(
    "replays BUS → rail → BUS and rejects a missed fixed train, envelope=%s",
    async (envelope) => {
      const leg = plan().legs[1];
      const snapshot = {
        schemaVersion: 2,
        mode: "normal",
        routeDepartureTime: at("09:55"),
        timeline: [
          { type: "BUS", legIndex: 1, minimumBoardingSlackMs: 0 },
          {
            type: "FIXED_TRANSIT",
            legIndex: 2,
            departureAt: at("10:22"),
            arrivalAt: at("10:35"),
            minimumBoardingSlackMs: 0,
          },
          { type: "BUS", legIndex: 3, minimumBoardingSlackMs: 0 },
        ],
        legs: {
          1: {
            leg,
            canonicalDepartureStopId: "A",
            canonicalArrivalStopId: "B",
            effectiveBoardingReadyAt: at("09:58"),
            scheduledSeeds: [],
            candidateSearchComplete: true,
          },
          3: {
            leg,
            canonicalDepartureStopId: "C",
            canonicalArrivalStopId: "D",
            effectiveBoardingReadyAt: at("10:35"),
            scheduledSeeds: [],
            candidateSearchComplete: true,
          },
        },
      };
      redisGet.mockImplementation(async (key: string) =>
        key.startsWith("bus-plan:")
          ? JSON.stringify(snapshot)
          : envelope
            ? JSON.stringify(plan())
            : null,
      );
      getCanonicalBusPair.mockImplementation(
        async (input: { canonicalBoardStopId: string }) =>
          input.canonicalBoardStopId === "A"
            ? pairResult("first", at("10:00"), at("10:23"))
            : pairResult("second", at("10:36"), at("10:50")),
      );
      expect(await getPlannedBusArrivals("plan", 1)).toMatchObject({
        ok: true,
        routeName: "307",
        departureCandidates: [{ selected: false }],
      });
      getCanonicalBusPair.mockImplementation(
        async (input: { canonicalBoardStopId: string }) => {
          if (input.canonicalBoardStopId !== "A")
            return pairResult("second", at("10:36"), at("10:50"));
          const late = pairResult("late", at("10:00"), at("10:23")),
            connecting = pairResult("connecting", at("10:02"), at("10:21"));
          return { ...late, routes: [...late.routes, ...connecting.routes] };
        },
      );
      expect(await getPlannedBusArrivals("plan", 1)).toMatchObject({
        ok: true,
        routeName: "connecting",
        departureCandidates: [
          { routeName: "late", selected: false },
          { routeName: "connecting", selected: true },
        ],
      });
    },
  );
});

describe("stop-by-stop arrivals for the adopted departure candidate", () => {
  function v2(seeds: unknown[] = []) {
    const snapshot = {
      schemaVersion: 2,
      mode: "normal",
      routeDepartureTime: at("09:55"),
      timeline: [{ type: "BUS", legIndex: 1, minimumBoardingSlackMs: 0 }],
      legs: {
        1: {
          leg: plan().legs[1],
          canonicalDepartureStopId: "canonical-A",
          canonicalArrivalStopId: "canonical-C",
          effectiveBoardingReadyAt: at("09:58"),
          scheduledSeeds: seeds,
          candidateSearchComplete: true,
        },
      },
    };
    redisGet.mockImplementation(async (key: string) =>
      key.startsWith("bus-plan:") ? JSON.stringify(snapshot) : null,
    );
  }
  const noLiveVehicles = { complete: true, vehicles: [], routes: [] };
  const scheduledSeed = () => ({
    leg: plan().legs[1],
    candidate: {
      candidateId: "TPE307|0|trip-10|seed",
      routeName: "307",
      subRouteUid: "TPE307",
      direction: 0,
      departureStopId: "TPE1",
      arrivalStopId: "TPE3",
      tripId: "trip-10",
      estimatedWaitMinutes: 5,
      boardingTime: "2030-01-01T10:00:00+08:00",
      alightingTime: "2030-01-01T10:20:00+08:00",
      boardingTimeSource: "schedule",
      alightingTimeSource: "schedule",
      vehicleAccessibility: "unknown",
      hasLiftOrRamp: null,
      selected: false,
    },
  });

  it("follows the adopted live vehicle through every stop and rounds its wait", async () => {
    v2();
    const stop = (seq: number, id: string, name: string) => ({
      seq,
      stopUID: id,
      lat: 25 + seq / 100,
      lng: 121 + seq / 100,
      stopName: { Zh_tw: name },
    });
    const board = stop(1, "105A", "A"),
      middle = stop(2, "105B", "B"),
      alight = stop(3, "105C", "C");
    getCanonicalBusPair.mockResolvedValue({
      complete: true,
      vehicles: [],
      routes: [
        {
          route: {
            subRouteUid: "TPE61",
            routeName: { Zh_tw: "105" },
            direction: 1,
            board,
            alight,
            stops: [board, middle, alight],
          },
          eta: [
            {
              plateNumb: "NEW",
              boardingAt: at("10:01") + 12_345,
              alightingAt: at("10:10"),
            },
          ],
        },
      ],
    });
    const live = (stopUid: string, minutes: number, plate = "NEW") => ({
      SubRouteUID: "TPE61",
      StopUID: stopUid,
      Direction: 1,
      PlateNumb: plate,
      EstimateTime: minutes * 60,
      StopStatus: 0,
      UpdateTime: new Date().toISOString(),
    });
    tdxFetch.mockResolvedValue({
      ok: true,
      json: async () => [
        live("105A", 6),
        live("105B", 2, "OTHER"),
        live("105B", 9),
        live("105C", 15),
      ],
    });
    const result = await getPlannedBusArrivals("plan", 1);
    if (!result.ok) throw new Error(result.error);
    expect(
      result.directions[0].stops.map((s) => [
        s.name,
        s.estimateMinutes,
        s.statusLabel,
        s.plateNumb,
      ]),
    ).toEqual([
      ["A", 6, "正常", "NEW"],
      ["B", 9, "正常", "NEW"],
      ["C", 15, "正常", "NEW"],
    ]);
    expect(result.departureCandidates?.[0]).toMatchObject({
      selected: true,
      estimatedWaitMinutes: 6,
    });
  });

  it("keeps every timetable stop of an adopted scheduled trip, with live minutes where matched", async () => {
    v2([scheduledSeed()]);
    getCanonicalBusPair.mockResolvedValue(noLiveVehicles);
    tdxFetch.mockResolvedValue({
      ok: true,
      json: async () => [eta(1, 5), eta(3, 25)],
    });
    expect(
      (await stops()).map((s) => [s.name, s.estimateMinutes, s.statusLabel]),
    ).toEqual([
      ["A", 5, "正常"],
      ["B", null, "10:10"],
      ["C", 25, "正常"],
    ]);
  });

  it("still matches the planned bus live when no candidate can be adopted", async () => {
    v2();
    getCanonicalBusPair.mockResolvedValue(noLiveVehicles);
    tdxFetch.mockResolvedValue({ ok: true, json: async () => [eta(1, 5)] });
    expect((await stops())[0]).toMatchObject({
      estimateMinutes: 5,
      plateNumb: "BUS-10",
    });
  });
});
