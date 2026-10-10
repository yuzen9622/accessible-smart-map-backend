import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AccessibleRoute, BusLeg } from "../../../types/route";
import { attachBusSchedule } from "../route-schedule";
import { matchPlannedBus } from "../../transit/bus-trip-match";
import type { TdxEtaRecord } from "./realtime-transit.types";

const { tdxFetch, findVehiclesByPlate } = vi.hoisted(() => ({
  tdxFetch: vi.fn(),
  findVehiclesByPlate: vi.fn(async () => []),
}));
vi.mock("../../../config/fetch", () => ({ tdxFetch }));
vi.mock("../../transit/bus.repository", () => ({ findVehiclesByPlate }));
vi.mock("../../transit/bus-fleet.repository", () => ({
  recordRealtimeSightings: vi.fn(),
}));
import { overlayRealtimeTransit } from "./realtime-transit";

const at = (time: string) => Date.parse(`2030-01-01T${time}:00+08:00`);
let sequence = 0;
function planned(departure = "10:00", ready = "09:58", tripId = "trip-10") {
  const leg: BusLeg = {
    type: "BUS",
    routeName: `PLAN-${++sequence}`,
    subRouteUid: "TPE-A",
    subRouteName: "307",
    departureStop: "A",
    arrivalStop: "C",
    departureStopId: "TPE1",
    arrivalStopId: "TPE3",
    departureTime: departure,
    arrivalTime: "10:20",
    waitInfo: { source: "schedule", time: departure },
    estimatedWaitMinutes: 2,
    direction: 0,
    polyline: [],
    departureStopA11y: [],
    arrivalStopA11y: [],
  };
  attachBusSchedule(leg, at(departure), at(ready), tripId);
  return leg;
}
function record(overrides: Partial<TdxEtaRecord> = {}): TdxEtaRecord {
  return {
    SubRouteUID: "TPE-A",
    StopUID: "TPE1",
    StopName: { Zh_tw: "A" },
    Direction: 0,
    ScheduledTime: "10:00",
    PlateNumb: "BUS-10",
    EstimateTime: 8 * 60,
    StopStatus: 0,
    UpdateTime: new Date().toISOString(),
    ...overrides,
  };
}
function route(leg: BusLeg): AccessibleRoute {
  return {
    routeId: leg.routeName,
    routeName: leg.routeName,
    totalMinutes: 35,
    transferCount: 0,
    accessibilityHighlights: [],
    // The whole trip starts now, but the bus boards only after this walk.
    _scheduledDepartureTime: Date.now(),
    legs: [
      {
        type: "WALK",
        minutesEst:
          ((leg._boardingReadyTime ?? Date.now()) - Date.now()) / 60_000,
      } as AccessibleRoute["legs"][number],
      leg,
    ],
  };
}
beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(at("09:55"));
});
afterEach(() => vi.useRealTimers());

describe("planned bus identity and boarding feasibility", () => {
  it.each([
    {
      label: "another scheduled departure",
      change: { ScheduledTime: "09:50" },
    },
    {
      label: "missing schedule evidence",
      change: { ScheduledTime: undefined },
    },
    { label: "another branch", change: { SubRouteUID: "TPE-B" } },
    { label: "another stop with the same name", change: { StopUID: "TPE2" } },
    { label: "missing plate", change: { PlateNumb: undefined } },
    { label: "no vehicle", change: { PlateNumb: "-1" } },
    { label: "not dispatched", change: { StopStatus: 1 } },
    {
      label: "stale prediction",
      change: { UpdateTime: new Date(at("09:00")).toISOString() },
    },
    { label: "unknown direction", change: { Direction: 255 } },
    {
      label: "wrong direction without downstream proof",
      change: { Direction: 1 },
    },
  ])("rejects $label", ({ change }) => {
    expect(matchPlannedBus(planned(), [record(change)])).toBeNull();
  });

  it("rejects an ETA earlier than arrival on foot even for the planned bus", () => {
    expect(
      matchPlannedBus(planned("10:10", "10:05"), [
        record({ ScheduledTime: "10:10", EstimateTime: 60 }),
      ]),
    ).toBeNull();
  });

  it("does not interpret time proximity as a trip match", () => {
    expect(
      matchPlannedBus(planned(), [
        record({ EstimateTime: 300, ScheduledTime: undefined }),
      ]),
    ).toBeNull();
  });

  it("does not arbitrarily select between two matching vehicles", () => {
    expect(
      matchPlannedBus(planned(), [
        record(),
        record({ PlateNumb: "BUS-OTHER" }),
      ]),
    ).toBeNull();
  });

  it("retains a frequency-template schedule rather than inventing a specific trip", () => {
    expect(
      matchPlannedBus(planned("10:00", "09:58", "freqpatched_307"), [record()]),
    ).toBeNull();
  });

  it("keeps the 10:00 bus when the journey starts at 09:00", async () => {
    vi.setSystemTime(at("09:00"));
    const r = route(planned("10:00", "09:10"));
    const before = JSON.stringify(r);
    tdxFetch.mockResolvedValue({
      ok: true,
      json: async () => [record({ ScheduledTime: "09:05", EstimateTime: 300 })],
    });
    await overlayRealtimeTransit([r]);
    expect(JSON.stringify(r)).toBe(before);
    expect(tdxFetch).not.toHaveBeenCalled();
  });

  it.each(["2030-01-02T10:00:00+08:00", "2030-01-01T00:05:00+08:00"])(
    "does not reuse today's ETA for another boarding date (%s)",
    (departure) => {
      const leg = { ...planned() };
      attachBusSchedule(
        leg,
        Date.parse(departure),
        Date.parse(departure) - 60_000,
        "trip",
      );
      if (departure.includes("00:05"))
        vi.setSystemTime(Date.parse("2029-12-31T23:58:00+08:00"));
      expect(
        matchPlannedBus(leg, [
          record({ ScheduledTime: departure.slice(11, 16) }),
        ]),
      ).toBeNull();
    },
  );

  it.each([
    { EstimateTime: 120, ScheduledTime: "09:50" },
    {
      EstimateTime: undefined,
      StopStatus: 1,
      NextBusTime: "2030-01-01T10:10:00+08:00",
    },
    { EstimateTime: undefined, StopStatus: 3 },
  ])(
    "never changes the plan to the next bus or a current service status",
    async (change) => {
      const r = route(planned());
      const before = JSON.stringify(r);
      tdxFetch.mockResolvedValue({
        ok: true,
        json: async () => [record(change)],
      });
      await overlayRealtimeTransit([r]);
      expect(JSON.stringify(r)).toBe(before);
      expect(findVehiclesByPlate).not.toHaveBeenCalled();
    },
  );

  it("shows the matched delayed bus countdown while preserving planned clocks and walk-adjusted wait", async () => {
    const leg = planned();
    const r = route(leg);
    tdxFetch.mockResolvedValue({ ok: true, json: async () => [record()] });
    await overlayRealtimeTransit([r]);
    expect(leg).toMatchObject({
      departureTime: "10:00",
      arrivalTime: "10:20",
      estimatedWaitMinutes: 2,
      waitInfo: { source: "realtime", time: 8 },
      plateNumb: "BUS-10",
    });
    expect(r.totalMinutes).toBe(35);
    expect(JSON.stringify(leg)).not.toContain("_scheduled");
    expect(JSON.stringify(leg)).not.toContain("_boarding");
  });
});
