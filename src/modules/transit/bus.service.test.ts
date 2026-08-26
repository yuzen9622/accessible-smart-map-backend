import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../config/fetch", () => ({ tdxFetch: vi.fn() }));
vi.mock("../../model/bus-vehicle.model", () => ({
  default: { find: vi.fn() },
}));
vi.mock("../../model/bus-route.model", () => ({
  default: { find: vi.fn(), aggregate: vi.fn() },
}));
vi.mock("../../model/bus-stop.model", () => ({
  default: { aggregate: vi.fn() },
}));
vi.mock("../../adapters/google.adapter", () => ({ getCity: vi.fn() }));

import { tdxFetch } from "../../config/fetch";
import BusVehicleModel from "../../model/bus-vehicle.model";
import BusRouteModel from "../../model/bus-route.model";
import BusStopModel from "../../model/bus-stop.model";
import {
  getBusRealtimeOnRoute,
  getBusArrivalAtStop,
  searchBusStops,
  searchBusRoutes,
} from "./bus.service";
import { TaiwanCityEn } from "../../types/transit";

const tdxFetchMock = tdxFetch as unknown as ReturnType<typeof vi.fn>;
const vehicleFindMock = BusVehicleModel.find as unknown as ReturnType<
  typeof vi.fn
>;
const routeFindMock = BusRouteModel.find as unknown as ReturnType<typeof vi.fn>;
const stopAggregateMock = BusStopModel.aggregate as unknown as ReturnType<
  typeof vi.fn
>;

function mockRouteMap(rows: unknown[]) {
  routeFindMock.mockReturnValue({
    select: () => ({ lean: () => Promise.resolve(rows) }),
  });
}

