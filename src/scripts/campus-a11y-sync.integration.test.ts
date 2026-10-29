import express from "express";
import missingFixture from "./__fixtures__/moe-must-missing-coordinates.json";
import request from "supertest";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import CampusA11yModel from "../model/campus-a11y.model";
import fixture from "../adapters/__fixtures__/moe-mapinfo-nutc-sanmin.json";
import { parseCampusMapLocations } from "../adapters/campus-map.adapter";
import {
  enrichCampusFacilities,
  syncCampusDocuments,
} from "./campus-a11y-sync";
import type { ICampusA11y } from "../types";
import type { CampusFacilityLocation } from "../utils/campus-geo";
import {
  startMongoTest,
  clearMongoTestDatabase,
  stopMongoTest,
  type MongoTestContext,
} from "../../tests/helpers/mongo-test-harness";
vi.mock("../adapters/taipei-metro-notice.adapter", () => ({
  fetchTaipeiMetroNotices: vi.fn().mockResolvedValue([]),
}));
vi.mock("../modules/a11y/a11y.service", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../modules/a11y/a11y.service")>()),
  findOwnFacilityGroups: vi
    .fn()
    .mockResolvedValue({ metro: [], osm: [], bathroom: [], parking: [] }),
  findOwnNearby: vi
    .fn()
    .mockResolvedValue({ metro: [], osm: [], bathroom: [], parking: [] }),
}));
import { createA11yRouter } from "../modules/a11y/a11y.router";
const branchId = -2147483619;
const elevatorUid = "e391e1ad-ca08-4bd8-aa81-009160aece24";
const locations = () => parseCampusMapLocations(fixture, branchId);
function campus(): Omit<ICampusA11y, "_id"> {
  return {
    schoolId: -2147483615,
    schoolName: "國立臺中科技大學",
    branchId,
    branchName: "三民校區",
    city: "臺中市",
    buildingCount: 12,
    facilityCount: fixture.MAP_FACINFO.length,
    location: { type: "Point", coordinates: [120.682907, 24.150434] },
    importedAt: new Date("2026-10-29T09:21:45Z"),
    facilities: fixture.MAP_FACINFO.map((row) => ({
      facUid: row.UID,
      facTypeId: row.FAC_TYPE_ID,
      name: row.NAME,
      building: row.BUILDING_NAME,
      floors: row.FLOOR.split(/,\s*/),
      floorIds: [],
    })),
  };
}
describe("campus import against isolated MongoDB", () => {
  let mongo: MongoTestContext | undefined;
  beforeAll(async () => {
    mongo = await startMongoTest();
  }, 60_000);
  beforeEach(async () => {
    await CampusA11yModel.createIndexes();
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await clearMongoTestDatabase();
  });
  afterAll(async () => {
    await stopMongoTest(mongo);
  });

  it("backfills real Mongoose empty arrays and exposes facilities through both public APIs", async () => {
    await syncCampusDocuments([campus()]);
    const before = await CampusA11yModel.findOne({ branchId }).lean();
    for (const f of before?.facilities ?? [])
      expect(f.location?.coordinates).toHaveLength(0);
    const loadMap = vi.fn().mockResolvedValue(locations());
    const loadDetail = vi.fn();
    expect(await enrichCampusFacilities({ loadMap, loadDetail })).toEqual({
      located: fixture.MAP_FACINFO.length,
      skipped: 0,
      missingCoordinates: 0,
      failed: 0,
    });
    expect(loadMap).toHaveBeenCalledExactlyOnceWith(branchId);
    expect(loadDetail).not.toHaveBeenCalled();
    const saved = await CampusA11yModel.findOne({ branchId }).lean();
    expect(
      saved?.facilities.find((f) => f.facUid === elevatorUid)?.location,
    ).toEqual(locations().get(elevatorUid));
    const app = express().use("/api/v1/a11y", createA11yRouter());
    const all = await request(app).get(
      "/api/v1/a11y/all-facilities?category=elevator,ramp,toilet",
    );
    expect(all.status).toBe(200);
    expect(all.body.data).toHaveLength(3);
    expect(all.body.data).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          _id: elevatorUid,
          source: "campus",
          category: "elevator",
          location: { type: "Point", coordinates: [120.6831345, 24.1505911] },
        }),
      ]),
    );
    const nearby = await request(app)
      .get("/api/v1/a11y/nearby-a11y")
      .query({ lat: 24.1505911, lng: 120.6831345 });
    expect(nearby.status).toBe(200);
    expect(nearby.body.data.nearbyMetroA11y).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ source: "campus", facUid: elevatorUid }),
      ]),
    );
    expect(await enrichCampusFacilities({ loadMap, loadDetail })).toMatchObject(
      { located: 0, skipped: fixture.MAP_FACINFO.length },
    );
    expect(loadMap).toHaveBeenCalledTimes(1);
  });

  it("visits every stored campus and includes facility types outside the three map filters", async () => {
    const first = campus();
    first.facilities = first.facilities.slice(0, 1);
    first.facilityCount = 1;
    const second = {
      ...campus(),
      schoolId: 20,
      schoolName: "Second test school",
      branchId: 123,
      facilities: [
        { facUid: "second-guidance", facTypeId: 13, floors: [], floorIds: [] },
      ],
      facilityCount: 1,
    };
    await syncCampusDocuments([first, second]);
    const loadMap = vi.fn(async (id: number) =>
      id === branchId
        ? locations()
        : new Map<string, CampusFacilityLocation>([
            ["second-guidance", { type: "Point", coordinates: [121, 25] }],
          ]),
    );
    const loadDetail = vi.fn();
    expect(await enrichCampusFacilities({ loadMap, loadDetail })).toMatchObject(
      { located: 2, failed: 0 },
    );
    expect(loadMap.mock.calls.map(([id]) => id).sort()).toEqual(
      [branchId, 123].sort(),
    );
    const stored = await CampusA11yModel.findOne({ branchId: 123 }).lean();
    expect(stored?.facilities[0]).toMatchObject({
      facTypeId: 13,
      location: { type: "Point", coordinates: [121, 25] },
    });
    expect(loadDetail).not.toHaveBeenCalled();
  });

  it("keeps the three observed Minghsin facilities whose own coordinates are empty", async () => {
    const document = {
      ...campus(),
      schoolId: -2147483502,
      schoolName: "明新科技大學",
      branchId: -2147483510,
      branchName: "主校區",
      location: undefined,
      facilityCount: missingFixture.results.length,
      facilities: missingFixture.results.map((row) => ({
        facUid: row.facUid,
        facTypeId: 6,
        name: "廁所盥洗室",
        buildingUid: row.payload.BUILDING_UID,
        floors: [],
        floorIds: [row.payload.FLOOR_ID],
      })),
    };
    await syncCampusDocuments([document]);
    const loadDetail = vi.fn(async (payload: Record<string, string>) => {
      const row = missingFixture.results.find(
        (f) => f.facUid === payload.FACILITY_UID,
      );
      if (!row) throw new Error("Unknown fixture facility");
      return row.detailMinimalSnippet;
    });
    const stats = await enrichCampusFacilities({
      loadMap: async () => new Map(),
      loadDetail,
    });
    expect(stats).toEqual({
      located: 0,
      skipped: 0,
      missingCoordinates: 3,
      failed: 0,
    });
    expect(loadDetail).toHaveBeenCalledTimes(3);
    const saved = await CampusA11yModel.findOne({
      branchId: -2147483510,
    }).lean();
    expect(saved?.facilities).toHaveLength(3);
    for (const facility of saved?.facilities ?? []) {
      expect(facility.location?.coordinates).toHaveLength(0);
      expect(facility.detailFetchedAt).toBeUndefined();
    }
  });

  it("only refreshes valid points with force and preserves details on base reruns", async () => {
    const original = campus();
    original.facilities = original.facilities.map((f) => ({
      ...f,
      location: { type: "Point", coordinates: [121, 25] },
      specs: [{ label: "機門寬度", value: "90公分" }],
      detailFetchedAt: new Date("2026-10-28T00:00:00Z"),
    }));
    await syncCampusDocuments([original]);
    const before = await CampusA11yModel.findOne({ branchId }).lean();
    const loadMap = vi.fn().mockResolvedValue(locations());
    const loadDetail = vi.fn();
    await enrichCampusFacilities({ loadMap, loadDetail });
    expect(loadMap).not.toHaveBeenCalled();
    await enrichCampusFacilities({ loadMap, loadDetail, force: true });
    await syncCampusDocuments([campus()]);
    await syncCampusDocuments([campus()]);
    const after = await CampusA11yModel.findOne({ branchId }).lean();
    expect(String(after?._id)).toBe(String(before?._id));
    expect(await CampusA11yModel.countDocuments()).toBe(1);
    expect(after?.facilities).toHaveLength(fixture.MAP_FACINFO.length);
    for (const f of after?.facilities ?? []) {
      expect(f.location).toEqual(locations().get(f.facUid));
      expect(f.specs).toEqual(
        before?.facilities.find((old) => old.facUid === f.facUid)?.specs,
      );
      expect(f.detailFetchedAt).toEqual(original.facilities[0].detailFetchedAt);
    }
  });

  it("does not retain removed UIDs or copy locations between campuses", async () => {
    const original = campus();
    original.facilities[0].location = locations().get(
      original.facilities[0].facUid,
    );
    await syncCampusDocuments([original]);
    await syncCampusDocuments([
      { ...campus(), branchId: 123, branchName: "other" },
    ]);
    const refreshed = campus();
    refreshed.facilities = refreshed.facilities.slice(1);
    refreshed.facilityCount = refreshed.facilities.length;
    await syncCampusDocuments([refreshed]);
    const stored = await CampusA11yModel.findOne({ branchId }).lean();
    expect(
      stored?.facilities.some(
        (f) => f.facUid === original.facilities[0].facUid,
      ),
    ).toBe(false);
    const other = await CampusA11yModel.findOne({ branchId: 123 }).lean();
    expect(other?.facilities[0].location?.coordinates).toEqual([]);
  });

  it("keeps unvisited campuses and rejects empty/incomplete input before writing", async () => {
    await syncCampusDocuments([campus(), { ...campus(), branchId: 123 }]);
    const before = await CampusA11yModel.find({}).lean();
    await expect(syncCampusDocuments([])).rejects.toThrow("No complete");
    await expect(
      syncCampusDocuments([{ ...campus(), facilities: [] }]),
    ).rejects.toThrow("Incomplete");
    await expect(
      syncCampusDocuments([{ ...campus(), facilityCount: 999 }]),
    ).rejects.toThrow("Incomplete");
    expect(await CampusA11yModel.find({}).lean()).toEqual(before);
    await syncCampusDocuments([campus()]);
    expect(await CampusA11yModel.countDocuments()).toBe(2);
  });

  it("preserves valid data when force has no source point and never marks it fetched", async () => {
    const original = campus();
    original.facilities = original.facilities.slice(0, 1).map((f) => ({
      ...f,
      buildingUid: "fallback-building",
      floorIds: ["floor"],
      location: locations().get(f.facUid),
      specs: [{ label: "existing", value: "retained" }],
    }));
    original.facilityCount = 1;
    await syncCampusDocuments([original]);
    const before = await CampusA11yModel.findOne({ branchId }).lean();
    const loadDetail = vi
      .fn()
      .mockResolvedValue(
        '<div data-building-geo="POINT (1 2)">no facility point</div>',
      );
    expect(
      await enrichCampusFacilities({
        force: true,
        loadMap: async () => new Map(),
        loadDetail,
      }),
    ).toEqual({ located: 0, skipped: 0, missingCoordinates: 1, failed: 0 });
    expect(await CampusA11yModel.findOne({ branchId }).lean()).toEqual(before);
    expect(loadDetail).toHaveBeenCalledTimes(1);
  });

  it("uses detail fallback for missing map points and leaves request failures retryable", async () => {
    const original = campus();
    original.facilities = original.facilities.slice(0, 1).map((f) => ({
      ...f,
      buildingUid: "fallback-building",
      floorIds: ["floor"],
    }));
    original.facilityCount = 1;
    await syncCampusDocuments([original]);
    const loadDetail = vi
      .fn()
      .mockResolvedValue(
        '<div data-facility-geo="POINT (13434385.08 2771769.053)"><li>●機門寬度:90公分</li></div>',
      );
    expect(
      await enrichCampusFacilities({
        loadMap: async () => new Map(),
        loadDetail,
      }),
    ).toMatchObject({ located: 1, missingCoordinates: 0 });
    const saved = await CampusA11yModel.findOne({ branchId }).lean();
    expect(saved?.facilities[0].location).toEqual(locations().get(elevatorUid));
    expect(saved?.facilities[0].detailFetchedAt).toBeInstanceOf(Date);
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(
      await enrichCampusFacilities({
        force: true,
        loadMap: async () => {
          throw new Error("upstream down");
        },
        loadDetail,
      }),
    ).toMatchObject({ located: 0, failed: 1 });
    expect(await CampusA11yModel.findOne({ branchId }).lean()).toEqual(saved);
    expect(errorLog).toHaveBeenCalled();
  });
});
