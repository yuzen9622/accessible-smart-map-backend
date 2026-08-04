import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AccessibleRoute } from "../../../types/route";

const { tdxFetch } = vi.hoisted(() => ({
  tdxFetch: vi.fn(),
}));

vi.mock("../../../config/fetch", () => ({ tdxFetch }));

import {
  overlayRealtimeTransit,
  recoverRailTrainNos,
} from "./realtime-transit";

const originalUseRealtimeTransit = process.env.USE_REALTIME_TRANSIT;

beforeEach(() => {
  vi.clearAllMocks();
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
      legs: [{
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
      }],
      accessibilityHighlights: [],
      _scheduledDepartureTime: new Date(
        "2030-01-01T14:00:00+08:00",
      ).getTime(),
      _scheduledEndTime: new Date("2030-01-01T15:00:00+08:00").getTime(),
      _isFutureScheduled: true,
    };
    tdxFetch.mockResolvedValue({
      ok: true,
      json: async () => [{
        StopName: { Zh_tw: "起站" },
        Direction: 0,
        EstimateTime: 60,
        StopStatus: 0,
      }],
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
      legs: [{
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
      }],
      accessibilityHighlights: [],
      _scheduledDepartureTime: new Date(
        "2030-01-02T06:20:00+08:00",
      ).getTime(),
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
