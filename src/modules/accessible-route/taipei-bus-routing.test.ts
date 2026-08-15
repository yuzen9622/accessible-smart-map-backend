import { describe, it, expect, vi, beforeEach } from "vitest";
import { scoreAndRank } from "./accessible-route.service";
import type {
  AccessibleRoute,
  WalkLeg,
  BusLeg,
  MetroLeg,
} from "../../types/route";
import type { IOsmA11y } from "../../types";

vi.mock("../../config/fetch", () => ({ tdxFetch: vi.fn() }));
vi.mock("../../model/bus-vehicle.model", () => ({
  default: { find: vi.fn() },
}));
vi.mock("../../model/bus-route.model", () => ({ default: { find: vi.fn() } }));
vi.mock("../../model/bus-stop.model", () => ({
  default: { aggregate: vi.fn() },
}));
vi.mock("../../adapters/google.adapter", () => ({ getCity: vi.fn() }));

import { tdxFetch } from "../../config/fetch";
import BusVehicleModel from "../../model/bus-vehicle.model";
import {
  getBusRealtimeOnRoute,
  getBusArrivalAtStop,
} from "../transit/bus.service";
import { TaiwanCityEn } from "../../types/transit";

const tdxFetchMock = tdxFetch as unknown as ReturnType<typeof vi.fn>;
const vehicleFindMock = BusVehicleModel.find as unknown as ReturnType<
  typeof vi.fn
>;

const dummyLoc: [number, number] = [121.517, 25.0478];

const makeA11yFacility = (category: string, name: string): IOsmA11y => ({
  osmId: `osm-${Math.random().toString(36).substring(2, 7)}`,
  category: category as any,
  name,
  wheelchair: "yes",
  tags: {},
  location: { type: "Point", coordinates: dummyLoc },
  importedAt: new Date(),
});

const walk = (distanceM: number, a11yFacilities: IOsmA11y[] = []): WalkLeg => ({
  type: "WALK",
  from: "起點",
  to: "終點",
  distanceM,
  minutesEst: Math.max(1, Math.round(distanceM / 48)),
  polyline: [dummyLoc, dummyLoc],
  a11yFacilities,
  maxSlopePercent: null,
  crossings: null,
  crossingsWithCurbRamp: null,
  minPathWidthCm: null,
  surfaceType: "unknown",
  restPoints: [],
});

const bus = (
  routeName: string,
  departureStop: string,
  arrivalStop: string,
  depA11y: IOsmA11y[] = [],
  arrA11y: IOsmA11y[] = [],
  waitMinutes = 3,
): BusLeg => ({
  type: "BUS",
  routeName,
  departureStop,
  arrivalStop,
  cityCode: "Taipei",
  waitInfo: { time: waitMinutes * 60, source: "realtime" },
  estimatedWaitMinutes: waitMinutes,
  direction: 0,
  polyline: [dummyLoc, dummyLoc],
  departureStopA11y: depA11y,
  arrivalStopA11y: arrA11y,
  tdxCity: "Taipei",
});

const metro = (lineName: string, dep: string, arr: string): MetroLeg => ({
  type: "METRO",
  railSystem: "TRTC",
  lineName,
  lineId: `TRTC-${lineName}`,
  lineUid: `TRTC-${lineName}`,
  departureStation: dep,
  arrivalStation: arr,
  departureStationUid: `TRTC-${dep}`,
  arrivalStationUid: `TRTC-${arr}`,
  direction: 0,
  stopsCount: 2,
  departureTime: "10:00",
  arrivalTime: "10:15",
  rideMinutes: 15,
  waitInfo: { time: 120, source: "realtime" },
  estimatedWaitMinutes: 2,
  polyline: [dummyLoc, dummyLoc],
  departureStationA11y: [makeA11yFacility("elevator", `${dep}電梯`)],
  arrivalStationA11y: [makeA11yFacility("elevator", `${arr}電梯`)],
  facilityHighlights: [],
});

