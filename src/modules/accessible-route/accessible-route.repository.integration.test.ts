import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import BusStopModel from "../../model/bus-stop.model";
import {
  clearMongoTestDatabase,
  startMongoTest,
  stopMongoTest,
  type MongoTestContext,
} from "../../../tests/helpers/mongo-test-harness";
import { findNearestStopCity } from "./accessible-route.repository";

describe("accessible-route repository with real MongoDB", () => {
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

  it("returns the city of the nearest stop and null outside the radius", async () => {
    await BusStopModel.create([
      {
        stopUid: "stop-near",
        stopName: { Zh_tw: "近站" },
        city: "臺北市",
        subRouteIds: [],
        location: { type: "Point", coordinates: [121.565, 25.033] },
      },
      {
        stopUid: "stop-far",
        stopName: { Zh_tw: "遠站" },
        city: "新北市",
        subRouteIds: [],
        location: { type: "Point", coordinates: [121.61, 25.09] },
      },
    ]);

    await expect(findNearestStopCity(25.033, 121.565, 1_000)).resolves.toBe(
      "臺北市",
    );
    await expect(findNearestStopCity(25.033, 121.565, 10)).resolves.toBe(
      "臺北市",
    );
    await expect(findNearestStopCity(25.09, 121.61, 10)).resolves.toBe(
      "新北市",
    );
    await expect(findNearestStopCity(25, 121.5, 100)).resolves.toBeNull();
  });
});
