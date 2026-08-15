import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import BusRouteModel from "../../model/bus-route.model";
import {
  clearMongoTestDatabase,
  startMongoTest,
  stopMongoTest,
  type MongoTestContext,
} from "../../../tests/helpers/mongo-test-harness";
import { findBusRoutesByName } from "./alert.repository";

describe("transit alert repository with real MongoDB", () => {
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

  it("matches route names within the requested city", async () => {
    await BusRouteModel.create([
      {
        subRouteUid: "alert-sub-10",
        routeUid: "alert-route-10",
        city: "Taipei",
        routeName: { Zh_tw: "10" },
        subRouteName: { Zh_tw: "10 正線" },
        direction: 0,
        operators: [],
        stops: [],
      },
      {
        subRouteUid: "alert-sub-10-new-taipei",
        routeUid: "alert-route-10-new-taipei",
        city: "New Taipei",
        routeName: { Zh_tw: "10" },
        direction: 0,
        operators: [],
        stops: [],
      },
    ]);

    await expect(findBusRoutesByName("Taipei", ["10"])).resolves.toEqual([
      expect.objectContaining({
        direction: 0,
        subRouteName: { Zh_tw: "10 正線" },
      }),
    ]);
    await expect(findBusRoutesByName("Taipei", ["999"])).resolves.toEqual([]);
  });
});
