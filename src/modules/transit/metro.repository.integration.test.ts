import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import MetroStationModel from "../../model/metro-station.model";
import {
  clearMongoTestDatabase,
  startMongoTest,
  stopMongoTest,
  type MongoTestContext,
} from "../../../tests/helpers/mongo-test-harness";
import { findMetroStationsByUids } from "./metro.repository";

describe("transit metro repository with real MongoDB", () => {
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

  it("resolves requested station UIDs and handles an empty request", async () => {
    await MetroStationModel.create([
      {
        stationUid: "BL12",
        stationName: { Zh_tw: "忠孝復興" },
        railSystem: "TRTC",
        lineIds: ["BL"],
        location: { type: "Point", coordinates: [121.543, 25.041] },
      },
      {
        stationUid: "R10",
        stationName: { Zh_tw: "大安" },
        railSystem: "TRTC",
        lineIds: ["R"],
        location: { type: "Point", coordinates: [121.543, 25.033] },
      },
    ]);

    await expect(findMetroStationsByUids(["BL12"])).resolves.toEqual([
      expect.objectContaining({
        stationUid: "BL12",
        stationName: { Zh_tw: "忠孝復興" },
      }),
    ]);
    await expect(findMetroStationsByUids([])).resolves.toEqual([]);
  });
});
