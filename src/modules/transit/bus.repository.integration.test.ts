import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import BusRouteModel from "../../model/bus-route.model";
import BusStopModel from "../../model/bus-stop.model";
import BusVehicleModel from "../../model/bus-vehicle.model";
import {
  findRoutesByName,
  findRouteNamesBySubRoute,
  findStopsNearby,
  findVehiclesByPlate,
  searchRoutesByKeyword,
  searchStopsByKeyword,
} from "./bus.repository";
import {
  clearMongoTestDatabase,
  startMongoTest,
  stopMongoTest,
  type MongoTestContext,
} from "../../../tests/helpers/mongo-test-harness";

describe("transit bus repository with real MongoDB", () => {
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

  it("runs route aggregation, fuzzy stop search, vehicle lookup and geo-near", async () => {
    const routeStops = [
      {
        stopUID: "bus-stop-central",
        stopName: { Zh_tw: "中央站" },
        seq: 1,
        lat: 25.033,
        lng: 121.565,
      },
    ];
    await BusRouteModel.create([
      {
        subRouteUid: "bus-sub-blue-0",
        routeUid: "bus-route-blue",
        city: "Taipei",
        routeName: { Zh_tw: "Blue Line" },
        subRouteName: { Zh_tw: "Blue Line 1" },
        direction: 0,
        operators: [],
        stops: routeStops,
      },
      {
        subRouteUid: "bus-sub-blue-1",
        routeUid: "bus-route-blue",
        city: "Taipei",
        routeName: { Zh_tw: "Blue Line" },
        subRouteName: { Zh_tw: "Blue Line 2" },
        direction: 1,
        operators: [],
        stops: routeStops,
      },
      {
        subRouteUid: "bus-sub-blue-new-taipei",
        routeUid: "bus-route-blue-new-taipei",
        city: "New Taipei",
        routeName: { Zh_tw: "Blue Line" },
        subRouteName: { Zh_tw: "Blue Line 3" },
        direction: 0,
        operators: [],
        stops: routeStops,
      },
    ]);
    await BusStopModel.create([
      {
        stopUid: "bus-stop-central",
        stopName: { Zh_tw: "中央站" },
        city: "Taipei",
        subRouteIds: ["bus-sub-blue-0"],
        location: { type: "Point", coordinates: [121.565, 25.033] },
      },
      {
        stopUid: "bus-stop-far",
        stopName: { Zh_tw: "遠方站" },
        city: "Taipei",
        subRouteIds: [],
        location: { type: "Point", coordinates: [121.61, 25.09] },
      },
      {
        stopUid: "bus-stop-taichung-station",
        stopName: { Zh_tw: "臺中車站" },
        city: "Taichung",
        subRouteIds: [],
        location: { type: "Point", coordinates: [120.686, 24.137] },
      },
      {
        stopUid: "bus-stop-taipei-station",
        stopName: { Zh_tw: "臺北車站" },
        city: "Taipei",
        subRouteIds: [],
        location: { type: "Point", coordinates: [121.5171, 25.0478] },
      },
    ]);
    await BusVehicleModel.create({
      plateNumb: "BUS-001",
      city: "Taipei",
      isLowFloor: 1,
      hasLiftOrRamp: 1,
    });

    const groupedRoutes = await searchRoutesByKeyword("Blue", 10);
    expect(groupedRoutes).toHaveLength(2);
    expect(groupedRoutes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          _id: { routeName: "Blue Line", city: "Taipei" },
          subRoutes: expect.arrayContaining([
            expect.objectContaining({ direction: 0 }),
            expect.objectContaining({ direction: 1 }),
          ]),
        }),
        expect.objectContaining({
          _id: { routeName: "Blue Line", city: "New Taipei" },
        }),
      ]),
    );

    await expect(searchStopsByKeyword("中央", 10)).resolves.toEqual([
      expect.objectContaining({ stopUid: "bus-stop-central" }),
    ]);
    // 關鍵字使用「台中」能查到「臺中車站」
    await expect(searchStopsByKeyword("台中車站", 10)).resolves.toEqual([
      expect.objectContaining({ stopUid: "bus-stop-taichung-station" }),
    ]);
    // 關鍵字使用「臺中」亦能查到「臺中車站」
    await expect(searchStopsByKeyword("臺中車站", 10)).resolves.toEqual([
      expect.objectContaining({ stopUid: "bus-stop-taichung-station" }),
    ]);

    // 帶台中座標搜尋「車站」時，MongoDB $geoNear 優先回傳台中車站
    const tcStops = await searchStopsByKeyword("車站", 10, {
      lat: 24.137,
      lng: 120.686,
    });
    expect(tcStops[0]?.stopUid).toBe("bus-stop-taichung-station");
    expect(tcStops[0]?.distance).toBeLessThan(100);
    expect(tcStops[1]?.stopUid).toBe("bus-stop-taipei-station");
    expect(tcStops[1]?.distance).toBeGreaterThan(100_000);

    // 帶台北座標搜尋「車站」時，MongoDB $geoNear 優先回傳台北車站
    const tpeStops = await searchStopsByKeyword("車站", 10, {
      lat: 25.0478,
      lng: 121.5171,
    });
    expect(tpeStops[0]?.stopUid).toBe("bus-stop-taipei-station");
    expect(tpeStops[0]?.distance).toBeLessThan(100);
    expect(tpeStops[1]?.stopUid).toBe("bus-stop-taichung-station");
    expect(tpeStops[1]?.distance).toBeGreaterThan(100_000);
    const nearby = await findStopsNearby(25.033, 121.565, 1_000, 1);
    expect(nearby).toHaveLength(1);
    expect(nearby[0]?.stopUid).toBe("bus-stop-central");
    expect(nearby[0]?.distance).toBeGreaterThanOrEqual(0);

    await expect(findVehiclesByPlate(["BUS-001"])).resolves.toEqual([
      expect.objectContaining({ plateNumb: "BUS-001", isLowFloor: 1 }),
    ]);
    await expect(
      findRoutesByName("InterCity", ["Blue Line"]),
    ).resolves.toHaveLength(3);
    await expect(findRouteNamesBySubRoute(["Blue Line 1"])).resolves.toEqual([
      expect.objectContaining({
        subRouteName: { Zh_tw: "Blue Line 1" },
        routeName: { Zh_tw: "Blue Line" },
      }),
    ]);
  });
});
