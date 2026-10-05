import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  taichung: vi.fn(),
  keelung: vi.fn(),
  hsinchu: vi.fn(),
  upsert: vi.fn(),
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
      taichung: { seen: 2, written: 2 },
      keelung: { seen: 1, written: 1 },
      hsinchu: { seen: 0, written: 0 },
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
    expect(result.hsinchu).toEqual({ seen: 1, written: 1 });
    expect(mocks.upsert).toHaveBeenCalledTimes(2);
  });
});
