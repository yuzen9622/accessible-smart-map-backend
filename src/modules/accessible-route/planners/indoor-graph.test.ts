import { beforeEach, describe, expect, it, vi } from "vitest";
import { GtfsStop } from "../../../model/gtfs-stop.model";
import { GtfsPathway } from "../../../model/gtfs-pathway.model";
import { getStationAccess, stationHasElevator } from "./indoor-graph";
import { enrichLegIndoor } from "./route-a11y";
import type { MetroLeg, WalkLeg } from "../../../types/route";

vi.mock("../../../model/gtfs-stop.model", () => ({
  GtfsStop: { find: vi.fn() },
}));
vi.mock("../../../model/gtfs-pathway.model", () => ({
  GtfsPathway: { find: vi.fn(), countDocuments: vi.fn() },
}));

const coords: [number, number] = [121.5, 25];
const station = { name: "測試站", coords };
const stops = [
  {
    stopId: "S",
    stopName: station.name,
    locationType: 1,
    location: { coordinates: coords },
  },
  {
    stopId: "IN",
    stopName: "入口1",
    parentStation: "S",
    locationType: 2,
    location: { coordinates: coords },
  },
  {
    stopId: "OUT",
    stopName: "出口2",
    parentStation: "S",
    locationType: 2,
    location: { coordinates: [121.5001, 25] },
  },
  {
    stopId: "P",
    stopName: "月台",
    parentStation: "S",
    locationType: 0,
    location: { coordinates: coords },
  },
];

function setPathways(
  rows: {
    fromStopId: string;
    toStopId: string;
    isBidirectional: number;
    pathwayMode?: number;
  }[],
) {
  vi.mocked(GtfsPathway.find).mockReturnValue({
    lean: async () =>
      rows.map((row) => ({ pathwayMode: 1, traversalTime: 30, ...row })),
  } as never);
}

beforeEach(() => {
  vi.mocked(GtfsStop.find).mockImplementation((query: unknown) => {
    const rows = stops.filter((stop) =>
      Object.entries(query as object).every(
        ([key, value]) => (stop as Record<string, unknown>)[key] === value,
      ),
    );
    const chain = { select: () => chain, lean: async () => rows };
    return chain as never;
  });
  vi.mocked(GtfsPathway.countDocuments).mockResolvedValue(0);
  setPathways([
    { fromStopId: "IN", toStopId: "P", isBidirectional: 0 },
    { fromStopId: "P", toStopId: "OUT", isBidirectional: 0 },
  ]);
});

describe("station access through directed pathways", () => {
  it("selects different ingress and egress portals through one-way gates", async () => {
    expect((await getStationAccess(station, coords))?.entrance?.stopId).toBe(
      "IN",
    );
    expect(
      (await getStationAccess(station, coords, "wheelchair", "egress"))
        ?.entrance?.stopId,
    ).toBe("OUT");
  });

  it("does not claim an ingress-only station has a usable exit", async () => {
    setPathways([{ fromStopId: "IN", toStopId: "P", isBidirectional: 0 }]);
    expect((await getStationAccess(station, coords))?.stepFree).toBe(true);
    expect(
      (await getStationAccess(station, coords, "wheelchair", "egress"))
        ?.stepFree,
    ).toBe(false);
  });

  it("keeps bidirectional access and wheelchair stairs exclusions", async () => {
    setPathways([{ fromStopId: "IN", toStopId: "P", isBidirectional: 1 }]);
    expect(
      (await getStationAccess(station, coords, "wheelchair", "egress"))
        ?.stepFree,
    ).toBe(true);
    setPathways([
      { fromStopId: "P", toStopId: "OUT", isBidirectional: 0, pathwayMode: 2 },
    ]);
    expect(
      (await getStationAccess(station, coords, "wheelchair", "egress"))
        ?.stepFree,
    ).toBe(false);
  });

  it("wires rail boarding and alighting guidance to their actual directions", async () => {
    const rail = {
      type: "METRO",
      departureStation: station.name,
      arrivalStation: station.name,
      facilityHighlights: [],
    } as unknown as MetroLeg;
    const walkIn = { type: "WALK" } as WalkLeg;
    const walkOut = { type: "WALK" } as WalkLeg;
    await enrichLegIndoor(
      rail,
      walkIn,
      walkOut,
      coords,
      coords,
      coords,
      coords,
    );
    expect(walkIn.exitInfo?.exitName).toBe("入口1");
    expect(walkOut.exitInfo?.exitName).toBe("出口2");
  });
});

