import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import A11y from "../../model/a11y.model";
import BathroomModel from "../../model/bathroom.model";
import DisabledParkingModel from "../../model/disabled-parking.model";
import OsmA11y from "../../model/osm-a11y.model";
import ParkingLotModel from "../../model/parking-lot.model";
import ParkingSpaceModel from "../../model/parking-space.model";
import {
  clearMongoTestDatabase,
  startMongoTest,
  stopMongoTest,
  type MongoTestContext,
} from "../../../tests/helpers/mongo-test-harness";
import {
  findNearbyA11yRowsLimited,
  findParkingLotsNear,
} from "./a11y.repository";

describe("a11y repository with real MongoDB", () => {
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

  it("returns nearby facility collections and applies parking accessibility filters", async () => {
    const near = {
      type: "Point" as const,
      coordinates: [121.565, 25.033] as [number, number],
    };
    const far = {
      type: "Point" as const,
      coordinates: [121.61, 25.09] as [number, number],
    };

    await A11y.create({
      項次: "A-1",
      "出入口電梯/無障礙坡道名稱": "電梯",
      經度: near.coordinates[0],
      緯度: near.coordinates[1],
      location: near,
    });
    await BathroomModel.create({
      county: "臺北市",
      areacode: "100",
      village: "中正",
      number: "B-1",
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
    await OsmA11y.create({
      osmId: "osm-near",
      name: "斜坡道",
      category: "ramp",
      wheelchair: "yes",
      tags: { access: "yes" },
      location: near,
    });
    await DisabledParkingModel.create({
      city: "臺北市",
      district: "中正區",
      quantity: 1,
      placeName: "身障車位",
      latitude: near.coordinates[1],
      longitude: near.coordinates[0],
      location: near,
    });
    await ParkingSpaceModel.create({
      city: "臺北市",
      segmentId: "segment-near",
      spaceType: 1,
      isDisabled: true,
      externalId: "space-near",
      location: near,
    });
    await ParkingLotModel.create([
      {
        carParkId: "lot-accessible",
        name: "可及停車場",
        city: "臺北市",
        wheelchairAccessible: true,
        position: near,
      },
      {
        carParkId: "lot-ordinary",
        name: "一般停車場",
        city: "臺北市",
        wheelchairAccessible: false,
        disabledSpaces: 0,
        position: near,
      },
      {
        carParkId: "lot-far",
        name: "遠方停車場",
        city: "臺北市",
        wheelchairAccessible: true,
        position: far,
      },
    ]);

    const nearby = await findNearbyA11yRowsLimited(
      25.033,
      121.565,
      1_000,
      1_000,
    );
    expect(nearby.metro).toHaveLength(1);
    expect(nearby.bathroom).toHaveLength(1);
    expect(nearby.osm).toHaveLength(1);
    expect(nearby.parking).toHaveLength(1);

    const accessibleLots = await findParkingLotsNear(
      25.033,
      121.565,
      1_000,
      10,
      true,
    );
    expect(accessibleLots).toHaveLength(1);
    expect(accessibleLots[0]?.carParkId).toBe("lot-accessible");
  });
});
