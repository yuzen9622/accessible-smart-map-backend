import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AccessibleRoute } from "../../../types/route";

const { tdxFetch } = vi.hoisted(() => ({
  tdxFetch: vi.fn(),
}));
const { findVehiclesByPlate } = vi.hoisted(() => ({
  findVehiclesByPlate: vi.fn(),
}));

vi.mock("../../../config/fetch", () => ({ tdxFetch }));
vi.mock("../../transit/bus.repository", () => ({ findVehiclesByPlate }));

import {
  overlayRealtimeTransit,
  recoverRailTrainNos,
} from "./realtime-transit";

const originalUseRealtimeTransit = process.env.USE_REALTIME_TRANSIT;

beforeEach(() => {
  vi.clearAllMocks();
  findVehiclesByPlate.mockResolvedValue([]);
  process.env.USE_REALTIME_TRANSIT = "true";
});

afterEach(() => {
  if (originalUseRealtimeTransit === undefined) {
    delete process.env.USE_REALTIME_TRANSIT;
  } else {
    process.env.USE_REALTIME_TRANSIT = originalUseRealtimeTransit;
  }
});

describe("future scheduled realtime handling", () => {
  it("skips a same-day continuation by its absolute departure instant", async () => {
    const queryTime = new Date("2030-01-01T02:00:00+08:00");
    const route: AccessibleRoute = {
      routeId: "future-bus",
      routeName: "NEXT",
      totalMinutes: 500,
      transferCount: 0,
      legs: [
        {
          type: "BUS",
          routeName: "NEXT",
          departureStop: "起站",
          arrivalStop: "終站",
          departureStopId: "TPE-A",
          arrivalStopId: "TPE-B",
          departureTime: "14:00",
          arrivalTime: "15:00",
          waitInfo: { time: "14:00", source: "schedule" },
          direction: 0,
          polyline: [],
          departureStopA11y: [],
          arrivalStopA11y: [],
        },
      ],
      accessibilityHighlights: [],
      _scheduledDepartureTime: new Date("2030-01-01T14:00:00+08:00").getTime(),
      _scheduledEndTime: new Date("2030-01-01T15:00:00+08:00").getTime(),
      _isFutureScheduled: true,
    };
    tdxFetch.mockResolvedValue({
      ok: true,
      json: async () => [
        {
          StopName: { Zh_tw: "起站" },
          Direction: 0,
          EstimateTime: 60,
          StopStatus: 0,
        },
      ],
    });

    await overlayRealtimeTransit([route], { departureTime: queryTime });

    expect(tdxFetch).not.toHaveBeenCalled();
    expect(route.totalMinutes).toBe(500);
    expect(route.legs[0]).toMatchObject({
      departureTime: "14:00",
      waitInfo: { time: "14:00", source: "schedule" },
    });
    expect(route.legs[0]).not.toHaveProperty("estimatedWaitMinutes");
  });

  it("uses the absolute scheduled date for TRA timetable recovery", async () => {
    const route: AccessibleRoute = {
      routeId: "future-tra",
      routeName: "臺鐵",
      totalMinutes: 60,
      transferCount: 0,
      legs: [
        {
          type: "TRA",
          trainNo: "臺鐵",
          trainTypeName: "",
          departureStation: "斗六",
          arrivalStation: "臺中",
          departureStationUID: "",
          arrivalStationUID: "",
          departureTime: "06:20",
          arrivalTime: "07:20",
          rideMinutes: 60,
          waitInfo: { time: "06:20", source: "schedule" },
          polyline: [],
          departureStationA11y: [],
          arrivalStationA11y: [],
          facilityHighlights: [],
        },
      ],
      accessibilityHighlights: [],
      _scheduledDepartureTime: new Date("2030-01-02T06:20:00+08:00").getTime(),
      _scheduledEndTime: new Date("2030-01-02T07:20:00+08:00").getTime(),
      _isFutureScheduled: true,
    };
    tdxFetch
      .mockResolvedValueOnce({
        ok: true,
        json: async () => [
          { StationID: "3470", StationName: { Zh_tw: "斗六" } },
          { StationID: "3300", StationName: { Zh_tw: "臺中" } },
        ],
      })
      .mockResolvedValueOnce({ ok: true, json: async () => [] });

    await recoverRailTrainNos([route]);

    expect(tdxFetch).toHaveBeenCalledTimes(2);
    expect(tdxFetch.mock.calls[1][0]).toContain("2030-01-02");
  });
});

