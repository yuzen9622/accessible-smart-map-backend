import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { metroStationOperations } from "../../scripts/tdx-metro-parse";
import type {
  TdxMetroStation,
  TdxMetroStationOfLine,
} from "../../types/transit";
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

  it("persists and reimports light-rail station operations without duplicate stations", async () => {
    for (const [railSystem, stationUid] of [
      ["NTDLRT", "NTDLRT-01"],
      ["NTALRT", "NTALRT-01"],
      ["NTMC", "NTMCC-01"],
      ["KLRT", "KLRT-NETWORK-01"],
      ["TRTCMG", "MG-01"],
    ]) {
      const stations = [
        {
          StationUID: stationUid,
          StationID: "01",
          StationName: { Zh_tw: "測試站", En: "Test" },
          StationPosition: { PositionLon: 121.5, PositionLat: 25.1 },
        },
      ] as TdxMetroStation[];
      const lines = [
        { LineID: "L1", Stations: [{ StationID: "01" }] },
        { LineID: "L2", Stations: [{ StationID: "01" }] },
      ] as TdxMetroStationOfLine[];
      await MetroStationModel.bulkWrite(
        metroStationOperations(stations, lines, railSystem),
      );
      stations[0].StationPosition.PositionLon = 121.6;
      await MetroStationModel.bulkWrite(
        metroStationOperations(stations, lines, railSystem),
      );
      const docs = await findMetroStationsByUids([stationUid]);
      expect(docs).toHaveLength(1);
      const stored = await MetroStationModel.findOne({
        stationUid: stationUid,
      }).lean();
      expect(stored).toMatchObject({
        railSystem,
        lineIds: [`${railSystem}-L1`, `${railSystem}-L2`],
        location: { coordinates: [121.6, 25.1] },
      });
    }
    expect(await MetroStationModel.countDocuments()).toBe(5);
  });
});
