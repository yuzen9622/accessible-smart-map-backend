import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";
import ParkAreaModel from "../model/park-area.model";
import ParkEntranceModel from "../model/park-entrance.model";
import { findParkArrivalCandidates } from "../modules/a11y/a11y.service";
import {
  clearMongoTestDatabase,
  startMongoTest,
  stopMongoTest,
  type MongoTestContext,
} from "../../tests/helpers/mongo-test-harness";
import {
  parseImportArgs,
  syncParkAreas,
  syncParkEntrances,
} from "./import-taipei-park-entrances";
import type { ParkAreaDoc } from "./taipei-park-area-build";
import type { ParkEntranceDoc } from "./taipei-park-entrance-parse";

// ~200 m square around 青年公園's test entrances.
const SQUARE: [number, number][] = [
  [121.507, 25.022],
  [121.509, 25.022],
  [121.509, 25.024],
  [121.507, 25.024],
  [121.507, 25.022],
];

function area(
  parkName: string,
  ring: [number, number][],
  source: ParkAreaDoc["source"] = "osm",
): ParkAreaDoc {
  return {
    parkName,
    source,
    osmId: source === "osm" ? "way/1" : null,
    geometry: { type: "Polygon", coordinates: [ring] },
  };
}

function entrance(
  sourceId: string,
  coordinates: [number, number],
  overrides: Partial<ParkEntranceDoc> = {},
): ParkEntranceDoc {
  return {
    sourceId,
    district: "萬華區",
    parkName: "青年公園",
    entranceName: `${sourceId}號出入口`,
    location: { type: "Point", coordinates },
    minClearWidthM: 1.8,
    slopePercent: 8,
    ...overrides,
  };
}

describe("syncParkEntrances (real MongoDB)", () => {
  let mongo: MongoTestContext | undefined;

  beforeAll(async () => {
    mongo = await startMongoTest();
  });

  beforeEach(async () => {
    await ParkEntranceModel.syncIndexes();
    await ParkAreaModel.syncIndexes();
  });

  afterEach(async () => {
    await clearMongoTestDatabase();
  });

  afterAll(async () => {
    await stopMongoTest(mongo);
  });

  it("mirrors a release: updates kept rows, inserts new ones, prunes absent ones", async () => {
    await syncParkEntrances([
      entrance("1", [121.5084, 25.023]),
      entrance("2", [121.509, 25.027]),
    ]);

    const result = await syncParkEntrances([
      entrance("1", [121.5084, 25.023], { minClearWidthM: 2.4 }),
      entrance("3", [121.505, 25.025]),
    ]);

    expect(result).toEqual({ upserted: 2, inserted: 1, deleted: 1 });
    const stored = await ParkEntranceModel.find().sort({ sourceId: 1 }).lean();
    expect(stored.map((d) => d.sourceId)).toEqual(["1", "3"]);
    expect(stored[0].minClearWidthM).toBe(2.4);
  });

  it("refuses an empty release and leaves stored rows untouched", async () => {
    await syncParkEntrances([entrance("1", [121.5084, 25.023])]);

    await expect(syncParkEntrances([])).rejects.toThrow(/empty/);
    expect(await ParkEntranceModel.countDocuments()).toBe(1);
  });

  it("is queryable by distance through the 2dsphere index", async () => {
    await syncParkEntrances([
      entrance("near", [121.5084, 25.023]),
      entrance("far", [121.6, 25.1]),
    ]);

    const nearby = await ParkEntranceModel.find({
      location: {
        $near: {
          $geometry: { type: "Point", coordinates: [121.5085, 25.0231] },
          $maxDistance: 200,
        },
      },
    }).lean();
    expect(nearby.map((d) => d.sourceId)).toEqual(["near"]);
  });
});

describe("syncParkAreas + park arrival lookup (real MongoDB)", () => {
  let mongo: MongoTestContext | undefined;

  beforeAll(async () => {
    mongo = await startMongoTest();
  });

  beforeEach(async () => {
    await ParkEntranceModel.syncIndexes();
    await ParkAreaModel.syncIndexes();
  });

  afterEach(async () => {
    await clearMongoTestDatabase();
  });

  afterAll(async () => {
    await stopMongoTest(mongo);
  });

  it("stores areas that answer point-in-park and nearby-entrance queries", async () => {
    await syncParkEntrances([entrance("1", [121.508, 25.022])]);
    const stats = await syncParkAreas([
      { area: area("青年公園", SQUARE), fallback: null },
    ]);
    expect(stats).toMatchObject({ osm: 1, hull: 0, rejected: 0 });

    const inside = await findParkArrivalCandidates(25.023, 121.508, 600);
    expect(inside.containingParks).toEqual(["青年公園"]);
    expect(inside.nearbyEntrances.map((e) => e.sourceId)).toEqual(["1"]);
    expect(inside.parksWithArea).toEqual(["青年公園"]);

    const outside = await findParkArrivalCandidates(25.03, 121.52, 600);
    expect(outside.containingParks).toEqual([]);
    expect(outside.nearbyEntrances).toEqual([]);
  });

  it("falls back to the hull when MongoDB rejects the OSM outline", async () => {
    const bowTie: [number, number][] = [
      [121.507, 25.022],
      [121.509, 25.024],
      [121.509, 25.022],
      [121.507, 25.024],
      [121.507, 25.022],
    ];
    const stats = await syncParkAreas([
      {
        area: area("青年公園", bowTie),
        fallback: area("青年公園", SQUARE, "entrance_hull"),
      },
    ]);

    expect(stats).toMatchObject({ osm: 0, hull: 1, fellBack: 1, rejected: 0 });
    const stored = await ParkAreaModel.findOne({ parkName: "青年公園" }).lean();
    expect(stored?.source).toBe("entrance_hull");
  });

  it("prunes parks absent from the new build and refuses an empty build", async () => {
    await syncParkAreas([
      { area: area("青年公園", SQUARE), fallback: null },
      { area: area("舊公園", SQUARE), fallback: null },
    ]);
    const stats = await syncParkAreas([
      { area: area("青年公園", SQUARE), fallback: null },
    ]);

    expect(stats.deleted).toBe(1);
    await expect(syncParkAreas([])).rejects.toThrow(/empty/);
    expect(await ParkAreaModel.countDocuments()).toBe(1);
  });
});

describe("parseImportArgs", () => {
  it("accepts no arguments or local file overrides", () => {
    expect(parseImportArgs([])).toEqual({});
    expect(
      parseImportArgs(["--file", "/tmp/park.csv", "--osm-file", "/tmp/o.json"]),
    ).toEqual({ csvFile: "/tmp/park.csv", osmFile: "/tmp/o.json" });
  });

  it("rejects anything else", () => {
    expect(() => parseImportArgs(["--file"])).toThrow(/usage/);
    expect(() => parseImportArgs(["--url", "x"])).toThrow(/usage/);
  });
});