describe("台北市主要公車路線評分與排序測試 (Taipei Bus Route Scoring & Ranking)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("測試 1: 307 幹線公車（低底盤無障礙設施完備）得分應高於設施較少的普通公車", () => {
    const elevatorDep = makeA11yFacility("elevator", "台北車站無障礙電梯");
    const rampArr = makeA11yFacility("ramp", "撫遠街口斜坡道");

    const route307: AccessibleRoute = {
      routeId: "taipei-bus-307",
      routeName: "307 (板橋-撫遠街)",
      totalMinutes: 25,
      transferCount: 0,
      legs: [
        walk(80, [elevatorDep]),
        bus("307", "台北車站(忠孝)", "撫遠街口", [elevatorDep], [rampArr]),
        walk(100, [rampArr]),
      ],
      accessibilityHighlights: ["無障礙公車", "雙向電梯"],
    };

    const routeStandardBus: AccessibleRoute = {
      routeId: "taipei-bus-standard",
      routeName: "一般幹線公車",
      totalMinutes: 25,
      transferCount: 0,
      legs: [
        walk(250),
        bus("299", "台北車站(鄭州)", "撫遠街口", [], []),
        walk(300),
      ],
      accessibilityHighlights: [],
    };

    const ranked = scoreAndRank([route307, routeStandardBus], "wheelchair");

    expect(ranked[0].routeId).toBe("taipei-bus-307");
    expect(ranked[0].accessibilityScore!).toBeGreaterThan(
      ranked[1].accessibilityScore!,
    );
    expect(ranked[0].totalWalkDistanceM!).toBe(180);
    expect(ranked[1].totalWalkDistanceM!).toBe(550);
  });

  it("測試 2: 羅斯福路幹線 vs 251 路線（政大 → 台北車站）輪椅情境 Flip 排序", () => {
    const routeRoosevelt: AccessibleRoute = {
      routeId: "r1-roosevelt",
      routeName: "羅斯福路幹線",
      totalMinutes: 30,
      transferCount: 0,
      legs: [walk(51), bus("羅斯福路幹線", "政大", "捷運公館站"), walk(685)],
      accessibilityHighlights: [],
    };

    const route251: AccessibleRoute = {
      routeId: "r2-251",
      routeName: "251 (深坑-台北車站)",
      totalMinutes: 34,
      transferCount: 0,
      legs: [walk(759), bus("251", "政大", "台北車站"), walk(685)],
      accessibilityHighlights: [],
    };

    const ranked = scoreAndRank([routeRoosevelt, route251], "wheelchair");

    expect(ranked[0].routeId).toBe("r1-roosevelt");
    expect(ranked[0].totalWalkDistanceM!).toBeLessThan(
      ranked[1].totalWalkDistanceM!,
    );
    expect(ranked[0].scoreComponents?.walkPenalty).toBeLessThan(
      ranked[1].scoreComponents?.walkPenalty ?? Infinity,
    );
  });

  it("測試 3: 捷運接駁公車 (紅2 / 藍28) 轉乘捷運複合運具路線評分", () => {
    const routeFeederBus: AccessibleRoute = {
      routeId: "red2-to-metro",
      routeName: "紅2 轉 淡水信義線",
      totalMinutes: 28,
      transferCount: 1,
      legs: [
        walk(60),
        bus("紅2", "圓山轉運站", "捷運圓山站"),
        walk(30),
        metro("淡水信義線", "圓山", "台北車站"),
        walk(80),
      ],
      accessibilityHighlights: ["捷運轉乘無障礙"],
    };

    const ranked = scoreAndRank([routeFeederBus], "wheelchair");

    expect(ranked).toHaveLength(1);
    expect(ranked[0].transferCount).toBe(1);
    expect(ranked[0].totalWalkDistanceM).toBe(170);
    expect(ranked[0].dataConfidence).toBeDefined();
  });

  it("測試 4: 視障模式 (visual_impaired) 評分偏好", () => {
    const tactileStop = makeA11yFacility("tactile_paving", "導盲磚月台");

    const routeTactileBus: AccessibleRoute = {
      routeId: "tactile-bus-route",
      routeName: "235 (帶導盲設施)",
      totalMinutes: 20,
      transferCount: 0,
      legs: [
        walk(50, [tactileStop]),
        bus("235", "西門市場", "國父紀念館", [tactileStop], [tactileStop]),
        walk(50, [tactileStop]),
      ],
      accessibilityHighlights: ["導盲設施完備"],
    };

    const ranked = scoreAndRank([routeTactileBus], "visual_impaired");

    expect(ranked[0].accessibilityScore).toBeGreaterThanOrEqual(0);
    expect(ranked[0].legs).toHaveLength(3);
  });
});

