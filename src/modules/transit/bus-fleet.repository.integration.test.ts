import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import BusFleetSightingModel from "../../model/bus-fleet-sighting.model";
import BusRouteModel from "../../model/bus-route.model";
import BusVehicleModel from "../../model/bus-vehicle.model";
import {
  findRouteLowFloorEvidence,
  recordFleetSightings,
  recordRealtimeSightings,
  resetRouteIndexCache,
} from "./bus-fleet.repository";
import {
  clearMongoTestDatabase,
  startMongoTest,
  stopMongoTest,
  type MongoTestContext,
} from "../../../tests/helpers/mongo-test-harness";

const DAY_MS = 24 * 60 * 60 * 1000;

describe("bus fleet sightings with real MongoDB", () => {
  let mongo: MongoTestContext | undefined;

  beforeAll(async () => {
    mongo = await startMongoTest();
  });

  afterEach(async () => {
    await clearMongoTestDatabase();
    resetRouteIndexCache();
  });

  afterAll(async () => {
    await stopMongoTest(mongo);
  });

  async function seedRoute() {
    const base = {
      city: "Taichung",
      routeId: "61",
      routeName: { Zh_tw: "61" },
      stops: [],
      operators: [],
      importedAt: new Date(),
    };
    await BusRouteModel.create([
      { ...base, routeUid: "TXG61", subRouteUid: "TXG61", direction: 0 },
      { ...base, routeUid: "TXG61", subRouteUid: "TXG61", direction: 1 },
      { ...base, routeUid: "TXG62", subRouteUid: "TXG62A1", direction: 0 },
    ]);
  }

  it("counts each plate once per route and keeps unknown car types out of the share", async () => {
    await seedRoute();
    await BusVehicleModel.create([
      {
        plateNumb: "AAA-1",
        city: "Taichung",
        isLowFloor: 1,
        importedAt: new Date(),
      },
      {
        plateNumb: "AAA-2",
        city: "Taichung",
        isLowFloor: 0,
        importedAt: new Date(),
      },
    ]);
    const now = new Date();
    // Same plate seen three times the same day, plus one plate with no vehicle record.
    await recordFleetSightings(
      [
        { plateNumb: "aaa-1", routeUid: "TXG61" },
        { plateNumb: "AAA-1", routeUid: "TXG61" },
        { plateNumb: "AAA-2", routeUid: "TXG61" },
        { plateNumb: "ZZZ-9", routeUid: "TXG61" },
      ],
      "taichung-ebus",
      now,
    );
    await recordRealtimeSightings("TXG61", ["AAA-1", undefined, "-1"]);

    expect(await BusFleetSightingModel.countDocuments()).toBe(3);
    const evidence = await findRouteLowFloorEvidence(["TXG61", "UNKNOWN"], now);
    expect(evidence.has("UNKNOWN")).toBe(false);
    expect(evidence.get("TXG61")).toMatchObject({
      distinctPlates: 3,
      knownTypePlates: 2,
      lowFloorPlates: 1,
    });
    expect(evidence.get("TXG61")?.sources).toEqual([
      "taichung-ebus",
      "tdx-realtime",
    ]);
  });

  it("resolves a branch sub-route to its route and ignores sightings outside the window", async () => {
    await seedRoute();
    await BusVehicleModel.create([
      {
        plateNumb: "OLD-1",
        city: "Taichung",
        isLowFloor: 0,
        importedAt: new Date(),
      },
      {
        plateNumb: "NEW-1",
        city: "Taichung",
        isLowFloor: 1,
        importedAt: new Date(),
      },
    ]);
    const now = new Date();
    await recordFleetSightings(
      [{ plateNumb: "OLD-1", routeUid: "TXG62" }],
      "taichung-ebus",
      new Date(now.getTime() - 60 * DAY_MS),
    );
    await recordRealtimeSightings("TXG62A1", ["NEW-1"]);

    const evidence = await findRouteLowFloorEvidence(["TXG62A1"], now);
    expect(evidence.get("TXG62A1")).toMatchObject({
      distinctPlates: 1,
      knownTypePlates: 1,
      lowFloorPlates: 1,
    });
  });

  it("skips realtime sightings for sub-routes it cannot resolve", async () => {
    await seedRoute();
    expect(await recordRealtimeSightings("NOPE01", ["AAA-1"])).toBe(0);
    expect(await BusFleetSightingModel.countDocuments()).toBe(0);
  });
});

describe("GTFS stop aliases with real MongoDB", () => {
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

  it("returns only the requested route's original stop", async () => {
    const { default: GtfsStopAliasModel } =
      await import("../../model/gtfs-stop-alias.model");
    const { findStopAliases } = await import("./stop-alias.repository");
    await GtfsStopAliasModel.create([
      {
        routeId: "R2_0",
        stopId: "TPE1",
        originalStopId: "TPE2",
        builtAt: new Date(),
      },
      {
        routeId: "R3_0",
        stopId: "TPE1",
        originalStopId: "TPE3",
        builtAt: new Date(),
      },
    ]);

    const aliases = await findStopAliases([
      { routeId: "R2_0", stopId: "TPE1" },
      { routeId: "R1_0", stopId: "TPE1" },
    ]);

    expect([...aliases]).toEqual([["R2_0|TPE1", "TPE2"]]);
  });
});
