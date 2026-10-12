import { beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";

vi.mock("./a11y.repository", () => ({
  findAllMetroExits: vi.fn(),
  findOsmFeatures: vi.fn(),
  findAccessibleBathrooms: vi.fn(),
  findAllDisabledParking: vi.fn(),
  findMetroElevators: vi.fn(),
  findMetroRamps: vi.fn(),
  findOsmByCategory: vi.fn(),
  findNearbyA11yRows: vi.fn(),
  findNearbyA11yRowsLimited: vi.fn(),
  findOsmByIds: vi.fn(),
  findDisabledParkingNear: vi.fn(),
  findParkingLotsNear: vi.fn(),
  findParkingSpacesNear: vi.fn(),
}));
vi.mock("../campus/campus.repository", () => ({
  aggregateSchoolPage: vi.fn(),
  findCampusByBranchId: vi.fn(),
  findCampusPage: vi.fn(),
  findCampusesNearby: vi.fn(),
  findCampusesNearbyWithFacilities: vi.fn(),
  findCampusesWithLocatedFacilities: vi.fn(),
}));
vi.mock("../welfare/welfare.repository", () => ({
  findNearbyWelfare: vi.fn(),
  findWelfareBy: vi.fn(),
  findWelfareById: vi.fn(),
}));
vi.mock("../visual-a11y/visual-a11y.repository", () => ({
  findNearbyVisualA11y: vi.fn(),
}));
vi.mock("../../adapters/taipei-metro-notice.adapter", () => ({
  fetchTaipeiMetroNotices: vi.fn(async () => []),
}));
vi.mock("../hazard-report/hazard-report.service", () => ({
  countActiveHazardsNear: vi.fn(async () => 0),
}));

import * as repo from "./a11y.repository";
import * as campusRepo from "../campus/campus.repository";
import * as welfareRepo from "../welfare/welfare.repository";
import * as visualRepo from "../visual-a11y/visual-a11y.repository";
import * as own from "./a11y.service";
import * as a11y from "./a11y.orchestration";
import * as campus from "../campus/campus.service";
import * as welfare from "../welfare/welfare.service";
import * as visual from "../visual-a11y/visual-a11y.service";
import { createA11yRouter } from "./a11y.router";
import { createCampusRouter } from "../campus/campus.router";
import { createVisualA11yRouter } from "../visual-a11y/visual-a11y.router";
import { createWelfareRouter } from "../welfare/welfare.router";
import { AllFacilitiesResponseSchema } from "./a11y.schema";
import { CampusDetailResponseSchema } from "../campus/campus.schema";

const geo = Object.freeze({
  type: "Point",
  coordinates: Object.freeze([121.5, 25]),
});
const osm = Object.freeze({
  _id: "osm",
  osmId: "12",
  name: " 原名 ",
  category: "elevator",
  wheelchair: "yes",
  tags: Object.freeze({ "name:en": " Source lift " }),
  location: geo,
});
const metro = Object.freeze({
  _id: "metro",
  項次: "1",
  "出入口電梯/無障礙坡道名稱": "車站電梯",
  location: geo,
});
const bathroom = Object.freeze({
  _id: "wc",
  name: "廁所",
  address: " 原地址 ",
  location: geo,
});
const parking = Object.freeze({
  _id: "bay",
  placeName: "身障格",
  location: geo,
});
const facility = Object.freeze({
  facUid: "F1",
  facTypeId: 8,
  facType: "無障礙電梯",
  name: "大樓電梯",
  floors: Object.freeze(["1"]),
  floorIds: Object.freeze(["L1"]),
  location: geo,
});
const campusDoc = Object.freeze({
  _id: "campus",
  schoolId: 1,
  branchId: 1,
  schoolName: "學校",
  branchName: "校區",
  address: "地址",
  buildingCount: 1,
  facilityCount: 1,
  facilities: Object.freeze([facility]),
  importedAt: "2026-01-01",
  location: geo,
});
const institution = Object.freeze({
  _id: "507f1f77bcf86cd799439011",
  name: "機構",
  address: "地址",
  geocoded: true,
  location: geo,
});
const visualDoc = Object.freeze({
  _id: "visual",
  source: "osm",
  sourceId: "1",
  type: "tactile_paving",
  location: geo,
  properties: Object.freeze({
    name: "導盲磚",
    nameEn: " Source paving ",
    wheelchair: "yes",
  }),
});
const app = express();
app.use(
  "/a11y",
  createA11yRouter(),
  createCampusRouter(),
  createWelfareRouter(),
  createVisualA11yRouter(),
);

beforeEach(() => {
  vi.clearAllMocks();
  for (const fn of Object.values(repo))
    if (vi.isMockFunction(fn)) fn.mockResolvedValue([]);
  vi.mocked(repo.findAllMetroExits).mockResolvedValue([metro] as any);
  vi.mocked(repo.findOsmFeatures).mockResolvedValue([osm] as any);
  vi.mocked(repo.findAccessibleBathrooms).mockResolvedValue([bathroom] as any);
  vi.mocked(repo.findAllDisabledParking).mockResolvedValue([parking] as any);
  vi.mocked(repo.findMetroElevators).mockResolvedValue([metro] as any);
  vi.mocked(repo.findMetroRamps).mockResolvedValue([]);
  vi.mocked(repo.findOsmByCategory).mockResolvedValue([osm] as any);
  vi.mocked(repo.findOsmByIds).mockResolvedValue([osm] as any);
  const rows = {
    metro: [metro],
    osm: [osm],
    bathroom: [bathroom],
    parking: [parking],
  };
  vi.mocked(repo.findNearbyA11yRows).mockResolvedValue(rows as any);
  vi.mocked(repo.findNearbyA11yRowsLimited).mockResolvedValue(rows as any);
  vi.mocked(repo.findDisabledParkingNear).mockResolvedValue([parking] as any);
  for (const fn of [
    campusRepo.findCampusesNearby,
    campusRepo.findCampusesNearbyWithFacilities,
    campusRepo.findCampusesWithLocatedFacilities,
  ])
    vi.mocked(fn).mockResolvedValue([campusDoc] as any);
  vi.mocked(campusRepo.findCampusByBranchId).mockResolvedValue(
    campusDoc as any,
  );
  vi.mocked(campusRepo.findCampusPage).mockResolvedValue({
    docs: [campusDoc],
    totalCount: 1,
  } as any);
  vi.mocked(campusRepo.aggregateSchoolPage).mockResolvedValue({
    items: [{ _id: 1, schoolName: "學校", branchCount: 1, facilityCount: 1 }],
    totalCount: 1,
  } as any);
  vi.mocked(welfareRepo.findWelfareBy).mockResolvedValue([institution] as any);
  vi.mocked(welfareRepo.findNearbyWelfare).mockResolvedValue([
    institution,
  ] as any);
  vi.mocked(welfareRepo.findWelfareById).mockResolvedValue(institution as any);
  vi.mocked(visualRepo.findNearbyVisualA11y).mockResolvedValue([
    visualDoc,
  ] as any);
});

function withoutDisplays(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutDisplays);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .filter(([key]) => !key.startsWith("display"))
        .map(([key, item]) => [key, withoutDisplays(item)]),
    );
  return value;
}