describe("台北市公車即時動態與低底盤 Join 服務測試 (Bus Realtime & Low-Floor Join)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("測試 5: 307 / 299 公車即時動態與低底盤車牌匹配 (isLowFloor 標註)", async () => {
    tdxFetchMock.mockResolvedValue({
      ok: true,
      json: async () => [
        {
          PlateNumb: "EAL-3071",
          Direction: 0,
          BusPosition: { PositionLat: 25.0478, PositionLon: 121.517 },
          Speed: 25,
          BusStatus: 0,
        },
        {
          PlateNumb: "FAB-2992",
          Direction: 0,
          BusPosition: { PositionLat: 25.045, PositionLon: 121.52 },
          Speed: 0,
          BusStatus: 0,
        },
      ],
    });

    vehicleFindMock.mockReturnValue({
      lean: () =>
        Promise.resolve([
          {
            plateNumb: "EAL-3071",
            isLowFloor: 1,
            hasLiftOrRamp: 1,
            vehicleClass: 1,
          },
          {
            plateNumb: "FAB-2992",
            isLowFloor: 0,
            hasLiftOrRamp: 0,
            vehicleClass: 1,
          },
        ]),
    });

    const result = await getBusRealtimeOnRoute({
      routeName: "307",
      city: TaiwanCityEn.Taipei,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.count).toBe(2);
    expect(result.lowFloorCount).toBe(1);

    const bus307 = result.buses.find((b) => b.plateNumb === "EAL-3071")!;
    expect(bus307.isLowFloor).toBe("是");
    expect(bus307.hasLiftOrRamp).toBe("是");
    expect(bus307.vehicleClass).toBe("大型巴士");

    const bus299 = result.buses.find((b) => b.plateNumb === "FAB-2992")!;
    expect(bus299.isLowFloor).toBe("否");
    expect(bus299.hasLiftOrRamp).toBe("否");
  });

  it("測試 6: 台北車站 / 公館站牌動態到站時間與狀態標籤換算", async () => {
    tdxFetchMock.mockResolvedValue({
      ok: true,
      json: async () => [
        {
          StopName: { Zh_tw: "台北車站(忠孝)" },
          Direction: 0,
          EstimateTime: 180, // 3 分鐘
          StopStatus: 0,
        },
        {
          StopName: { Zh_tw: "捷運公館站" },
          Direction: 0,
          EstimateTime: 30, // 0 分鐘 (即將進站)
          StopStatus: 0,
        },
        {
          StopName: { Zh_tw: "政大" },
          Direction: 0,
          StopStatus: 3, // 末班車已過
        },
      ],
    });

    const result = await getBusArrivalAtStop({
      routeName: "羅斯福路幹線",
      stopName: "台北車站(忠孝)",
      city: TaiwanCityEn.Taipei,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.arrivals).toHaveLength(1);

    const mainStation = result.arrivals[0];
    expect(mainStation.stopName).toBe("台北車站(忠孝)");
    expect(mainStation.estimateMinutes).toBe(3);
    expect(mainStation.statusLabel).toBe("正常");
  });
});
