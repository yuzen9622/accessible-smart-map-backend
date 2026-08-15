import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import CampusA11yModel from "../../model/campus-a11y.model";
import {
  aggregateSchoolPage,
  findCampusPage,
  findCampusesNearby,
} from "./campus.repository";
import {
  clearMongoTestDatabase,
  startMongoTest,
  stopMongoTest,
  type MongoTestContext,
} from "../../../tests/helpers/mongo-test-harness";

describe("campus repository with real MongoDB", () => {
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

  it("supports geospatial lookup plus sorted, paginated and aggregated directories", async () => {
    await CampusA11yModel.create([
      {
        schoolId: 10,
        schoolName: "Alpha University",
        branchId: 101,
        branchName: "Main Campus",
        city: "臺北市",
        address: "臺北市中正區",
        buildingCount: 2,
        facilityCount: 3,
        facilities: [
          { facUid: "alpha-main-elevator", facTypeId: 1, facType: "電梯" },
        ],
        location: { type: "Point", coordinates: [121.565, 25.033] },
        searchName: "alpha university main campus",
      },
      {
        schoolId: 10,
        schoolName: "Alpha University",
        branchId: 102,
        branchName: "North Campus",
        city: "臺北市",
        buildingCount: 1,
        facilityCount: 1,
        facilities: [
          { facUid: "alpha-north-ramp", facTypeId: 2, facType: "坡道" },
        ],
        location: { type: "Point", coordinates: [121.566, 25.034] },
        searchName: "alpha university north campus",
      },
      {
        schoolId: 20,
        schoolName: "Beta College",
        branchId: 201,
        branchName: "Downtown",
        city: "臺北市",
        buildingCount: 1,
        facilityCount: 2,
        facilities: [
          { facUid: "beta-downtown-toilet", facTypeId: 3, facType: "廁所" },
        ],
        location: { type: "Point", coordinates: [121.567, 25.035] },
        searchName: "beta college downtown",
      },
    ]);

    const nearby = await findCampusesNearby(25.033, 121.565, 1_000);
    expect(nearby).toHaveLength(3);
    expect(nearby[0]).toMatchObject({ schoolName: "Alpha University" });

    const page = await findCampusPage({}, "facilities", 1, 2);
    expect(page.totalCount).toBe(3);
    expect(page.docs).toHaveLength(2);
    expect(page.docs.map((doc) => doc.facilityCount)).toEqual([3, 2]);

    const schools = await aggregateSchoolPage({}, 1, 1);
    expect(schools.totalCount).toBe(2);
    expect(schools.items).toEqual([
      expect.objectContaining({
        _id: 10,
        schoolName: "Alpha University",
        branchCount: 2,
        facilityCount: 4,
      }),
    ]);
  });
});
