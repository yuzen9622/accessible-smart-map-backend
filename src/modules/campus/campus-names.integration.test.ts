import express from "express";
import type { CampusFacilityLocation } from "../../utils/campus-geo";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import CampusA11yModel from "../../model/campus-a11y.model";
import { createCampusRouter } from "./campus.router";
import { toPublicId } from "./campus.util";
import { createA11yRouter } from "../a11y/a11y.router";
import {
  startMongoTest,
  stopMongoTest,
  type MongoTestContext,
} from "../../../tests/helpers/mongo-test-harness";

vi.mock("../../adapters/taipei-metro-notice.adapter", () => ({
  fetchTaipeiMetroNotices: vi.fn().mockResolvedValue([]),
}));
vi.mock("../a11y/a11y.service", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../a11y/a11y.service")>()),
  findOwnFacilityGroups: vi
    .fn()
    .mockResolvedValue({ metro: [], osm: [], bathroom: [], parking: [] }),
  findOwnNearby: vi
    .fn()
    .mockResolvedValue({ metro: [], osm: [], bathroom: [], parking: [] }),
  findOwnElevatorFacilities: vi.fn().mockResolvedValue([]),
  findOwnRampFacilities: vi.fn().mockResolvedValue([]),
  findOwnBathroomFacilities: vi.fn().mockResolvedValue([]),
}));

describe("legacy campus names through real Mongo and API routes", () => {
  let mongo: MongoTestContext | undefined;
  beforeAll(async () => {
    mongo = await startMongoTest();
  }, 60_000);
  afterAll(async () => {
    await stopMongoTest(mongo);
  });

  it("cleans stored UI labels without writes and exposes only known positions for every language", async () => {
    const point: CampusFacilityLocation = {
      type: "Point",
      coordinates: [120.6831345, 24.1505911],
    };
    await CampusA11yModel.create([
      {
        schoolId: -2147483615,
        schoolName: "國立臺中科技大學",
        branchId: -2147483619,
        branchName: "三民校區",
        location: point,
        facilities: [
          {
            facUid: "legacy-lift",
            facTypeId: 8,
            name: "無障礙電梯，無障礙電梯 (開啟詳細資訊)",
            floors: ["B1", "1F", "3F", "1F"],
            location: point,
          },
          {
            facUid: "specific-ramp",
            facTypeId: 2,
            name: "查看詳情：無障礙坡道，北側坡道（2號） (開啟視窗)",
            building: "建築物：昌明樓",
            floors: ["1F"],
            location: point,
          },
        ],
      },
      {
        schoolId: -2147483502,
        schoolName: "明新科技大學",
        branchId: -2147483510,
        branchName: "主校區",
        location: point,
        facilities: [
          {
            facUid: "other-campus-lift",
            facTypeId: 8,
            name: "無障礙電梯，無障礙電梯 (開啟詳細資訊)",
            building: "電子館",
            floors: ["1F 辦公室"],
            location: point,
          },
          {
            facUid: "toilet",
            facTypeId: 6,
            name: "無障礙廁所，廁所盥洗室（女廁） (開啟詳細資訊)",
            floors: [],
            location: point,
          },
        ],
      },
    ]);
    const before = await CampusA11yModel.find({}).lean();
    const app = express().use(
      "/api/v1/a11y",
      createA11yRouter(),
      createCampusRouter(),
    );
    const expected = [
      {
        _id: "legacy-lift",
        name: "無障礙電梯",
        label: "國立臺中科技大學／三民校區 · B1, 1F, 3F · 無障礙電梯",
      },
      {
        _id: "specific-ramp",
        name: "北側坡道（2號）",
        label: "國立臺中科技大學／三民校區 · 昌明樓 · 1F · 北側坡道（2號）",
      },
      {
        _id: "other-campus-lift",
        name: "無障礙電梯",
        label: "明新科技大學／主校區 · 電子館 · 1F 辦公室 · 無障礙電梯",
      },
      {
        _id: "toilet",
        name: "廁所盥洗室（女廁）",
        label: "明新科技大學／主校區 · 廁所盥洗室（女廁）",
      },
    ];
    for (const lang of [undefined, "zh-TW", "en"]) {
      const query = lang ? { lang } : {};
      const all = await request(app)
        .get("/api/v1/a11y/all-facilities")
        .query(query);
      expect(all.status).toBe(200);
      expect(all.body.data).toHaveLength(4);
      for (const row of expected) {
        const found = all.body.data.find(
          (f: { _id: string }) => f._id === row._id,
        );
        expect(found).toMatchObject({
          _id: row._id,
          name: row.name,
          source: "campus",
        });
        if (lang)
          expect(found).toMatchObject({
            displayName: row.label,
            displaySchoolName:
              row._id === "legacy-lift" || row._id === "specific-ramp"
                ? "國立臺中科技大學"
                : "明新科技大學",
          });
        else expect(found).not.toHaveProperty("displayName");
      }
      const nearby = await request(app)
        .get("/api/v1/a11y/nearby-a11y")
        .query({ lat: "24.1505911", lng: "120.6831345", ...query });
      expect(nearby.status).toBe(200);
      for (const row of expected) {
        const found = nearby.body.data.nearbyMetroA11y.find(
          (f: { facUid: string }) => f.facUid === row._id,
        );
        expect(found).toMatchObject({ "出入口電梯/無障礙坡道名稱": row.name });
        if (lang) expect(found.displayName).toBe(row.label);
        else expect(found).not.toHaveProperty("displayName");
      }
      for (const [path, id] of [
        ["all-elevators", "legacy-lift"],
        ["all-ramps", "specific-ramp"],
        ["all-bathrooms", "toilet"],
      ]) {
        const response = await request(app)
          .get("/api/v1/a11y/" + path)
          .query(query);
        expect(response.status).toBe(200);
        const found = response.body.data.find(
          (f: { _id: string }) => f._id === id,
        );
        const row = expected.find((f) => f._id === id);
        expect(found.name).toBe(row?.name);
        if (lang) expect(found.displayName).toBe(row?.label);
      }
      const detail = await request(app)
        .get("/api/v1/a11y/campus/" + toPublicId(-2147483619))
        .query(query);
      expect(detail.status).toBe(200);
      expect(detail.body.data.facilities[0]).toMatchObject({
        name: "無障礙電梯",
        floors: ["B1", "1F", "3F"],
      });
      expect(detail.body.data.facilities[0]).not.toHaveProperty("building");
      expect(detail.body.data.facilities[1]).toMatchObject({
        name: "北側坡道（2號）",
        building: "昌明樓",
      });
      if (lang)
        expect(detail.body.data.facilities[0].displayName).toBe("無障礙電梯");
      else
        expect(detail.body.data.facilities[0]).not.toHaveProperty(
          "displayName",
        );
    }
    expect(await CampusA11yModel.find({}).lean()).toEqual(before);
  });
});
