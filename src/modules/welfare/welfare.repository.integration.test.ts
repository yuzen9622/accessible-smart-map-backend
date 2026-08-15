import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import WelfareModel from "../../model/welfare.model";
import {
  findNearbyWelfare,
  findWelfareBy,
  findWelfareById,
} from "./welfare.repository";
import {
  clearMongoTestDatabase,
  startMongoTest,
  stopMongoTest,
  type MongoTestContext,
} from "../../../tests/helpers/mongo-test-harness";

describe("welfare repository with real MongoDB", () => {
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

  it("finds nearby institutions, applies directory filters and rejects malformed ids", async () => {
    const near = {
      type: "Point" as const,
      coordinates: [121.565, 25.033] as [number, number],
    };
    const far = {
      type: "Point" as const,
      coordinates: [121.61, 25.09] as [number, number],
    };
    const [nearbyInstitution, farInstitution] = await WelfareModel.create([
      {
        name: "臺北日間中心",
        county: "臺北市",
        address: "臺北市中正區",
        type: "日間型機構",
        location: near,
      },
      {
        name: "新北住宿中心",
        county: "新北市",
        address: "新北市板橋區",
        type: "住宿型機構",
        location: far,
      },
    ]);

    const nearby = await findNearbyWelfare(25.033, 121.565, 1_000);
    expect(nearby).toHaveLength(1);
    expect(nearby[0]?.name).toBe("臺北日間中心");
    await expect(
      findWelfareBy({ county: "臺北市", type: "日間型機構" }),
    ).resolves.toEqual([
      expect.objectContaining({ name: "臺北日間中心", county: "臺北市" }),
    ]);
    await expect(
      findWelfareById(String(nearbyInstitution._id)),
    ).resolves.toMatchObject({
      name: "臺北日間中心",
    });
    await expect(findWelfareById("not-an-object-id")).resolves.toBeNull();
    expect(String(farInstitution._id)).not.toBe(String(nearbyInstitution._id));
  });
});
