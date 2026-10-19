import { afterEach, describe, expect, it, vi } from "vitest";
const { tdxFetch } = vi.hoisted(() => ({ tdxFetch: vi.fn() }));
vi.mock("../../../config/fetch", () => ({ tdxFetch }));
vi.mock("../../transit/bus.repository", () => ({
  findVehiclesByPlate: vi.fn(async () => []),
}));
import {
  recoverRailTrainNos,
  overlayRealtimeTransit,
} from "./realtime-transit";
import {
  routeCandidateTimeline,
  selectFeasibleBusChain,
} from "../bus-stop-pair-candidates";
import type { AccessibleRoute, TraLeg } from "../../../types/route";
const at = (s: string) => Date.parse(s + "+08:00");
afterEach(() => vi.useRealTimers());
describe("rail absolute timeline synchronization", () => {
  it("recovers a post-midnight leg on its own service date and updates both absolute endpoints", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(at("2030-01-01T23:50:00"));
    const leg = {
      type: "TRA",
      departureStation: "甲",
      arrivalStation: "乙",
      departureStationUID: "A",
      arrivalStationUID: "B",
      departureTime: "00:01",
      arrivalTime: "00:10",
      trainNo: "old",
      trainTypeName: "區間",
      rideMinutes: 9,
      polyline: [],
      facilityHighlights: [],
      departureStationA11y: [],
      arrivalStationA11y: [],
      waitInfo: { time: "00:01", source: "schedule" },
    } as TraLeg;
    Object.defineProperties(leg, {
      _scheduledDepartureTime: {
        value: at("2030-01-02T00:01:00"),
        writable: true,
      },
      _scheduledArrivalTime: {
        value: at("2030-01-02T00:10:00"),
        writable: true,
      },
    });
    const route = {
      routeId: "rail",
      routeName: "rail",
      totalMinutes: 20,
      transferCount: 0,
      accessibilityHighlights: [],
      legs: [leg],
      _scheduledDepartureTime: at("2030-01-01T23:50:00"),
    } as AccessibleRoute;
    tdxFetch.mockImplementation(async (url: string) => ({
      ok: true,
      json: async () =>
        url.includes("Station?")
          ? [
              { StationID: "A", StationName: { Zh_tw: "甲" } },
              { StationID: "B", StationName: { Zh_tw: "乙" } },
            ]
          : [
              {
                DailyTrainInfo: { TrainNo: "new" },
                OriginStopTime: { DepartureTime: "00:03" },
                DestinationStopTime: { ArrivalTime: "00:15" },
              },
            ],
    }));
    await recoverRailTrainNos([route]);
    expect(tdxFetch.mock.calls.some(([u]) => u.includes("2030-01-02"))).toBe(
      true,
    );
    expect(leg._scheduledDepartureTime).toBe(at("2030-01-02T00:03:00"));
    expect(leg._scheduledArrivalTime).toBe(at("2030-01-02T00:15:00"));
    expect(Object.keys(leg)).not.toContain("_scheduledDepartureTime");
    expect(
      selectFeasibleBusChain(
        routeCandidateTimeline(route) ?? [],
        new Map(),
        at("2030-01-02T00:02:00"),
        "normal",
      )?.arrivalAt,
    ).toBe(at("2030-01-02T00:15:00"));
  });
  it("shifts rail absolute constraints by live delay without double-applying on repeated overlays", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(at("2030-02-01T10:00:00"));
    const leg = {
      type: "TRA",
      trainNo: "123",
      polyline: [],
      facilityHighlights: [],
      waitInfo: { time: 0, source: "schedule" },
      _scheduledDepartureTime: at("2030-02-01T10:01:00"),
      _scheduledArrivalTime: at("2030-02-01T10:20:00"),
    } as unknown as TraLeg;
    const route = {
      routeId: "delayed",
      routeName: "rail",
      totalMinutes: 20,
      transferCount: 0,
      legs: [leg],
      accessibilityHighlights: [],
    } as AccessibleRoute;
    tdxFetch.mockResolvedValue({
      ok: true,
      json: async () => [{ TrainNo: "123", DelayTime: 5 }],
    });
    await overlayRealtimeTransit([route]);
    await overlayRealtimeTransit([route]);
    expect(leg._scheduledDepartureTime).toBe(at("2030-02-01T10:06:00"));
    expect(leg._scheduledArrivalTime).toBe(at("2030-02-01T10:25:00"));
  });
});