function mockTdxJson(rows: unknown[]) {
  tdxFetchMock.mockResolvedValue({ ok: true, json: async () => rows });
}
function mockVehicles(rows: unknown[]) {
  vehicleFindMock.mockReturnValue({ lean: () => Promise.resolve(rows) });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("getBusRealtimeOnRoute — 低底盤 join（招牌功能）", () => {
  it("以在線車牌 join Vehicle 表，標註每台車是否低底盤；無車牌輸入", async () => {
    mockTdxJson([
      {
        PlateNumb: "AAA-1",
        Direction: 0,
        BusPosition: { PositionLat: 25.05, PositionLon: 121.51 },
        Speed: 30,
        BusStatus: 0,
      },
      {
        PlateNumb: "BBB-2",
        Direction: 0,
        BusPosition: { PositionLat: 25.04, PositionLon: 121.52 },
        Speed: 0,
        BusStatus: 3,
      },
    ]);
    // 只有 AAA-1 在 Vehicle 表，且為低底盤；BBB-2 未匯入 → 未知
    mockVehicles([
      { plateNumb: "AAA-1", isLowFloor: 1, hasLiftOrRamp: 1, vehicleClass: 1 },
    ]);

    const result = await getBusRealtimeOnRoute({
      routeName: "307",
      city: TaiwanCityEn.Taipei,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.count).toBe(2);
    expect(result.lowFloorCount).toBe(1);

    const aaa = result.buses.find((b) => b.plateNumb === "AAA-1")!;
    expect(aaa.isLowFloor).toBe("是");
    expect(aaa.hasLiftOrRamp).toBe("是");
    expect(aaa.vehicleClass).toBe("大型巴士");
    expect(aaa.lat).toBe(25.05);

    const bbb = result.buses.find((b) => b.plateNumb === "BBB-2")!;
    expect(bbb.isLowFloor).toBe("未知");
    expect(bbb.statusLabel).toBe("塞車");
  });

  it("路線目前沒有在線車輛時回 404", async () => {
    mockTdxJson([]);
    mockVehicles([]);
    const result = await getBusRealtimeOnRoute({
      routeName: "307",
      city: TaiwanCityEn.Taipei,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.status).toBe(404);
  });
});

describe("getBusArrivalAtStop", () => {
  it("換算秒→分鐘並帶出站名/狀態（V2 N1）", async () => {
    mockTdxJson([
      {
        StopName: { Zh_tw: "台北車站" },
        Direction: 0,
        EstimateTime: 180,
        StopStatus: 0,
      },
    ]);

    const result = await getBusArrivalAtStop({
      routeName: "307",
      stopName: "台北車站",
      city: TaiwanCityEn.Taipei,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.arrivals[0].estimateMinutes).toBe(3);
    expect(result.arrivals[0].stopName).toBe("台北車站");
    expect(result.arrivals[0].directionLabel).toBe("去程");
    expect(result.arrivals[0].statusLabel).toBe("正常");
  });

  it("EstimateTime 缺值時 estimateMinutes 為 null", async () => {
    mockTdxJson([
      { StopName: { Zh_tw: "台北車站" }, Direction: 0, StopStatus: 1 },
    ]);
    const result = await getBusArrivalAtStop({
      routeName: "307",
      stopName: "台北車站",
      city: TaiwanCityEn.Taipei,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.arrivals[0].estimateMinutes).toBeNull();
    expect(result.arrivals[0].statusLabel).toBe("尚未發車");
  });
});

describe("searchBusStops — 站牌關鍵字搜尋", () => {
  it("同名同市的多筆站牌去重成一筆並聯集路線", async () => {
    stopAggregateMock.mockResolvedValue([
      {
        stopUid: "TPE1",
        stopName: { Zh_tw: "台北車站" },
        city: "Taipei",
        subRouteIds: ["307"],
        location: { coordinates: [121.51, 25.04] },
      },
      {
        stopUid: "TPE2",
        stopName: { Zh_tw: "台北車站" },
        city: "Taipei",
        subRouteIds: ["652"],
        location: { coordinates: [121.52, 25.05] },
      },
    ]);
    mockRouteMap([]);

    const result = await searchBusStops("台北");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.stops).toHaveLength(1);
    expect(result.stops[0].stopName).toBe("台北車站");
    expect(result.stops[0].routes).toEqual(["307", "652"]);
  });

  it("同名但不同縣市維持兩筆", async () => {
    stopAggregateMock.mockResolvedValue([
      {
        stopUid: "TPE1",
        stopName: { Zh_tw: "中正路" },
        city: "Taipei",
        subRouteIds: [],
        location: { coordinates: [121.51, 25.04] },
      },
      {
        stopUid: "TXG1",
        stopName: { Zh_tw: "中正路" },
        city: "Taichung",
        subRouteIds: [],
        location: { coordinates: [120.68, 24.14] },
      },
    ]);
    mockRouteMap([]);

    const result = await searchBusStops("中正");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.stops).toHaveLength(2);
    expect(result.stops.map((s) => s.city).sort()).toEqual([
      "Taichung",
      "Taipei",
    ]);
    expect(result.stops[0].distance).toBeUndefined();
  });

  it("提供 location（台中座標）時，台中站牌排在台北站牌前面並帶 distance", async () => {
    stopAggregateMock.mockResolvedValue([
      {
        stopUid: "TPE1",
        stopName: { Zh_tw: "台北車站" },
        city: "Taipei",
        subRouteIds: [],
        location: { coordinates: [121.5171, 25.0478] },
      },
      {
        stopUid: "TXG1",
        stopName: { Zh_tw: "台中車站" },
        city: "Taichung",
        subRouteIds: [],
        location: { coordinates: [120.686, 24.137] },
      },
    ]);
    mockRouteMap([]);

    // 使用者在台中（24.137, 120.686）
    const result = await searchBusStops("車站", {
      lat: 24.137,
      lng: 120.686,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.stops).toHaveLength(2);
    // 第一個應該是台中車站（最近）
    expect(result.stops[0].stopName).toBe("台中車站");
    expect(result.stops[0].city).toBe("Taichung");
    expect(result.stops[0].distance).toBeLessThan(100);

    // 第二個是台北車站（較遠，約 135 km）
    expect(result.stops[1].stopName).toBe("台北車站");
    expect(result.stops[1].city).toBe("Taipei");
    expect(result.stops[1].distance).toBeGreaterThan(100_000);
  });

  it("以 subRouteName→routeName 映射顯示路線名（而非 subRouteId）", async () => {
    stopAggregateMock.mockResolvedValue([
      {
        stopUid: "TPE1",
        stopName: { Zh_tw: "市政府" },
        city: "Taipei",
        subRouteIds: ["0東"],
        location: { coordinates: [121.56, 25.04] },
      },
    ]);
    mockRouteMap([
      { subRouteName: { Zh_tw: "0東" }, routeName: { Zh_tw: "0東" } },
    ]);

    const result = await searchBusStops("市政府");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.stops[0].routes).toEqual(["0東"]);
  });

  it("無匹配時回空陣列（非錯誤）", async () => {
    stopAggregateMock.mockResolvedValue([]);
    const result = await searchBusStops("不存在的站");
    expect(result).toEqual({ ok: true, stops: [] });
  });

  it("DB aggregate 拋錯時回 500", async () => {
    stopAggregateMock.mockRejectedValue(new Error("db down"));
    const result = await searchBusStops("台北");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.status).toBe(500);
  });
});

describe("City / InterCity scope 探測（不從路線號碼寫死判斷）", () => {
  function mockTdxByUrl(rowsFor: (url: string) => unknown[]) {
    tdxFetchMock.mockImplementation(async (url: string) => ({
      ok: true,
      json: async () => rowsFor(url),
    }));
  }

  const stopRow = (stopName: string) => ({
    StopName: { Zh_tw: stopName },
    Direction: 0,
    EstimateTime: 300,
    StopStatus: 0,
  });

  it("4 位數的市區公車（新竹縣 0557）打 City endpoint，不再誤送公路客運", async () => {
    mockTdxByUrl((url) =>
      url.includes("/EstimatedTimeOfArrival/City/HsinchuCounty/0557")
        ? [stopRow("蓮華寺")]
        : [],
    );

    const result = await getBusArrivalAtStop({
      routeName: "0557",
      stopName: "蓮華寺",
      city: TaiwanCityEn.HsinchuCounty,
      direction: 0,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.arrivals[0]).toMatchObject({
      stopName: "蓮華寺",
      estimateMinutes: 5,
    });
    expect(tdxFetchMock).toHaveBeenCalledTimes(1);
    expect(tdxFetchMock.mock.calls[0][0]).toContain(
      "/EstimatedTimeOfArrival/City/HsinchuCounty/0557",
    );
  });

  it("市區查不到時退回公路客運（0968 走 InterCity）", async () => {
    mockTdxByUrl((url) =>
      url.includes("/Streaming/InterCity/0968") ? [stopRow("竹東")] : [],
    );

    const result = await getBusArrivalAtStop({
      routeName: "0968",
      stopName: "竹東",
      city: TaiwanCityEn.HsinchuCounty,
    });

    expect(result.ok).toBe(true);
    expect(tdxFetchMock).toHaveBeenCalledTimes(2);
    expect(tdxFetchMock.mock.calls[0][0]).toContain("/City/HsinchuCounty/0968");
    expect(tdxFetchMock.mock.calls[1][0]).toContain(
      "/Streaming/InterCity/0968",
    );
  });

  it("記住命中的 scope，同一路線再查只打一次 TDX", async () => {
    mockTdxByUrl((url) =>
      url.includes("/Streaming/InterCity/2011") ? [stopRow("斗六")] : [],
    );

    await getBusArrivalAtStop({
      routeName: "2011",
      stopName: "斗六",
      city: TaiwanCityEn.YunlinCounty,
    });
    expect(tdxFetchMock).toHaveBeenCalledTimes(2);

    tdxFetchMock.mockClear();
    const again = await getBusArrivalAtStop({
      routeName: "2011",
      stopName: "斗六",
      city: TaiwanCityEn.YunlinCounty,
    });

    expect(again.ok).toBe(true);
    expect(tdxFetchMock).toHaveBeenCalledTimes(1);
    expect(tdxFetchMock.mock.calls[0][0]).toContain(
      "/Streaming/InterCity/2011",
    );
  });

  it("兩個 scope 都有同名路線時，以「查得到目標站牌」的那個為準", async () => {
    mockTdxByUrl((url) =>
      url.includes("/Streaming/InterCity/5606")
        ? [stopRow("內灣")]
        : [stopRow("完全不同的站")],
    );

    const result = await getBusArrivalAtStop({
      routeName: "5606",
      stopName: "內灣",
      city: TaiwanCityEn.HsinchuCounty,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.arrivals[0].stopName).toBe("內灣");
  });

  it("某個候選 endpoint 拋錯時仍會試完其他候選", async () => {
    tdxFetchMock.mockImplementation(async (url: string) => {
      if (url.includes("/City/HsinchuCounty/5623")) throw new Error("TDX 429");
      return { ok: true, json: async () => [stopRow("竹東")] };
    });

    const result = await getBusArrivalAtStop({
      routeName: "5623",
      stopName: "竹東",
      city: TaiwanCityEn.HsinchuCounty,
    });

    expect(result.ok).toBe(true);
  });

  it("所有候選 endpoint 都失敗時回 500", async () => {
    tdxFetchMock.mockRejectedValue(new Error("TDX 500"));

    const result = await getBusArrivalAtStop({
      routeName: "5624",
      stopName: "竹東",
      city: TaiwanCityEn.HsinchuCounty,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.status).toBe(500);
  });
});

describe("searchBusRoutes — 關鍵字與座標距離排序", () => {
  it("未提供 location 時，按預設順序回傳且不含 distance", async () => {
    (
      BusRouteModel.aggregate as unknown as ReturnType<typeof vi.fn>
    ).mockResolvedValueOnce([
      {
        _id: { routeName: "307", city: "Taipei" },
        subRoutes: [
          {
            direction: 0,
            stops: [
              {
                seq: 1,
                stopName: { Zh_tw: "撫順街口" },
                lat: 25.06,
                lng: 121.52,
              },
              {
                seq: 2,
                stopName: { Zh_tw: "板橋國中" },
                lat: 25.01,
                lng: 121.46,
              },
            ],
          },
        ],
      },
    ]);

    const result = await searchBusRoutes("307");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.routes).toHaveLength(1);
    expect(result.routes[0]).toEqual({
      routeName: "307",
      city: "Taipei",
      departure: "撫順街口",
      destination: "板橋國中",
    });
    expect(result.routes[0].distance).toBeUndefined();
  });

  it("提供 location（台中座標）時，台中路線排在台北路線前面並帶 distance", async () => {
    (
      BusRouteModel.aggregate as unknown as ReturnType<typeof vi.fn>
    ).mockResolvedValueOnce([
      {
        _id: { routeName: "台北車站直達", city: "Taipei" },
        subRoutes: [
          {
            direction: 0,
            stops: [
              {
                seq: 1,
                stopName: { Zh_tw: "台北車站" },
                lat: 25.0478,
                lng: 121.5171,
              },
            ],
          },
        ],
      },
      {
        _id: { routeName: "台中車站接駁", city: "Taichung" },
        subRoutes: [
          {
            direction: 0,
            stops: [
              {
                seq: 1,
                stopName: { Zh_tw: "台中車站" },
                lat: 24.137,
                lng: 120.686,
              },
            ],
          },
        ],
      },
    ]);

    // 使用者在台中（24.137, 120.686）
    const result = await searchBusRoutes("車站", { lat: 24.137, lng: 120.686 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.routes).toHaveLength(2);
    // 第一個應該是台中車站接駁（最近）
    expect(result.routes[0].routeName).toBe("台中車站接駁");
    expect(result.routes[0].city).toBe("Taichung");
    expect(result.routes[0].distance).toBeLessThan(100);

    // 第二個是台北車站直達（較遠，約 135 km）
    expect(result.routes[1].routeName).toBe("台北車站直達");
    expect(result.routes[1].city).toBe("Taipei");
    expect(result.routes[1].distance).toBeGreaterThan(100_000);
  });

  it("路線無站點座標時，以縣市中心座標作為 fallback 計算距離", async () => {
    (
      BusRouteModel.aggregate as unknown as ReturnType<typeof vi.fn>
    ).mockResolvedValueOnce([
      {
        _id: { routeName: "台北無座標路線", city: "Taipei" },
        subRoutes: [{ direction: 0, stops: [] }],
      },
      {
        _id: { routeName: "台中無座標路線", city: "Taichung" },
        subRoutes: [{ direction: 0, stops: [] }],
      },
    ]);

    const result = await searchBusRoutes("路線", { lat: 24.16, lng: 120.64 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.routes[0].routeName).toBe("台中無座標路線");
    expect(result.routes[1].routeName).toBe("台北無座標路線");
  });
});