describe("bus low-floor enrichment", () => {
  /** Each test needs a unique route name: the ETA cache is keyed by URL. */
  function busRoute(routeName: string, stop: string): AccessibleRoute {
    return {
      routeId: `r-${routeName}`,
      routeName,
      totalMinutes: 30,
      transferCount: 0,
      legs: [
        {
          type: "BUS",
          routeName,
          departureStop: stop,
          arrivalStop: "終站",
          departureStopId: "TPE-A",
          arrivalStopId: "TPE-B",
          departureTime: "10:00",
          arrivalTime: "10:20",
          waitInfo: { time: "10:00", source: "schedule" },
          estimatedWaitMinutes: 5,
          direction: 0,
          polyline: [],
          departureStopA11y: [],
          arrivalStopA11y: [],
        },
      ],
      accessibilityHighlights: [],
    };
  }

  const alight = {
    StopName: { Zh_tw: "終站" },
    Direction: 0,
    EstimateTime: 1200,
    StopStatus: 0,
    StopSequence: 20,
  };

  it("attaches the plate and measured low-floor flags", async () => {
    const route = busRoute("LF1", "低地板站");
    tdxFetch.mockResolvedValue({
      ok: true,
      json: async () => [
        {
          StopName: { Zh_tw: "低地板站" },
          Direction: 0,
          EstimateTime: 180,
          StopStatus: 0,
          StopSequence: 5,
          PlateNumb: "KEA-1234",
        },
        alight,
      ],
    });
    findVehiclesByPlate.mockResolvedValue([
      { plateNumb: "KEA-1234", isLowFloor: 1, hasLiftOrRamp: 1 },
    ]);

    await overlayRealtimeTransit([route]);

    const leg = route.legs[0];
    expect(leg).toMatchObject({
      plateNumb: "KEA-1234",
      isLowFloor: true,
      hasLiftOrRamp: true,
      waitInfo: { time: 3, source: "realtime" },
      estimatedWaitMinutes: 3,
    });
    expect(leg).not.toHaveProperty("lowFloorAlternative");
    expect(route.accessibilityHighlights).toEqual([]);
  });

  it("leaves isLowFloor absent when the plate has no vehicle record", async () => {
    const route = busRoute("LF2", "未知站");
    tdxFetch.mockResolvedValue({
      ok: true,
      json: async () => [
        {
          StopName: { Zh_tw: "未知站" },
          Direction: 0,
          EstimateTime: 180,
          StopStatus: 0,
          StopSequence: 5,
          PlateNumb: "UNK-0001",
        },
        alight,
      ],
    });
    findVehiclesByPlate.mockResolvedValue([]);

    await overlayRealtimeTransit([route]);

    const leg = route.legs[0];
    expect(leg).toMatchObject({ plateNumb: "UNK-0001" });
    expect(leg).not.toHaveProperty("isLowFloor");
    expect(leg).not.toHaveProperty("hasLiftOrRamp");
    expect(route.accessibilityHighlights).toEqual([]);
  });

  it("reports a later low-floor bus from the same ETA batch", async () => {
    const route = busRoute("LF3", "高底盤站");
    tdxFetch.mockResolvedValue({
      ok: true,
      json: async () => [
        {
          StopName: { Zh_tw: "高底盤站" },
          Direction: 0,
          EstimateTime: 120,
          StopStatus: 0,
          StopSequence: 5,
          PlateNumb: "KEA-1234",
        },
        {
          StopName: { Zh_tw: "高底盤站" },
          Direction: 0,
          EstimateTime: 720,
          StopStatus: 0,
          StopSequence: 5,
          PlateNumb: "KEB-5678",
        },
        alight,
      ],
    });
    findVehiclesByPlate.mockResolvedValue([
      { plateNumb: "KEA-1234", isLowFloor: 0 },
      { plateNumb: "KEB-5678", isLowFloor: 1 },
    ]);

    await overlayRealtimeTransit([route]);

    const leg = route.legs[0];
    expect(leg).toMatchObject({
      plateNumb: "KEA-1234",
      isLowFloor: false,
      lowFloorAlternative: {
        plateNumb: "KEB-5678",
        etaMinutes: 12,
        stopsAway: null,
      },
    });
    expect(route.accessibilityHighlights[0]).toContain("高底盤");
    // The same-stop batch answered it, so RealTimeByFrequency is never called.
    expect(tdxFetch).toHaveBeenCalledTimes(1);
  });

  it("falls back to an upstream on-road low-floor vehicle", async () => {
    const route = busRoute("LF4", "單筆站");
    tdxFetch
      .mockResolvedValueOnce({
        ok: true,
        json: async () => [
          {
            StopName: { Zh_tw: "單筆站" },
            Direction: 0,
            EstimateTime: 120,
            StopStatus: 0,
            StopSequence: 10,
            PlateNumb: "KEA-1234",
          },
          alight,
        ],
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => [
          { PlateNumb: "KEC-9", Direction: 0, StopSequence: 7 },
        ],
      });
    findVehiclesByPlate.mockImplementation(async (plates: string[]) =>
      plates.includes("KEC-9")
        ? [{ plateNumb: "KEC-9", isLowFloor: 1 }]
        : [{ plateNumb: "KEA-1234", isLowFloor: 0 }],
    );

    await overlayRealtimeTransit([route]);

    expect(route.legs[0]).toMatchObject({
      isLowFloor: false,
      lowFloorAlternative: {
        plateNumb: "KEC-9",
        etaMinutes: null,
        stopsAway: 3,
      },
    });
  });

  it("keeps the ETA overlay intact when the vehicle lookup fails", async () => {
    const route = busRoute("LF5", "斷線站");
    tdxFetch.mockResolvedValue({
      ok: true,
      json: async () => [
        {
          StopName: { Zh_tw: "斷線站" },
          Direction: 0,
          EstimateTime: 180,
          StopStatus: 0,
          StopSequence: 5,
          PlateNumb: "KEA-1234",
        },
        alight,
      ],
    });
    findVehiclesByPlate.mockRejectedValue(new Error("db down"));

    await expect(overlayRealtimeTransit([route])).resolves.toBeUndefined();

    const leg = route.legs[0];
    expect(leg).toMatchObject({
      plateNumb: "KEA-1234",
      waitInfo: { time: 3, source: "realtime" },
      estimatedWaitMinutes: 3,
    });
    expect(leg).not.toHaveProperty("isLowFloor");
    expect(route.totalMinutes).toBe(28);
  });
});