describe("source-backed facility read contract", () => {
  it("concurrent en/zh keep canonical fields, ordering, geometry and frozen sources unchanged", async () => {
    const [legacy, en, zh] = await Promise.all([
      a11y.findAllFacilities(),
      a11y.findAllFacilities(undefined, "en"),
      a11y.findAllFacilities(undefined, "zh-TW"),
    ]);
    expect(withoutDisplays(en)).toEqual(legacy);
    expect(withoutDisplays(zh)).toEqual(legacy);
    expect(en.find((f) => f.source === "osm")?.displayName).toBe("Source lift");
    expect(zh.find((f) => f.source === "osm")?.displayName).toBe(" 原名 ");
    expect(en.find((f) => f.source === "metro")?.displayName).toBe("車站電梯");
    expect(en.every((f) => !("displayAddress" in f))).toBe(true);
    expect(osm.tags["name:en"]).toBe(" Source lift ");
    expect(
      AllFacilitiesResponseSchema.safeParse({
        ok: true,
        status: "success",
        code: 200,
        message: "OK",
        data: en,
      }).success,
    ).toBe(true);
  });

  it.each(["en", "zh-TW"] as const)(
    "all a11y read services accept %s without altering legacy data",
    async (lang) => {
      for (const fn of [
        a11y.findElevatorFacilities,
        a11y.findRampFacilities,
        a11y.findBathroomFacilities,
      ]) {
        expect(withoutDisplays(await fn(lang))).toEqual(await fn());
      }
      for (const fn of [a11y.findNearby, a11y.findNearbyLimited]) {
        const data = await fn(25, 121.5, 150, lang);
        expect(withoutDisplays(data)).toEqual(await fn(25, 121.5, 150));
        expect(data.nearbyBathroom[0]).toHaveProperty(
          "displayAddress",
          " 原地址 ",
        );
        expect(data.nearbyOsm[0]).not.toHaveProperty("displayAddress");
      }
      expect(withoutDisplays(await own.findByOsmIds(["12"], lang))).toEqual(
        await own.findByOsmIds(["12"]),
      );
      expect(
        withoutDisplays(
          await own.findNearbyParking(25, 121.5, 1000, "all", lang),
        ),
      ).toEqual(await own.findNearbyParking(25, 121.5));
    },
  );

  it("missing/blank English fallback and real Mongoose documents never expose internals", async () => {
    for (const english of [undefined, "  ", 42]) {
      vi.mocked(repo.findOsmByIds).mockResolvedValue([
        { ...osm, tags: { "name:en": english } },
      ] as any);
      expect((await own.findByOsmIds(["12"], "en"))[0].displayName).toBe(
        osm.name,
      );
    }
    const { default: OsmModel } = await import("../../model/osm-a11y.model");
    const document = new OsmModel({ ...osm, _id: "507f1f77bcf86cd799439011" });
    vi.mocked(repo.findOsmByIds).mockResolvedValue([document] as any);
    const result = (await own.findByOsmIds(["12"], "en"))[0];
    expect(result).not.toHaveProperty("$__");
    expect(result).not.toHaveProperty("_doc");
    expect(result.displayName).toBe("Source lift");
    const { default: BathroomModel } =
      await import("../../model/bathroom.model");
    const bathroomDocument = new BathroomModel({
      ...bathroom,
      _id: "507f1f77bcf86cd799439011",
    });
    vi.mocked(repo.findNearbyA11yRows).mockResolvedValue({
      metro: [],
      osm: [],
      bathroom: [bathroomDocument],
      parking: [],
    } as any);
    const legacy = JSON.parse(JSON.stringify(await a11y.findNearby(25, 121.5)));
    const localized = JSON.parse(
      JSON.stringify(await a11y.findNearby(25, 121.5, 150, "en")),
    );
    expect(localized.nearbyBathroom[0]).not.toHaveProperty("$__");
    expect(withoutDisplays(localized)).toEqual(legacy);
    expect(bathroomDocument).not.toHaveProperty("displayName");
  });

  it.each(["en", "zh-TW"] as const)(
    "campus read DTOs %s fallback without invented addresses",
    async (lang) => {
      expect(
        withoutDisplays(
          await campus.findNearby(25, 121.5, 1000, undefined, lang),
        ),
      ).toEqual(await campus.findNearby(25, 121.5, 1000));
      expect(
        withoutDisplays(
          await campus.findFacilitiesNearby(25, 121.5, 1000, lang),
        ),
      ).toEqual(await campus.findFacilitiesNearby(25, 121.5, 1000));
      expect(withoutDisplays(await campus.findAllFacilities(lang))).toEqual(
        await campus.findAllFacilities(),
      );
      const detail = await campus.findByCampusId(1, lang);
      expect(detail).toMatchObject({
        displaySchoolName: "學校",
        displayBranchName: "校區",
        displayAddress: "地址",
        facilities: [{ displayName: "大樓電梯" }],
      });
      expect(withoutDisplays(detail)).toEqual(await campus.findByCampusId(1));
      expect(
        CampusDetailResponseSchema.safeParse({
          ok: true,
          status: "success",
          code: 200,
          message: "OK",
          data: detail,
        }).success,
      ).toBe(true);
      const filter = { page: 1, limit: 20 };
      expect(withoutDisplays(await campus.findAll(filter, lang))).toEqual(
        await campus.findAll(filter),
      );
      expect((await campus.listSchools(filter, lang)).items[0]).toHaveProperty(
        "displaySchoolName",
        "學校",
      );
      vi.mocked(campusRepo.findCampusByBranchId).mockResolvedValue({
        ...campusDoc,
        address: undefined,
      } as any);
      expect(await campus.findByCampusId(1, lang)).not.toHaveProperty(
        "displayAddress",
      );
    },
  );

  it.each(["en", "zh-TW"] as const)(
    "welfare and visual %s are source-only immutable projections",
    async (lang) => {
      expect(
        withoutDisplays(await welfare.findNearby(25, 121.5, 1000, lang)),
      ).toEqual(await welfare.findNearby(25, 121.5));
      expect(withoutDisplays(await welfare.findAll({}, lang))).toEqual(
        await welfare.findAll(),
      );
      expect(await welfare.findById(institution._id, lang)).toMatchObject({
        displayName: "機構",
        displayAddress: "地址",
        geocoded: true,
      });
      const result = await visual.findNearby(25, 121.5, 500, undefined, lang);
      expect(withoutDisplays(result)).toEqual(
        await visual.findNearby(25, 121.5),
      );
      expect(result[0]).toHaveProperty(
        "displayName",
        lang === "en" ? "Source paving" : "導盲磚",
      );
      expect(result[0]).not.toHaveProperty("displayAddress");
      vi.mocked(visualRepo.findNearbyVisualA11y).mockResolvedValue([
        { ...visualDoc, properties: { roadName: "路口", nameEn: " " } },
        { ...visualDoc, properties: {} },
      ] as any);
      const fallback = await visual.findNearby(25, 121.5, 500, undefined, lang);
      expect(fallback[0]).toHaveProperty("displayName", "路口");
      expect(fallback[1]).not.toHaveProperty("displayName");
    },
  );

  it.each(["en-US", "EN", "zh-Hant-TW"])(
    "real read controller normalizes alias %s",
    async (lang) => {
      const response = await request(app)
        .get("/a11y/all-facilities")
        .query({ lang });
      expect(response.status).toBe(200);
      const expected = lang.toLowerCase().startsWith("en")
        ? "Source lift"
        : " 原名 ";
      expect(
        response.body.data.find((f: any) => f.source === "osm").displayName,
      ).toBe(expected);
      const legacy = await request(app).get("/a11y/all-facilities");
      expect(legacy.body.data.every((f: any) => !("displayName" in f))).toBe(
        true,
      );
    },
  );

  it.each([
    ["/a11y/all-facilities", "0.displayName"],
    ["/a11y/all-bathrooms", "0.displayName"],
    ["/a11y/all-ramps", "0.displayName"],
    ["/a11y/all-elevators", "0.displayName"],
    ["/a11y/place?osmId=12", "0.displayName"],
    ["/a11y/nearby-a11y?lat=25&lng=121.5", "nearbyMetroA11y.0.displayName"],
    ["/a11y/parking/nearby?lat=25&lng=121.5", "0.displayName"],
    ["/a11y/visual-a11y?lat=25&lng=121.5", "0.displayName"],
    ["/a11y/campus", "items.0.displaySchoolName"],
    ["/a11y/campus/schools", "items.0.displaySchoolName"],
    ["/a11y/campus/nearby?lat=25&lng=121.5", "0.displaySchoolName"],
    ["/a11y/campus/1", "displaySchoolName"],
    ["/a11y/welfare", "0.displayName"],
    ["/a11y/welfare/nearby?lat=25&lng=121.5", "0.displayName"],
    [`/a11y/welfare/${institution._id}`, "displayName"],
  ])(
    "real controllers keep omitted DTOs and accept both language aliases: %s",
    async (path, field) => {
      const legacy = await request(app).get(path);
      expect(legacy.status).toBe(200);
      expect(legacy.body.data).not.toHaveProperty(field);
      for (const lang of ["en-US", "zh-Hant-TW"]) {
        const localized = await request(app).get(path).query({ lang });
        expect(localized.status).toBe(200);
        expect(localized.body.data).toHaveProperty(field);
        expect(withoutDisplays(localized.body.data)).toEqual(legacy.body.data);
      }
    },
  );

  it.each([
    "/a11y/all-facilities",
    "/a11y/visual-a11y?lat=25&lng=121.5",
    "/a11y/all-bathrooms",
    "/a11y/all-ramps",
    "/a11y/all-elevators",
    "/a11y/place?osmId=12",
    "/a11y/nearby-a11y?lat=25&lng=121.5",
    "/a11y/parking/nearby?lat=25&lng=121.5",
    "/a11y/campus",
    "/a11y/campus/schools",
    "/a11y/campus/nearby?lat=25&lng=121.5",
    "/a11y/campus/1",
    "/a11y/welfare",
    "/a11y/welfare/nearby?lat=25&lng=121.5",
    `/a11y/welfare/${institution._id}`,
  ])("invalid lang is rejected before I/O: %s", async (path) => {
    expect((await request(app).get(path).query({ lang: "fr" })).status).toBe(
      400,
    );
    for (const module of [repo, campusRepo, welfareRepo, visualRepo]) {
      for (const fn of Object.values(module))
        if (vi.isMockFunction(fn)) expect(fn).not.toHaveBeenCalled();
    }
  });
});
