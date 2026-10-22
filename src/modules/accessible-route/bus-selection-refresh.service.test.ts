import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const {
  redisGet,
  redisSet,
  getCanonicalBusPair,
  getBusVehicleStopTimes,
  tdxFetch,
} = vi.hoisted(() => ({
  redisGet: vi.fn(),
  redisSet: vi.fn(),
  getCanonicalBusPair: vi.fn(),
  getBusVehicleStopTimes: vi.fn(),
  tdxFetch: vi.fn(),
}));
vi.mock("../../config/redis", () => ({ redisGet, redisSet }));
vi.mock("../../config/fetch", () => ({ tdxFetch }));
vi.mock("../transit/bus-stop-pair-eta.service", async (original) => ({
  ...(await original<typeof import("../transit/bus-stop-pair-eta.service")>()),
  getCanonicalBusPair,
  getBusVehicleStopTimes,
}));
import { getPlannedBusArrivals } from "./bus-arrivals.service";
import { readOfferedBusCandidate } from "./bus-plan.repository";
import type { BusLeg, BusDepartureCandidate } from "../../types/route";
const at = (minute: number) =>
  Date.parse("2030-01-01T10:00:00+08:00") + minute * 60000;
const selected: BusDepartureCandidate = {
  candidateId: "original",
  routeName: "307",
  subRouteUid: "TPE307",
  direction: 0,
  departureStopId: "A",
  arrivalStopId: "C",
  plateNumb: "CHOSEN",
  tripId: "trip",
  boardingTime: "2030-01-01T10:00:00+08:00",
  alightingTime: "2030-01-01T10:20:00+08:00",
  boardingTimeSource: "realtime",
  alightingTimeSource: "realtime",
  estimatedWaitMinutes: 5,
  vehicleAccessibility: "unknown",
  hasLiftOrRamp: null,
  selected: true,
};
let leg: BusLeg;
const storage = new Map<string, string>();
beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(at(-5));
  storage.clear();
  leg = {
    type: "BUS",
    routeName: "307",
    subRouteUid: "TPE307",
    subRouteName: "307",
    direction: 0,
    tdxCity: "Taipei",
    plateNumb: "CHOSEN",
    departureStop: "A",
    arrivalStop: "C",
    departureStopId: "A",
    arrivalStopId: "C",
    polyline: [
      [121, 25],
      [121.1, 25.1],
    ],
    intermediateStops: [
      { name: "B", stationUid: "B", location: [121.05, 25.05] },
    ],
    waitInfo: { time: 5, source: "realtime" },
    departureStopA11y: [],
    arrivalStopA11y: [],
    selectedDeparture: selected,
    departureCandidates: [
      selected,
      {
        ...selected,
        candidateId: "other",
        plateNumb: "OTHER",
        selected: false,
      },
    ],
    scheduledTrip: {
      tripId: "trip",
      boardingReadyAt: at(-5),
      stops: [
        { stopUid: "A", name: "A", departureAt: at(0) },
        { stopUid: "B", name: "B", arrivalAt: at(10) },
        { stopUid: "C", name: "C", arrivalAt: at(20) },
      ],
    },
  };
  redisGet.mockImplementation(async (key: string) => {
    if (key === "bus-plan:plan")
      return JSON.stringify({
        schemaVersion: 2,
        mode: "normal",
        routeDepartureTime: at(-5),
        timeline: [{ type: "BUS", legIndex: 0, minimumBoardingSlackMs: 0 }],
        legs: {
          0: {
            leg,
            lockedCandidate: selected,
            canonicalDepartureStopId: "A",
            canonicalArrivalStopId: "C",
            effectiveBoardingReadyAt: at(-5),
            scheduledSeeds: [],
            candidateSearchComplete: true,
          },
        },
      });
    return storage.get(key) ?? null;
  });
  redisSet.mockImplementation(async (key: string, value: string) => {
    storage.set(key, value);
  });
  getBusVehicleStopTimes.mockResolvedValue(
    new Map([
      ["A", at(3)],
      ["B", at(14)],
      ["C", at(26)],
    ]),
  );
});
afterEach(() => vi.useRealTimers());
describe("locked bus refresh", () => {
  it("follows the selected plate before a timetable match and returns exact delayed endpoint times", async () => {
    const result = await getPlannedBusArrivals("plan", 0);
    expect(result).toMatchObject({
      ok: true,
      directions: [
        {
          stops: [
            { plateNumb: "CHOSEN", estimateMinutes: 8 },
            { plateNumb: "CHOSEN", estimateMinutes: 19 },
            { plateNumb: "CHOSEN", estimateMinutes: 31 },
          ],
        },
      ],
      departureCandidates: [
        {
          candidateId: "original",
          selected: true,
          boardingTime: "2030-01-01T10:03:00.000+08:00",
          alightingTime: "2030-01-01T10:26:00.000+08:00",
          alightingTimeSource: "realtime",
        },
        { candidateId: "other", selected: false },
      ],
    });
    expect(getBusVehicleStopTimes).toHaveBeenCalledWith(
      expect.objectContaining({
        plateNumb: "CHOSEN",
        subRouteUid: "TPE307",
        direction: 0,
      }),
    );
    expect(getCanonicalBusPair).not.toHaveBeenCalled();
    expect(tdxFetch).not.toHaveBeenCalled();
    expect(await readOfferedBusCandidate("plan", 0, "original")).toMatchObject({
      plateNumb: "CHOSEN",
      alightingTime: "2030-01-01T10:26:00.000+08:00",
    });
  });
  it("preserves the ride's complete stop order when its timetable only contains endpoints", async () => {
    leg.departureStop = "上車站";
    leg.arrivalStop = "下車站";
    leg.intermediateStops = [
      { name: "中途一", stationUid: "B1", location: [121.03, 25.03] },
      { name: "中途二", stationUid: "B2", location: [121.07, 25.07] },
    ];
    leg.scheduledTrip!.stops = [
      { stopUid: "A", name: "舊起站名", departureAt: at(0) },
      { stopUid: "C", name: "舊迄站名", arrivalAt: at(20) },
    ];
    getBusVehicleStopTimes.mockResolvedValue(
      new Map([
        ["A", at(3)],
        ["B1", at(10)],
        ["B2", at(14)],
        ["C", at(26)],
      ]),
    );
    expect(await getPlannedBusArrivals("plan", 0)).toMatchObject({
      ok: true,
      directions: [
        {
          stopCount: 4,
          stops: [
            { seq: 1, stopUid: "A", name: "上車站", estimateMinutes: 8 },
            { seq: 2, stopUid: "B1", name: "中途一", estimateMinutes: 15 },
            { seq: 3, stopUid: "B2", name: "中途二", estimateMinutes: 19 },
            { seq: 4, stopUid: "C", name: "下車站", estimateMinutes: 31 },
          ],
        },
      ],
    });
    expect(getBusVehicleStopTimes).toHaveBeenCalledWith(
      expect.objectContaining({
        subRouteUid: "TPE307",
        direction: 0,
        plateNumb: "CHOSEN",
        stopIds: ["A", "B1", "B2", "C"],
      }),
    );
  });
  it("keeps untimed route stops visible when a sparse timetable is the only available timing", async () => {
    leg.scheduledTrip!.stops = [
      { stopUid: "A", name: "A", departureAt: at(0) },
      { stopUid: "C", name: "C", arrivalAt: at(20) },
    ];
    getBusVehicleStopTimes.mockResolvedValue(new Map());
    expect(await getPlannedBusArrivals("plan", 0)).toMatchObject({
      ok: true,
      directions: [
        {
          stopCount: 3,
          stops: [
            {
              seq: 1,
              stopUid: "A",
              name: "A",
              estimateMinutes: null,
              statusLabel: "10:00",
            },
            {
              seq: 2,
              stopUid: "B",
              name: "B",
              estimateMinutes: null,
              statusLabel: "",
            },
            {
              seq: 3,
              stopUid: "C",
              name: "C",
              estimateMinutes: null,
              statusLabel: "10:20",
            },
          ],
        },
      ],
    });
  });
  it("retains all timetable stops when an older leg has no intermediateStops", async () => {
    delete leg.intermediateStops;
    const result = await getPlannedBusArrivals("plan", 0);
    expect(result).toMatchObject({
      ok: true,
      directions: [
        {
          stops: [
            { stopUid: "A", estimateMinutes: 8 },
            { stopUid: "B", estimateMinutes: 19 },
            { stopUid: "C", estimateMinutes: 31 },
          ],
        },
      ],
    });
    expect(getBusVehicleStopTimes).toHaveBeenCalledWith(
      expect.objectContaining({
        stopIds: expect.arrayContaining(["A", "B", "C"]),
      }),
    );
  });
  it("keeps the same service after boarding instead of optimizing to a later bus", async () => {
    vi.setSystemTime(at(8));
    getBusVehicleStopTimes.mockResolvedValue(
      new Map([
        ["B", at(14)],
        ["C", at(26)],
      ]),
    );
    const result = await getPlannedBusArrivals("plan", 0);
    expect(result).toMatchObject({
      ok: true,
      departureCandidates: [
        {
          candidateId: "original",
          plateNumb: "CHOSEN",
          selected: true,
          alightingTime: "2030-01-01T10:26:00.000+08:00",
        },
        {},
      ],
    });
    expect(getCanonicalBusPair).not.toHaveBeenCalled();
  });
  it("shows per-stop timetable labels during an outage and marks endpoint times as schedule", async () => {
    getBusVehicleStopTimes.mockRejectedValue(new Error("outage"));
    expect(await getPlannedBusArrivals("plan", 0)).toMatchObject({
      ok: true,
      directions: [
        {
          stops: [
            { estimateMinutes: null, statusLabel: "10:00" },
            { estimateMinutes: null, statusLabel: "10:10" },
            { estimateMinutes: null, statusLabel: "10:20" },
          ],
        },
      ],
      departureCandidates: [
        {
          plateNumb: "CHOSEN",
          boardingTimeSource: "schedule",
          alightingTimeSource: "schedule",
        },
        {},
      ],
    });
  });
  it("marks unavailable live-only endpoint times unknown instead of reusing stale ETAs", async () => {
    delete leg.scheduledTrip;
    getBusVehicleStopTimes.mockResolvedValue(new Map());
    expect(await getPlannedBusArrivals("plan", 0)).toMatchObject({
      ok: true,
      departureCandidates: [
        {
          plateNumb: "CHOSEN",
          selected: true,
          boardingTime: null,
          alightingTime: null,
          estimatedWaitMinutes: null,
          boardingTimeSource: "unknown",
          alightingTimeSource: "unknown",
        },
        {},
      ],
    });
    expect(getCanonicalBusPair).not.toHaveBeenCalled();
  });
});
