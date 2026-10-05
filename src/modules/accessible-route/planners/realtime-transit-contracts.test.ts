import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AccessibleRoute } from "../../../types/route";

const { tdxFetch } = vi.hoisted(() => ({ tdxFetch: vi.fn() }));
vi.mock("../../../config/fetch", () => ({ tdxFetch }));
vi.mock("../../transit/bus.repository", () => ({
  findVehiclesByPlate: vi.fn(async () => []),
}));
vi.mock("./otp-routing", () => ({
  fetchRailLegGeometry: vi.fn(async () => []),
}));
import {
  overlayRealtimeTransit,
  recoverRailTrainNos,
} from "./realtime-transit";

const now = new Date("2026-10-05T12:00:00+08:00");
const ago = (seconds: number) =>
  new Date(now.getTime() - seconds * 1000).toISOString();

function bus(name: string): AccessibleRoute {
  return {
    routeId: name,
    routeName: name,
    totalMinutes: 23,
    transferCount: 0,
    accessibilityHighlights: [],
    legs: [
      {
        type: "BUS",
        routeName: name,
        subRouteUid: name,
        subRouteName: name,
        departureStop: "起站",
        arrivalStop: "終站",
        departureStopId: "THB1",
        arrivalStopId: "THB2",
        departureTime: "12:03",
        arrivalTime: "12:23",
        // Scheduled GTFS directions remain 0/1; the live TDX data below uses 10.
        direction: 0,
        waitInfo: { time: "12:03", source: "schedule" },
        estimatedWaitMinutes: 3,
        polyline: [],
        departureStopA11y: [],
        arrivalStopA11y: [],
      },
    ],
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(now);
});
afterEach(() => vi.useRealTimers());

describe("real routing overlay consumes corrected TDX predictions", () => {
  it("does not replace an elapsed exact stop match with another stop sharing its name", async () => {
    tdxFetch.mockResolvedValue({
      ok: true,
      json: async () => [
        {
          StopName: { Zh_tw: "起站" },
          Direction: 10,
          EstimateTime: 30,
          SrcTransTime: ago(60),
          StopStatus: 0,
        },
        {
          StopName: { Zh_tw: "起站路口" },
          Direction: 10,
          EstimateTime: 180,
          SrcTransTime: ago(60),
          StopStatus: 0,
        },
      ],
    });
    const route = bus("EXACT_STOP_ELAPSED");
    await overlayRealtimeTransit([route]);
    expect(route.legs[0]).toMatchObject({
      waitInfo: { time: "12:03", source: "schedule" },
    });
  });
  it("supports Direction=10 and keeps counting down within the same cache entry", async () => {
    const rows = [
      {
        StopName: { Zh_tw: "起站" },
        Direction: 10,
        EstimateTime: 150,
        StopStatus: 0,
        StopSequence: 1,
        SrcTransTime: ago(60),
      },
      {
        StopName: { Zh_tw: "終站" },
        Direction: 10,
        EstimateTime: 1350,
        StopStatus: 0,
        StopSequence: 2,
        SrcTransTime: ago(60),
      },
    ];
    tdxFetch.mockResolvedValue({ ok: true, json: async () => rows });
    const first = bus("CACHE_CIRCLE");
    await overlayRealtimeTransit([first]);
    expect(first.legs[0]).toMatchObject({
      direction: 0,
      waitInfo: { time: 2, source: "realtime" },
    });
    vi.setSystemTime(new Date(now.getTime() + 20000));
    const second = bus("CACHE_CIRCLE");
    await overlayRealtimeTransit([second]);
    expect(second.legs[0]).toMatchObject({
      waitInfo: { time: 1, source: "realtime" },
    });
    expect(tdxFetch).toHaveBeenCalledTimes(1);
  });

  it.each(["retained", "elapsed"])(
    "does not overlay %s ETA as an arriving bus",
    async (kind) => {
      tdxFetch.mockResolvedValue({
        ok: true,
        json: async () => [
          {
            StopName: { Zh_tw: "起站" },
            Direction: 10,
            StopStatus: 0,
            EstimateTime: kind === "retained" ? 9000 : 30,
            SrcTransTime: ago(kind === "retained" ? 7200 : 60),
            UpdateTime: ago(0),
          },
        ],
      });
      const route = bus(`STALE_${kind}`);
      await overlayRealtimeTransit([route]);
      expect(route.legs[0]).toMatchObject({
        waitInfo: { time: "12:03", source: "schedule" },
        departureTime: "12:03",
      });
    },
  );

  it("selects a usable prediction after an elapsed record for the same stop", async () => {
    tdxFetch.mockResolvedValue({
      ok: true,
      json: async () => [
        {
          StopName: { Zh_tw: "起站" },
          Direction: 10,
          EstimateTime: 30,
          SrcTransTime: ago(60),
          StopStatus: 0,
        },
        {
          StopName: { Zh_tw: "起站" },
          Direction: 10,
          EstimateTime: 180,
          SrcTransTime: ago(60),
          StopStatus: 0,
        },
      ],
    });
    const route = bus("VALID_AFTER_ELAPSED");
    await overlayRealtimeTransit([route]);
    expect(route.legs[0]).toMatchObject({
      waitInfo: { time: 2, source: "realtime" },
    });
  });
});

describe("rail recovery uses suspension flags for the requested segment", () => {
  function rail(date: string): AccessibleRoute {
    return {
      routeId: date,
      routeName: "臺鐵",
      totalMinutes: 60,
      transferCount: 0,
      departureDate: date,
      accessibilityHighlights: [],
      legs: [
        {
          type: "TRA",
          trainNo: "臺鐵",
          trainTypeName: "",
          departureStation: "臺北",
          arrivalStation: "臺中",
          departureStationUID: "",
          arrivalStationUID: "",
          departureTime: "08:00",
          arrivalTime: "09:00",
          rideMinutes: 60,
          waitInfo: { time: "08:00", source: "schedule" },
          polyline: [],
          departureStationA11y: [],
          arrivalStationA11y: [],
          facilityHighlights: [],
        },
      ],
    };
  }
  it.each([
    {
      date: "2026-10-06",
      train: 1,
      origin: 0,
      destination: 0,
      expected: "臺鐵",
    },
    {
      date: "2026-10-07",
      train: 2,
      origin: 1,
      destination: 0,
      expected: "臺鐵",
    },
    {
      date: "2026-10-08",
      train: 2,
      origin: 0,
      destination: 1,
      expected: "臺鐵",
    },
    {
      date: "2026-10-09",
      train: 2,
      origin: 0,
      destination: 0,
      expected: "123",
    },
  ])(
    "$date: train=$train origin=$origin destination=$destination",
    async ({ date, train, origin, destination, expected }) => {
      tdxFetch.mockImplementation(async (url: string) => ({
        ok: true,
        json: async () =>
          url.includes("/Station?")
            ? [
                { StationID: "1000", StationName: { Zh_tw: "臺北" } },
                { StationID: "3300", StationName: { Zh_tw: "臺中" } },
              ]
            : [
                {
                  DailyTrainInfo: { TrainNo: "123", SuspendedFlag: train },
                  OriginStopTime: {
                    DepartureTime: "08:00",
                    SuspendedFlag: origin,
                  },
                  DestinationStopTime: {
                    ArrivalTime: "09:00",
                    SuspendedFlag: destination,
                  },
                },
              ],
      }));
      const route = rail(date);
      await recoverRailTrainNos([route]);
      expect(route.legs[0]).toMatchObject({ trainNo: expected });
    },
  );
});