function nodeLookupCount(): number {
  return vi.mocked(GtfsStop.find).mock.calls.filter(([query]) => {
    const filter = query as Record<string, unknown>;
    return filter.parentStation === "S" && !("locationType" in filter);
  }).length;
}

function rejectNodeLookups(times: number): void {
  const original = vi.mocked(GtfsStop.find).getMockImplementation();
  if (!original) throw new Error("Missing stop-query fixture");
  vi.mocked(GtfsStop.find).mockImplementation((query: unknown) => {
    const filter = query as Record<string, unknown>;
    if (
      filter.parentStation === "S" &&
      !("locationType" in filter) &&
      times-- > 0
    ) {
      const chain = {
        select: () => chain,
        lean: async () => {
          throw new Error("temporary node lookup failure");
        },
      };
      return chain as never;
    }
    return original(query as never);
  });
}

describe("station-access lookup reuse", () => {
  beforeEach(() => {
    vi.mocked(GtfsStop.find).mockClear();
    vi.mocked(GtfsPathway.countDocuments).mockClear();
  });

  it("reads nodes once while retaining the elevator count and directed path", async () => {
    const result = await getStationAccess(station, coords);
    expect(result).toMatchObject({
      hasElevator: false,
      stepFree: true,
      usesElevator: false,
      entrance: { stopId: "IN" },
    });
    expect(nodeLookupCount()).toBe(1);
    expect(GtfsPathway.countDocuments).toHaveBeenCalledExactlyOnceWith({
      fromStopId: { $in: ["IN", "OUT", "P", "S"] },
      pathwayMode: 5,
    });
  });

  it("retries a failed node lookup for path resolution without inventing an elevator", async () => {
    rejectNodeLookups(1);
    const result = await getStationAccess(station, coords);
    expect(result).toMatchObject({ hasElevator: false, stepFree: true });
    expect(nodeLookupCount()).toBe(2);
    expect(GtfsPathway.countDocuments).not.toHaveBeenCalled();
  });

  it("retains the original node reread after a failed elevator count", async () => {
    vi.mocked(GtfsPathway.countDocuments).mockRejectedValueOnce(
      new Error("count failed"),
    );
    const result = await getStationAccess(station, coords);
    expect(result).toMatchObject({ hasElevator: false, stepFree: true });
    expect(nodeLookupCount()).toBe(2);
    expect(GtfsPathway.countDocuments).toHaveBeenCalledTimes(1);
  });

  it("still returns null if both node lookups fail", async () => {
    rejectNodeLookups(2);
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect(await getStationAccess(station, coords)).toBeNull();
      expect(nodeLookupCount()).toBe(2);
      expect(warning).toHaveBeenCalled();
    } finally {
      warning.mockRestore();
    }
  });

  it("does not reuse nodes or elevator facts across access resolutions", async () => {
    expect((await getStationAccess(station, coords))?.hasElevator).toBe(false);
    const original = vi.mocked(GtfsStop.find).getMockImplementation();
    if (!original) throw new Error("Missing stop-query fixture");
    vi.mocked(GtfsStop.find).mockImplementation((query: unknown) => {
      const filter = query as Record<string, unknown>;
      if (filter.parentStation === "S" && !("locationType" in filter)) {
        const chain = {
          select: () => chain,
          lean: async () => [...stops.slice(1), { stopId: "FRESH" }],
        };
        return chain as never;
      }
      return original(query as never);
    });
    vi.mocked(GtfsPathway.countDocuments).mockResolvedValueOnce(1);
    const result = await getStationAccess(
      station,
      coords,
      "wheelchair",
      "egress",
    );
    expect(result).toMatchObject({
      hasElevator: true,
      entrance: { stopId: "OUT" },
    });
    expect(nodeLookupCount()).toBe(2);
    expect(GtfsPathway.countDocuments).toHaveBeenLastCalledWith({
      fromStopId: { $in: ["IN", "OUT", "P", "FRESH", "S"] },
      pathwayMode: 5,
    });
  });

  it("preserves the standalone boolean API including its failure fallback", async () => {
    expect(await stationHasElevator("S")).toBe(false);
    vi.mocked(GtfsPathway.countDocuments).mockResolvedValueOnce(1);
    expect(await stationHasElevator("S")).toBe(true);
    vi.mocked(GtfsPathway.countDocuments).mockRejectedValueOnce(
      new Error("count failed"),
    );
    expect(await stationHasElevator("S")).toBe(false);
  });
});
