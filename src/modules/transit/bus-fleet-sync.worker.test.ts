import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  taichung: vi.fn(),
  keelung: vi.fn(),
  hsinchu: vi.fn(),
  upsert: vi.fn(),
  sightings: vi.fn(),
  routeIndex: vi.fn(),
}));

vi.mock("../../adapters/taichung-bus.adapter", () => ({
  fetchTaichungFleet: mocks.taichung,
}));
vi.mock("../../adapters/keelung-bus.adapter", () => ({
  fetchKeelungFleet: mocks.keelung,
}));
vi.mock("../../adapters/hsinchu-bus.adapter", () => ({
  fetchHsinchuFleet: mocks.hsinchu,
}));
vi.mock("./bus.repository", () => ({
  upsertVehicleObservations: mocks.upsert,
}));

vi.mock("./bus-fleet.repository", () => ({
  recordFleetSightings: mocks.sightings,
  loadRouteIndex: mocks.routeIndex,
}));

import { syncBusFleet } from "./bus-fleet-sync.worker";

const obs = (plateNumb: string, source: string) => ({
  plateNumb,
  city: "X",
  isLowFloor: 1 as const,
  source,
});

describe("syncBusFleet", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.upsert.mockImplementation(async (rows: unknown[]) => rows.length);
    mocks.sightings.mockImplementation(async (rows: unknown[]) => rows.length);
    mocks.routeIndex.mockResolvedValue({
      routeUids: new Set(["TXG54"]),
      routeUidBySubRoute: new Map([["HSZ011001", "HSZ0110"]]),
    });
  });

  it("writes every source's observations and reports per-source counts", async () => {
    mocks.taichung.mockResolvedValue([
      obs("KKA-6319", "taichung-ebus"),
      obs("552-U8", "taichung-ebus"),
    ]);
    mocks.keelung.mockResolvedValue([obs("FAC-157", "keelung-ebus")]);
    mocks.hsinchu.mockResolvedValue([]);

    const result = await syncBusFleet();

    expect(result).toEqual({
      taichung: { seen: 2, written: 2, sightings: 0, unresolvedRoutes: 0 },
      keelung: { seen: 1, written: 1 },
      hsinchu: { seen: 0, written: 0, sightings: 0, unresolvedRoutes: 0 },
    });
    expect(mocks.upsert).toHaveBeenCalledTimes(3);
    expect(mocks.taichung).toHaveBeenCalledWith(
      expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
    );
  });

  it("keeps syncing the other sources when one source fails", async () => {
    mocks.taichung.mockRejectedValue(new Error("Taichung ebus HTTP 502"));
    mocks.keelung.mockResolvedValue([obs("FAC-157", "keelung-ebus")]);
    mocks.hsinchu.mockResolvedValue([obs("FAD-233", "hsinchu-ibus")]);

    const result = await syncBusFleet();

    expect(result.taichung).toEqual({ error: "Taichung ebus HTTP 502" });
    expect(result.keelung).toEqual({ seen: 1, written: 1 });
    expect(result.hsinchu).toEqual({
      seen: 1,
      written: 1,
      sightings: 0,
      unresolvedRoutes: 0,
    });
    expect(mocks.upsert).toHaveBeenCalledTimes(2);
  });

  it("records sightings only for routes that resolve to exactly one TDX route", async () => {
    mocks.taichung.mockResolvedValue([
      { ...obs("KKA-6319", "taichung-ebus"), cityRouteIds: ["54", "999"] },
    ]);
    mocks.keelung.mockResolvedValue([
      { ...obs("FAC-157", "keelung-ebus"), cityRouteIds: ["17994"] },
    ]);
    mocks.hsinchu.mockResolvedValue([
      { ...obs("FAD-233", "hsinchu-ibus"), cityRouteIds: ["HSZ011001_1"] },
    ]);

    const result = await syncBusFleet();

    expect(mocks.sightings).toHaveBeenCalledWith(
      [{ plateNumb: "KKA-6319", routeUid: "TXG54" }],
      "taichung-ebus",
    );
    expect(mocks.sightings).toHaveBeenCalledWith(
      [{ plateNumb: "FAD-233", routeUid: "HSZ0110" }],
      "hsinchu-ibus",
    );
    expect(mocks.sightings).toHaveBeenCalledTimes(2);
    expect(result.taichung).toMatchObject({
      sightings: 1,
      unresolvedRoutes: 1,
    });
    expect(result.keelung).toEqual({ seen: 1, written: 1 });
  });
});
