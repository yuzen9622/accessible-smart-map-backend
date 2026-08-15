import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import A11y from "../../model/a11y.model";
import BathroomModel from "../../model/bathroom.model";
import DisabledParkingModel from "../../model/disabled-parking.model";
import OsmA11y from "../../model/osm-a11y.model";
import {
  clearMongoTestDatabase,
  startMongoTest,
  stopMongoTest,
  type MongoTestContext,
} from "../../../tests/helpers/mongo-test-harness";
import {
  countFacilitiesNearby,
  findNearbyFacilityRows,
} from "./place-search.repository";

describe("place-search repository with real MongoDB", () => {
  let mongo: MongoTestContext | undefined;

  beforeAll(async () => {
    mongo = await startMongoTest();
  });

  afterEach(async () => {
    await clearMongoTestDatabase();
  });

  afterAll(async () => {
    await stopMongoTest(mongo);
  });

  it("counts and caps nearby facilities from each real collection", async () => {
    const near = {
      type: "Point" as const,
      coordinates: [121.565, 25.033] as [number, number],
    };
    const far = {
      type: "Point" as const,
      coordinates: [121.61, 25.09] as [number, number],
    };

    await A11y.create({
      項次: "metro-near",
      "出入口電梯/無障礙坡道名稱": "電梯",
      經度: near.coordinates[0],
      緯度: near.coordinates[1],
      location: near,
    });
    await BathroomModel.create({
      county: "臺北市",
      areacode: "100",
      village: "中正",
      number: "bath-near",
      name: "可及廁所",
      address: "臺北市中正區",
      administration: "公有",
      latitude: near.coordinates[1],
      longitude: near.coordinates[0],
      location: near,
      grade: "A",
      type2: "一般",
      type: "無障礙廁所",
      exec: "正常",
      diaper: "否",
    });
    await OsmA11y.create([
      {
        osmId: "osm-toilet-near",
        category: "toilet",
        tags: {},
        location: near,
      },
      {
        osmId: "osm-toilet-far",
        category: "toilet",
        tags: {},
        location: far,
      },
    ]);
    await DisabledParkingModel.create({
      city: "臺北市",
      district: "中正區",
      quantity: 1,
      placeName: "身障車位",
      latitude: near.coordinates[1],
      longitude: near.coordinates[0],
      location: near,
    });

    await expect(
      countFacilitiesNearby(25.033, 121.565, 1_000),
    ).resolves.toEqual({
      metro: 1,
      osm: 1,
      bathroom: 1,
      parking: 1,
    });

    const rows = await findNearbyFacilityRows(25.033, 121.565, 1_000, 1);
    expect(rows.bathrooms).toHaveLength(1);
    expect(rows.osmToilets).toHaveLength(1);
    expect(rows.metro).toHaveLength(1);
  });
});
