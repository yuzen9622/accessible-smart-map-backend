import { beforeEach, describe, expect, it, vi } from "vitest";
import { GtfsStop } from "../../../model/gtfs-stop.model";
import { GtfsPathway } from "../../../model/gtfs-pathway.model";
import type { MetroLeg, WalkLeg } from "../../../types/route";
import * as indoor from "./indoor-graph";
import { enrichLegIndoor } from "./route-a11y";

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

function deferred() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

let gate: ReturnType<typeof deferred>;

type AccessLookup = typeof indoor.getStationAccess;
type AccessArgs = Parameters<AccessLookup>;

function scopedLookup(): AccessLookup {
  const create = Reflect.get(indoor, "createStationAccessLookup") as
    (() => AccessLookup) | undefined;
  return create ? create() : indoor.getStationAccess;
}

function stationQueries() {
  return vi
    .mocked(GtfsStop.find)
    .mock.calls.filter(
      ([query]) => (query as { locationType?: number }).locationType === 1,
    ).length;
}

function legs() {
  return {
    rail: {
      type: "METRO",
      departureStation: station.name,
      arrivalStation: station.name,
      facilityHighlights: [],
    } as unknown as MetroLeg,
    walkIn: { type: "WALK" } as WalkLeg,
    walkOut: { type: "WALK" } as WalkLeg,
  };
}

function enrich(value: ReturnType<typeof legs>, lookup: AccessLookup) {
  return enrichLegIndoor(
    value.rail,
    value.walkIn,
    value.walkOut,
    coords,
    coords,
    coords,
    coords,
    "wheelchair",
    lookup,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  gate = deferred();
  vi.mocked(GtfsStop.find).mockImplementation((query: unknown) => {
    const filter = query as Record<string, unknown>;
    const rows = stops.filter((stop) =>
      Object.entries(filter).every(([key, value]) => {
        const actual = (stop as Record<string, unknown>)[key];
        return value instanceof RegExp
          ? typeof actual === "string" && value.test(actual)
          : actual === value;
      }),
    );
    const pending = gate;
    const chain = {
      select: () => chain,
      lean: async () => {
        if (filter.locationType === 1) await pending.promise;
        return structuredClone(rows);
      },
    };
    return chain as never;
  });
  vi.mocked(GtfsPathway.countDocuments).mockResolvedValue(0);
  vi.mocked(GtfsPathway.find).mockReturnValue({
    lean: async () => [
      {
        fromStopId: "IN",
        toStopId: "P",
        pathwayMode: 1,
        isBidirectional: 0,
        traversalTime: 30,
      },
      {
        fromStopId: "P",
        toStopId: "OUT",
        pathwayMode: 1,
        isBidirectional: 0,
        traversalTime: 30,
      },
    ],
  } as never);
});

describe("request-owned pending station access", () => {
  it("coalesces concurrent enrichment without sharing mutable entrance coordinates", async () => {
    const lookup = scopedLookup();
    const first = legs();
    const second = legs();
    const work = Promise.all([enrich(first, lookup), enrich(second, lookup)]);
    try {
      expect(stationQueries()).toBe(2);
    } finally {
      gate.resolve();
      await work;
    }
    expect(first).toEqual(second);
    expect(first.walkIn.exitInfo).toMatchObject({
      exitName: "入口1",
      type: "ramp",
      coords,
    });
    expect(first.walkOut.exitInfo?.exitName).toBe("出口2");
    expect(first.rail.facilityHighlights).toHaveLength(2);
    first.walkIn.exitInfo!.coords![0] = 0;
    first.walkOut.exitInfo!.coords![0] = 0;
    expect(second.walkIn.exitInfo?.coords).toEqual(coords);
    expect(second.walkOut.exitInfo?.coords).toEqual([121.5001, 25]);
  });

  it("does not share pending reads between enrichment scopes", async () => {
    const work = Promise.all([
      scopedLookup()(station, coords),
      scopedLookup()(station, coords),
    ]);
    try {
      expect(stationQueries()).toBe(2);
    } finally {
      gate.resolve();
      await work;
    }
  });

  const distinct: [string, AccessArgs][] = [
    [
      "station name",
      [{ ...station, name: "其他站" }, coords, "wheelchair", "ingress"],
    ],
    [
      "station coordinates",
      [
        { ...station, coords: [121.500000001, 25] },
        coords,
        "wheelchair",
        "ingress",
      ],
    ],
    [
      "user coordinates",
      [station, [121.500000001, 25], "wheelchair", "ingress"],
    ],
    ["accessibility mode", [station, coords, "normal", "ingress"]],
    ["traversal direction", [station, coords, "wheelchair", "egress"]],
  ];
  it.each(distinct)("keeps exact %s inputs separate", async (_name, args) => {
    const lookup = scopedLookup();
    const work = Promise.all([
      lookup(station, coords, "wheelchair", "ingress"),
      lookup(...args),
    ]);
    try {
      expect(stationQueries()).toBe(2);
    } finally {
      gate.resolve();
      await work;
    }
  });

  it("re-reads after successful settlement rather than caching completed access", async () => {
    gate.resolve();
    const lookup = scopedLookup();
    const first = await lookup(station, coords);
    const second = await lookup(station, coords);
    expect(first?.stepFree).toBe(true);
    expect(second).toEqual(first);
    expect(stationQueries()).toBe(2);
  });

  it("removes a null result after a real model failure so the next read can recover", async () => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const lookup = scopedLookup();
      const work = Promise.all([
        lookup(station, coords),
        lookup(station, coords),
      ]);
      gate.reject(new Error("temporary GTFS read error"));
      expect(await work).toEqual([null, null]);
      expect(stationQueries()).toBe(1);
      gate = deferred();
      gate.resolve();
      expect((await lookup(station, coords))?.stepFree).toBe(true);
      expect(stationQueries()).toBe(2);
    } finally {
      warning.mockRestore();
    }
  });
});
