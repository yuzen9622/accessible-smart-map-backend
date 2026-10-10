import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../a11y/a11y.service", () => ({
  findNearbyLimited: vi.fn(),
  findByOsmIds: vi.fn(),
  findNearbyParking: vi.fn(),
}));
vi.mock("../transit/bus.service", () => ({
  resolveBusCity: vi.fn(),
  getBusRouteInfo: vi.fn(),
  getBusArrivalAtStop: vi.fn(),
  getBusTimetable: vi.fn(),
  getBusRealtimeOnRoute: vi.fn(),
}));
vi.mock("../transit/metro.service", () => ({
  getMetroAlerts: vi.fn(),
}));
vi.mock("../transit/alert.service", () => ({
  getTransitAlerts: vi.fn(),
}));
vi.mock("../transit/train.service", () => ({
  getTrainTimetable: vi.fn(),
  getStationTimetable: vi.fn(),
}));
vi.mock("../air/air.service", () => ({
  getAirData: vi.fn(),
  classifyPm25: vi.fn(),
}));
vi.mock("../campus/campus.service", () => ({
  findNearby: vi.fn(),
  findAll: vi.fn(),
  findByCampusId: vi.fn(),
  listSchools: vi.fn(),
}));
vi.mock("../hazard-report/hazard-report.service", () => ({
  findActiveHazardsForAgent: vi.fn(),
}));
vi.mock("../traffic/road-incident.service", () => ({
  getActiveRoadIncidents: vi.fn(async () => []),
}));
vi.mock("../environment/environment.service", () => ({
  getEnvironmentInfo: vi.fn(),
}));
vi.mock("../../adapters/google.adapter", () => ({
  getCoordinates: vi.fn(),
  searchPlaces: vi.fn(),
}));
vi.mock("../accessible-route/accessible-route.service", () => ({
  planAccessibleRouteFromRequest: vi.fn(),
}));
vi.mock("../nav-instructions/nav-instructions.service", () => ({
  generateNavInstructionsFromInput: vi.fn(),
}));
vi.mock("../accessible-route/route-token.service", () => ({
  attachRouteTokens: vi.fn(async (routes) =>
    routes.map((route: any) => ({
      ...route,
      routeToken: `token-${route.routeId}`,
      navigationId: `nav-${route.routeId}`,
      routeVersion: 1,
    })),
  ),
}));
vi.mock("../accessible-route/facility-slim", () => ({
  slimFacility: vi.fn((f: any) => ({ osmId: f.osmId, category: f.category })),
}));
vi.mock("../../model/emergency-contact.model", () => ({
  default: {
    find: vi.fn(),
    findOne: vi.fn(),
    updateMany: vi.fn(),
  },
}));
vi.mock("../../model/line-link-code.model", () => ({
  default: {
    findOne: vi.fn(),
    deleteOne: vi.fn(),
  },
}));
vi.mock("../../model/sos-session.model", () => ({
  default: {
    findById: vi.fn(),
    findOne: vi.fn(),
    find: vi.fn(),
  },
}));
vi.mock("../../model/user.model", () => ({
  default: {
    find: vi.fn(),
    findById: vi.fn(),
    findOne: vi.fn(),
    updateOne: vi.fn(),
  },
}));
vi.mock("./memory.service", () => ({
  saveMemory: vi.fn(),
  deleteMemory: vi.fn(),
}));
vi.mock("./knowledge.service", () => ({
  searchKnowledge: vi.fn(),
}));
vi.mock("../../config/ai", () => ({
  googleGenAi: {
    models: { generateContent: vi.fn() },
  },
  model: "test-model",
}));

import * as a11yService from "../a11y/a11y.service";
import * as campusService from "../campus/campus.service";
import * as hazardService from "../hazard-report/hazard-report.service";
import { getEnvironmentInfo as fetchEnvironment } from "../environment/environment.service";
import { getCoordinates, searchPlaces } from "../../adapters/google.adapter";
import { planAccessibleRouteFromRequest } from "../accessible-route/accessible-route.service";
import { generateNavInstructionsFromInput } from "../nav-instructions/nav-instructions.service";
import { attachRouteTokens } from "../accessible-route/route-token.service";
import { googleGenAi } from "../../config/ai";
import EmergencyContact from "../../model/emergency-contact.model";
import LineLinkCode from "../../model/line-link-code.model";
import SosSession from "../../model/sos-session.model";
import User from "../../model/user.model";
import * as memoryServiceMod from "./memory.service";
import { searchKnowledge } from "./knowledge.service";
import {
  getEnvironmentInfo,
  findCampusAccessibility,
  getCampusAccessibilityDetails,
  getNearbyHazards,
  findNearbyParking,
  getMetroAlerts,
  getTransitAlerts,
  getNavInstructions,
  saveMemory,
  deleteMemory,
  searchAccessibilityGuide,
  webSearch,
  executeLocalTool,
  getActiveSosContext,
  getSosLiveLocation,
  planRouteToSosVictim,
  bindEmergencyContactCode,
  bindLineAccountCode,
} from "./agent-tools";
import * as metroService from "../transit/metro.service";
import * as alertService from "../transit/alert.service";
import * as busService from "../transit/bus.service";
import { getActiveRoadIncidents } from "../traffic/road-incident.service";

const mockGetCoordinates = getCoordinates as unknown as ReturnType<
  typeof vi.fn
>;
const mockSearchPlaces = searchPlaces as unknown as ReturnType<typeof vi.fn>;
const mockFetchEnvironment = fetchEnvironment as unknown as ReturnType<
  typeof vi.fn
>;
const mockCampusFindNearby = campusService.findNearby as unknown as ReturnType<
  typeof vi.fn
>;
const mockCampusFindAll = campusService.findAll as unknown as ReturnType<
  typeof vi.fn
>;
const mockCampusFindByCampusId =
  campusService.findByCampusId as unknown as ReturnType<typeof vi.fn>;
const mockHazardFindNearby =
  hazardService.findActiveHazardsForAgent as unknown as ReturnType<
    typeof vi.fn
  >;
const mockA11yParking = a11yService.findNearbyParking as unknown as ReturnType<
  typeof vi.fn
>;
const mockMetroAlerts = metroService.getMetroAlerts as unknown as ReturnType<
  typeof vi.fn
>;
const mockGetTransitAlerts =
  alertService.getTransitAlerts as unknown as ReturnType<typeof vi.fn>;
const mockResolveBusCity = busService.resolveBusCity as unknown as ReturnType<
  typeof vi.fn
>;
const mockPlanRoute = planAccessibleRouteFromRequest as unknown as ReturnType<
  typeof vi.fn
>;
const mockGenNav = generateNavInstructionsFromInput as unknown as ReturnType<
  typeof vi.fn
>;
const mockGenerateContent = googleGenAi.models
  .generateContent as unknown as ReturnType<typeof vi.fn>;
const mockEmergencyContactFind = EmergencyContact.find as unknown as ReturnType<
  typeof vi.fn
>;
const mockEmergencyContactFindOne =
  EmergencyContact.findOne as unknown as ReturnType<typeof vi.fn>;
const mockLineLinkFindOne = LineLinkCode.findOne as unknown as ReturnType<
  typeof vi.fn
>;
const mockLineLinkDeleteOne = LineLinkCode.deleteOne as unknown as ReturnType<
  typeof vi.fn
>;
const mockSosSessionFindById = SosSession.findById as unknown as ReturnType<
  typeof vi.fn
>;
const mockSosSessionFind = SosSession.find as unknown as ReturnType<
  typeof vi.fn
>;
const mockUserFind = User.find as unknown as ReturnType<typeof vi.fn>;
const mockUserFindById = User.findById as unknown as ReturnType<typeof vi.fn>;
const mockUserFindOne = User.findOne as unknown as ReturnType<typeof vi.fn>;
const mockUserUpdateOne = User.updateOne as unknown as ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.clearAllMocks();
});

describe("findGooglePlaces location fallback", () => {
  it("uses the session GPS as one coordinate pair when model coordinates are absent", async () => {
    mockSearchPlaces.mockResolvedValue([]);

    await executeLocalTool(
      "findGooglePlaces",
      { query: "火車站" },
      { latitude: 25.0478, longitude: 121.517 },
    );

    expect(mockSearchPlaces).toHaveBeenCalledWith("火車站", {
      latitude: 25.0478,
      longitude: 121.517,
      sortByDistance: true,
    });
  });

  it("prefers a complete valid model coordinate pair over session GPS", async () => {
    mockSearchPlaces.mockResolvedValue([]);

    await executeLocalTool(
      "findGooglePlaces",
      { query: "捷運站", latitude: 25.1, longitude: 121.6 },
      { latitude: 24.1, longitude: 120.6 },
    );

    expect(mockSearchPlaces).toHaveBeenCalledWith("捷運站", {
      latitude: 25.1,
      longitude: 121.6,
      sortByDistance: true,
    });
  });

  it("does not mix a partial model coordinate with session GPS", async () => {
    mockSearchPlaces.mockResolvedValue([]);

    await executeLocalTool(
      "findGooglePlaces",
      { query: "火車站", latitude: 25.1 },
      { latitude: 24.1, longitude: 120.6 },
    );

    expect(mockSearchPlaces).toHaveBeenCalledWith("火車站", {
      latitude: 24.1,
      longitude: 120.6,
      sortByDistance: true,
    });
  });

  it("keeps an unlocated search unlocated when no valid coordinate pair exists", async () => {
    mockSearchPlaces.mockResolvedValue([]);

    await executeLocalTool("findGooglePlaces", {
      query: "火車站",
      latitude: 999,
    });

    expect(mockSearchPlaces).toHaveBeenCalledWith("火車站", {
      latitude: undefined,
      longitude: undefined,
      sortByDistance: false,
    });
  });
});

// ---------------------------------------------------------------------------
// getEnvironmentInfo
// ---------------------------------------------------------------------------
describe("getEnvironmentInfo", () => {
  const envData = {
    location: { lat: 25.05, lng: 121.51 },
    weather: { status: "ok", temperature: 28 },
    airQuality: { status: "ok", pm25: 12, quality: "良好" },
    nearbyCctv: { status: "ok", cameras: [] },
  };

  it("用經緯度查詢成功", async () => {
    mockFetchEnvironment.mockResolvedValue(envData);
    const raw = await getEnvironmentInfo({
      latitude: 25.05,
      longitude: 121.51,
    });
    const result = JSON.parse(raw);
    expect(result.ok).toBe(true);
    expect(result.weather.status).toBe("ok");
    expect(mockFetchEnvironment).toHaveBeenCalledWith(25.05, 121.51, 1000);
  });

  it("用地名 geocode 後查詢", async () => {
    mockGetCoordinates.mockResolvedValue({
      latitude: 25.05,
      longitude: 121.51,
    });
    mockFetchEnvironment.mockResolvedValue(envData);
    const raw = await getEnvironmentInfo({ query: "台北車站" });
    const result = JSON.parse(raw);
    expect(result.ok).toBe(true);
    expect(result.query).toBe("台北車站");
    expect(mockGetCoordinates).toHaveBeenCalledWith(
      "台北車站",
      undefined,
      undefined,
    );
  });

  it("地名 geocode 失敗回錯誤", async () => {
    mockGetCoordinates.mockResolvedValue(null);
    const raw = await getEnvironmentInfo({ query: "不存在的地點" });
    const result = JSON.parse(raw);
    expect(result.ok).toBe(false);
    expect(result.error).toContain("不存在的地點");
  });

  it("缺少位置資訊回錯誤", async () => {
    const raw = await getEnvironmentInfo({} as any);
    const result = JSON.parse(raw);
    expect(result.ok).toBe(false);
    expect(result.error).toContain("缺少位置資訊");
  });

  it("未指定地點時以注入的最新使用者位置查詢", async () => {
    mockFetchEnvironment.mockResolvedValue(envData);
    const raw = await getEnvironmentInfo({
      userLocation: { latitude: 25.0478, longitude: 121.517 },
    });
    expect(JSON.parse(raw).ok).toBe(true);
    expect(mockGetCoordinates).not.toHaveBeenCalled();
    expect(mockFetchEnvironment).toHaveBeenCalledWith(25.0478, 121.517, 1000);
  });

  it("自訂 radius 傳遞正確", async () => {
    mockFetchEnvironment.mockResolvedValue(envData);
    await getEnvironmentInfo({ latitude: 25, longitude: 121, radius: 2000 });
    expect(mockFetchEnvironment).toHaveBeenCalledWith(25, 121, 2000);
  });

  it("geocode 帶入 userLocation 作 bias", async () => {
    mockGetCoordinates.mockResolvedValue({
      latitude: 25.05,
      longitude: 121.51,
    });
    mockFetchEnvironment.mockResolvedValue(envData);
    await getEnvironmentInfo({
      query: "車站",
      userLocation: { latitude: 25.1, longitude: 121.6 },
    });
    expect(mockGetCoordinates).toHaveBeenCalledWith("車站", 25.1, 121.6);
  });

  it("service 拋錯時回 fallback 錯誤", async () => {
    mockFetchEnvironment.mockRejectedValue(new Error("boom"));
    const raw = await getEnvironmentInfo({ latitude: 25, longitude: 121 });
    const result = JSON.parse(raw);
    expect(result.ok).toBe(false);
    expect(result.error).toBe("環境資訊查詢失敗");
  });
});

// ---------------------------------------------------------------------------
// findCampusAccessibility / getCampusAccessibilityDetails
// ---------------------------------------------------------------------------
describe("campus accessibility agent tools", () => {
  const campusSummary = {
    campusId: 29,
    schoolId: 33,
    schoolName: "國立臺灣大學",
    branchName: "校總區",
    city: "臺北市",
    address: "臺北市大安區羅斯福路四段1號",
    buildingCount: 120,
    facilityCount: 680,
    facTypeSummary: [{ code: "elevator", label: "無障礙電梯", count: 24 }],
  };

  const campusDetail = {
    ...campusSummary,
    phone: "02-33663366",
    facilities: [
      {
        facUid: "F1",
        facTypeId: 8,
        type: "elevator",
        facType: "無障礙電梯",
        name: "行政大樓電梯",
        floors: ["1"],
        floorIds: ["L1"],
      },
      {
        facUid: "F2",
        facTypeId: 6,
        type: "accessible_toilet",
        facType: "無障礙廁所",
        name: "圖書館廁所",
        floors: ["2"],
        floorIds: ["L2"],
      },
    ],
    importedAt: new Date("2026-06-24T00:00:00.000Z"),
  };

  it("用校名關鍵字查校區摘要", async () => {
    mockCampusFindAll.mockResolvedValue({
      items: [campusSummary],
      totalCount: 1,
      page: 1,
      totalPages: 1,
    });
    const raw = await findCampusAccessibility({
      query: "臺灣大學",
      type: "elevator",
    });
    const result = JSON.parse(raw);
    expect(result.ok).toBe(true);
    expect(result.mode).toBe("search");
    expect(result.campuses).toHaveLength(1);
    expect(mockCampusFindAll).toHaveBeenCalledWith({
      city: undefined,
      type: "elevator",
      keyword: "臺灣大學",
      page: 1,
      limit: 5,
    });
  });

  it("用使用者目前位置查附近校區", async () => {
    mockCampusFindNearby.mockResolvedValue([campusSummary]);
    const raw = await findCampusAccessibility({
      type: "accessible_toilet",
      userLocation: { latitude: 25.05, longitude: 121.51 },
    });
    const result = JSON.parse(raw);
    expect(result.ok).toBe(true);
    expect(result.mode).toBe("nearby");
    expect(mockCampusFindNearby).toHaveBeenCalledWith(
      25.05,
      121.51,
      1000,
      "accessible_toilet",
    );
  });

  it("校名查不到時 geocode 地點後改查附近校區", async () => {
    mockCampusFindAll.mockResolvedValue({
      items: [],
      totalCount: 0,
      page: 1,
      totalPages: 0,
    });
    mockGetCoordinates.mockResolvedValue({
      latitude: 25.0478,
      longitude: 121.5171,
    });
    mockCampusFindNearby.mockResolvedValue([campusSummary]);
    const raw = await findCampusAccessibility({
      query: "台北車站附近",
      radiusM: 1500,
    });
    const result = JSON.parse(raw);
    expect(result.ok).toBe(true);
    expect(result.mode).toBe("nearby");
    expect(mockCampusFindNearby).toHaveBeenCalledWith(
      25.0478,
      121.5171,
      1500,
      undefined,
    );
  });

  it("依 campusId 查校區詳情並可篩選設施類型", async () => {
    mockCampusFindByCampusId.mockResolvedValue(campusDetail);
    const raw = await getCampusAccessibilityDetails({
      campusId: 29,
      type: "elevator",
    });
    const result = JSON.parse(raw);
    expect(result.ok).toBe(true);
    expect(result.campus.schoolName).toBe("國立臺灣大學");
    expect(result.campus.campusId).toBe(29);
    expect(result.totalMatchedFacilities).toBe(1);
    expect(result.facilities[0].type).toBe("elevator");
    expect(mockCampusFindByCampusId).toHaveBeenCalledWith(29);
  });

  it("查無 campusId 時回錯誤", async () => {
    mockCampusFindByCampusId.mockResolvedValue(null);
    const raw = await getCampusAccessibilityDetails({ campusId: 123 });
    expect(JSON.parse(raw).ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// getNearbyHazards
// ---------------------------------------------------------------------------
describe("getNearbyHazards", () => {
  // The machine-safe projection: no description, photo or identity fields.
  const hazardResult = [
    { id: "a", hazardType: "obstacle", verification: "photo_supported" },
    { id: "b", hazardType: "obstacle", verification: "legacy" },
  ];

  it("同時回傳附近的政府道路施工事件，最近的在前且標 source", async () => {
    mockHazardFindNearby.mockResolvedValue(hazardResult);
    vi.mocked(getActiveRoadIncidents).mockResolvedValueOnce([
      {
        incidentId: "far",
        title: "道路施工",
        severity: "advisory",
        location: { lat: 25.053, lng: 121.51 },
      },
      {
        incidentId: "near",
        title: "道路施工",
        description: "道路維護",
        severity: "closure",
        roadClosed: true,
        endTime: "2026-12-31T23:59:59+08:00",
        location: { lat: 25.06, lng: 121.51 },
        points: [
          { lat: 25.06, lng: 121.51 },
          { lat: 25.0501, lng: 121.51 },
        ],
      },
      {
        incidentId: "out",
        title: "道路施工",
        severity: "advisory",
        location: { lat: 25.2, lng: 121.51 },
      },
    ]);

    const result = JSON.parse(
      await getNearbyHazards({ latitude: 25.05, longitude: 121.51 }),
    );

    expect(result.data.total).toBe(2);
    expect(result.data.roadEvents).toEqual([
      expect.objectContaining({
        source: "government",
        hazardType: "construction",
        severity: "closure",
        roadClosed: true,
        location: { lat: 25.0501, lng: 121.51 },
        distanceM: 11,
      }),
      expect.objectContaining({ title: "道路施工", distanceM: 334 }),
    ]);
  });

  it("篩選非施工類型時不回傳政府施工事件", async () => {
    mockHazardFindNearby.mockResolvedValue(hazardResult);
    const result = JSON.parse(
      await getNearbyHazards({
        latitude: 25.05,
        longitude: 121.51,
        hazardType: "data_error",
      }),
    );
    expect(result.data.roadEvents).toEqual([]);
    expect(getActiveRoadIncidents).not.toHaveBeenCalledWith(expect.anything());
  });

  it("用經緯度查詢成功", async () => {
    mockHazardFindNearby.mockResolvedValue(hazardResult);
    const raw = await getNearbyHazards({ latitude: 25.05, longitude: 121.51 });
    const result = JSON.parse(raw);
    expect(result.ok).toBe(true);
    expect(result.data.total).toBe(2);
    expect(mockHazardFindNearby).toHaveBeenCalledWith({
      lat: 25.05,
      lng: 121.51,
      radiusM: undefined,
      hazardType: undefined,
    });
    // Only the projected reports reach the LLM; no raw service envelope.
    expect(result.data.reports).toEqual(hazardResult);
  });

  it("用地名 geocode 後查詢", async () => {
    mockGetCoordinates.mockResolvedValue({
      latitude: 25.05,
      longitude: 121.51,
    });
    mockHazardFindNearby.mockResolvedValue(hazardResult);
    const raw = await getNearbyHazards({ query: "中正紀念堂" });
    const result = JSON.parse(raw);
    expect(result.ok).toBe(true);
    expect(mockHazardFindNearby).toHaveBeenCalledWith(
      expect.objectContaining({ lat: 25.05, lng: 121.51 }),
    );
  });

  it("地名 geocode 失敗回錯誤", async () => {
    mockGetCoordinates.mockResolvedValue(null);
    const raw = await getNearbyHazards({ query: "火星" });
    const result = JSON.parse(raw);
    expect(result.ok).toBe(false);
    expect(result.error).toContain("火星");
  });

  it("傳遞 hazardType 篩選", async () => {
    mockHazardFindNearby.mockResolvedValue(hazardResult);
    await getNearbyHazards({
      latitude: 25,
      longitude: 121,
      hazardType: "construction",
    });
    expect(mockHazardFindNearby).toHaveBeenCalledWith(
      expect.objectContaining({ hazardType: "construction" }),
    );
  });

  it("傳遞 radiusM", async () => {
    mockHazardFindNearby.mockResolvedValue(hazardResult);
    await getNearbyHazards({ latitude: 25, longitude: 121, radiusM: 1000 });
    expect(mockHazardFindNearby).toHaveBeenCalledWith(
      expect.objectContaining({ radiusM: 1000 }),
    );
  });

  it("缺少位置資訊回錯誤", async () => {
    const raw = await getNearbyHazards({});
    const result = JSON.parse(raw);
    expect(result.ok).toBe(false);
  });

  it("service 拋錯時回 fallback", async () => {
    mockHazardFindNearby.mockRejectedValue(new Error("db down"));
    const raw = await getNearbyHazards({ latitude: 25, longitude: 121 });
    const result = JSON.parse(raw);
    expect(result.ok).toBe(false);
    expect(result.error).toBe("附近路況查詢失敗");
  });
});

// ---------------------------------------------------------------------------
// findNearbyParking
// ---------------------------------------------------------------------------
describe("findNearbyParking", () => {
  const spots = [
    {
      _id: "1",
      location: { coordinates: [121.51, 25.05] },
      address: "中正路1號",
    },
    {
      _id: "2",
      location: { coordinates: [121.52, 25.04] },
      address: "信義路2號",
    },
  ];

  it("用經緯度查詢成功", async () => {
    mockA11yParking.mockResolvedValue(spots);
    const raw = await findNearbyParking({ latitude: 25.05, longitude: 121.51 });
    const result = JSON.parse(raw);
    expect(result.ok).toBe(true);
    expect(result.total).toBe(2);
    expect(result.parkingSpots).toHaveLength(2);
    expect(mockA11yParking).toHaveBeenCalledWith(25.05, 121.51, 500, undefined);
  });

  it("用地名 geocode 後查詢", async () => {
    mockGetCoordinates.mockResolvedValue({
      latitude: 25.05,
      longitude: 121.51,
    });
    mockA11yParking.mockResolvedValue(spots);
    const raw = await findNearbyParking({ query: "板橋車站" });
    const result = JSON.parse(raw);
    expect(result.ok).toBe(true);
    expect(result.query).toBe("板橋車站");
  });

  it("自訂 radiusM", async () => {
    mockA11yParking.mockResolvedValue([]);
    await findNearbyParking({ latitude: 25, longitude: 121, radiusM: 1000 });
    expect(mockA11yParking).toHaveBeenCalledWith(25, 121, 1000, undefined);
  });

  it("把 type 參數透傳給 service", async () => {
    mockA11yParking.mockResolvedValue([]);
    await findNearbyParking({ latitude: 25, longitude: 121, type: "standard" });
    expect(mockA11yParking).toHaveBeenCalledWith(25, 121, 500, "standard");
  });

  it("無結果時 total 為 0", async () => {
    mockA11yParking.mockResolvedValue([]);
    const raw = await findNearbyParking({ latitude: 25, longitude: 121 });
    const result = JSON.parse(raw);
    expect(result.ok).toBe(true);
    expect(result.total).toBe(0);
    expect(result.parkingSpots).toEqual([]);
  });

  it("缺少位置回錯誤", async () => {
    const raw = await findNearbyParking({});
    const result = JSON.parse(raw);
    expect(result.ok).toBe(false);
  });

  it("geocode 失敗回錯誤", async () => {
    mockGetCoordinates.mockResolvedValue(null);
    const raw = await findNearbyParking({ query: "外太空" });
    const result = JSON.parse(raw);
    expect(result.ok).toBe(false);
    expect(result.error).toContain("外太空");
  });

  it("service 拋錯時回 fallback", async () => {
    mockA11yParking.mockRejectedValue(new Error("db down"));
    const raw = await findNearbyParking({ latitude: 25, longitude: 121 });
    const result = JSON.parse(raw);
    expect(result.ok).toBe(false);
    expect(result.error).toBe("停車位查詢失敗");
  });
});

// ---------------------------------------------------------------------------
// getMetroAlerts
// ---------------------------------------------------------------------------
describe("getMetroAlerts", () => {
  it("全部正常時回傳摘要", async () => {
    mockMetroAlerts.mockResolvedValue([
      {
        railSystem: "TRTC",
        updatedAt: "2026-08-15T10:00:00+08:00",
        alerts: [],
      },
    ]);

    const raw = await getMetroAlerts({});
    const result = JSON.parse(raw);

    expect(mockMetroAlerts).toHaveBeenCalledWith(undefined);
    expect(result).toEqual({
      ok: true,
      summary: "各捷運系統目前皆正常營運，無異常公告",
      alerts: [],
    });
  });

  it("有異常時透傳各系統公告", async () => {
    const alerts = [
      {
        railSystem: "TRTC",
        updatedAt: "2026-08-15T10:00:00+08:00",
        alerts: [
          {
            alertId: "fault-1",
            title: "電梯故障",
            description: "R10 電梯維修中",
            status: 2,
            stations: [{ id: "R10", name: "中山站" }],
            lines: ["R"],
            publishTime: "2026-08-15T09:30:00+08:00",
            updateTime: "2026-08-15T09:45:00+08:00",
          },
        ],
      },
    ];
    mockMetroAlerts.mockResolvedValue(alerts);

    const raw = await getMetroAlerts({ railSystem: "TRTC" });
    const result = JSON.parse(raw);

    expect(mockMetroAlerts).toHaveBeenCalledWith("TRTC");
    expect(result).toEqual({ ok: true, alerts });
  });

  it("service 拋錯時回 fallback", async () => {
    mockMetroAlerts.mockRejectedValue(new Error("TDX unavailable"));

    const raw = await getMetroAlerts({});
    const result = JSON.parse(raw);

    expect(result).toEqual({ ok: false, error: "捷運營運狀態查詢失敗" });
  });
});

// ---------------------------------------------------------------------------
// getTransitAlerts
// ---------------------------------------------------------------------------
describe("getTransitAlerts", () => {
  it("不支援的運具類型回傳錯誤", async () => {
    const raw = await getTransitAlerts({ mode: "airplane" as any });
    const result = JSON.parse(raw);
    expect(result.ok).toBe(false);
    expect(result.error).toContain("不支援的運具類型");
  });

  it("公車模式缺少 routeName 時回傳錯誤", async () => {
    const raw = await getTransitAlerts({ mode: "bus" });
    const result = JSON.parse(raw);
    expect(result.ok).toBe(false);
    expect(result.error).toContain("路線名稱");
  });

  it("公車模式縣市無法解析時回傳錯誤", async () => {
    mockResolveBusCity.mockResolvedValue(null);
    const raw = await getTransitAlerts({ mode: "bus", routeName: "307" });
    const result = JSON.parse(raw);
    expect(result.ok).toBe(false);
    expect(result.error).toContain("無法判斷縣市");
  });

  it("公車模式成功查詢並無通阻", async () => {
    mockResolveBusCity.mockResolvedValue("Taipei");
    mockGetTransitAlerts.mockResolvedValue({
      ok: true,
      mode: "bus",
      matchedAt: "2026-08-15T10:00:00Z",
      alerts: [],
    });

    const raw = await getTransitAlerts({
      mode: "bus",
      routeName: "307",
      city: "Taipei",
      direction: 0,
    });
    const result = JSON.parse(raw);

    expect(result.ok).toBe(true);
    expect(result.total).toBe(0);
    expect(result.summary).toContain("正常");
    expect(mockGetTransitAlerts).toHaveBeenCalledWith({
      mode: "bus",
      city: "Taipei",
      routeName: "307",
      direction: 0,
      stopName: undefined,
    });
  });

  it("公車模式成功查詢並回傳警報", async () => {
    mockResolveBusCity.mockResolvedValue("Taipei");
    const fakeAlert = {
      alertId: "alert-307",
      title: "307 路線改道通知",
      description: "因施工改道",
      status: 2,
      matchKind: "route",
    };
    mockGetTransitAlerts.mockResolvedValue({
      ok: true,
      mode: "bus",
      matchedAt: "2026-08-15T10:00:00Z",
      alerts: [fakeAlert],
    });

    const raw = await getTransitAlerts({
      mode: "bus",
      routeName: "307",
      city: "Taipei",
    });
    const result = JSON.parse(raw);

    expect(result.ok).toBe(true);
    expect(result.total).toBe(1);
    expect(result.alerts[0].alertId).toBe("alert-307");
  });

  it("捷運行駛與台鐵查詢正常透傳", async () => {
    mockGetTransitAlerts.mockResolvedValue({
      ok: true,
      mode: "metro",
      matchedAt: "2026-08-15T10:00:00Z",
      alerts: [],
    });

    const rawMetro = await getTransitAlerts({
      mode: "metro",
      routeName: "板南線",
      railSystem: "TRTC",
    });
    expect(JSON.parse(rawMetro).ok).toBe(true);

    mockGetTransitAlerts.mockResolvedValue({
      ok: true,
      mode: "tra",
      matchedAt: "2026-08-15T10:00:00Z",
      alerts: [],
    });

    const rawTra = await getTransitAlerts({
      mode: "tra",
      trainNo: "123",
      stopName: "台北",
    });
    expect(JSON.parse(rawTra).ok).toBe(true);
  });

  it("executeLocalTool 支援 getTransitAlerts 派工", async () => {
    mockGetTransitAlerts.mockResolvedValue({
      ok: true,
      mode: "thsr",
      matchedAt: "2026-08-15T10:00:00Z",
      alerts: [],
    });

    const raw = await executeLocalTool("getTransitAlerts", {
      mode: "thsr",
      trainNo: "603",
    });
    const result = JSON.parse(raw);
    expect(result.ok).toBe(true);
    expect(result.mode).toBe("thsr");
  });

  it("底層服務拋錯時回傳失敗", async () => {
    mockGetTransitAlerts.mockRejectedValue(new Error("Network failure"));
    const raw = await getTransitAlerts({ mode: "metro" });
    const result = JSON.parse(raw);
    expect(result.ok).toBe(false);
    expect(result.error).toContain("大眾運輸通阻查詢失敗");
  });
});

// ---------------------------------------------------------------------------
// getNavInstructions
// ---------------------------------------------------------------------------
describe("getNavInstructions", () => {
  const navOk = {
    ok: true,
    data: {
      instructions: [{ text: "搭乘 99 公車", legType: "BUS" }],
      totalSteps: 1,
      warnings: [],
    },
  };
  it("reads the selected token and never calls the planner", async () => {
    mockGenNav.mockResolvedValue(navOk);
    const result = JSON.parse(
      await getNavInstructions({
        routeToken: "selected-bus",
        userHeading: 45,
        language: "en",
      }),
    );
    expect(result).toMatchObject({
      ok: true,
      totalSteps: 1,
      instructions: navOk.data.instructions,
    });
    expect(mockGenNav).toHaveBeenCalledWith({
      routeToken: "selected-bus",
      userHeading: 45,
      language: "en",
    });
    expect(mockPlanRoute).not.toHaveBeenCalled();
  });
  it("refuses legacy origin/destination/index without a trusted token", async () => {
    const result = JSON.parse(
      await getNavInstructions({
        origin: "A",
        destination: "B",
        routeIndex: 1,
      }),
    );
    expect(result).toMatchObject({
      ok: false,
      reason: "ROUTE_CONTEXT_REQUIRED",
    });
    expect(mockPlanRoute).not.toHaveBeenCalled();
    expect(mockGenNav).not.toHaveBeenCalled();
  });
  it("does not replan when the selected token expires", async () => {
    mockGenNav.mockResolvedValue({
      ok: false,
      status: 400,
      reason: "INVALID_ROUTE_TOKEN",
      message: "路線已過期",
    });
    expect(
      JSON.parse(await getNavInstructions({ routeToken: "expired" })),
    ).toMatchObject({
      ok: false,
      reason: "INVALID_ROUTE_TOKEN",
      error: "路線已過期",
    });
    expect(mockPlanRoute).not.toHaveBeenCalled();
  });
  it("fails closed on token storage failures", async () => {
    mockGenNav.mockRejectedValue(new Error("cache timeout"));
    expect(
      JSON.parse(await getNavInstructions({ routeToken: "selected" })),
    ).toMatchObject({ ok: false, reason: "ROUTE_CONTEXT_UNAVAILABLE" });
    expect(mockPlanRoute).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// LINE SOS tools
// ---------------------------------------------------------------------------
describe("LINE SOS tools", () => {
  it("getActiveSosContext 回傳 trackingUrl", async () => {
    mockEmergencyContactFind.mockReturnValue({
      select: () => ({
        lean: () =>
          Promise.resolve([{ _id: "c1", userId: "u1", name: "王小明" }]),
      }),
    });
    mockUserFind.mockReturnValue({
      select: () => ({
        lean: () => Promise.resolve([{ _id: "u1", name: "王小明" }]),
      }),
    });
    mockSosSessionFind.mockReturnValue({
      sort: () => ({
        lean: () =>
          Promise.resolve([
            {
              _id: "s1",
              userId: "u1",
              type: "body",
              status: "active",
              address: "台北車站",
              lat: 25.0478,
              lng: 121.5171,
              locationUpdatedAt: new Date("2026-07-09T01:00:00.000Z"),
              updatedAt: new Date("2026-07-09T01:00:00.000Z"),
              shareToken: "token123",
            },
          ]),
      }),
    });

    const raw = await getActiveSosContext({}, "line-1");
    const result = JSON.parse(raw);
    expect(result.ok).toBe(true);
    expect(result.activeSessions[0].trackingUrl).toContain("/zh-TW?sos=s1");
  });

  it("getSosLiveLocation 回傳前端 trackingUrl", async () => {
    mockEmergencyContactFind.mockReturnValue({
      select: () => ({
        lean: () =>
          Promise.resolve([{ _id: "c1", userId: "u1", name: "王小明" }]),
      }),
    });
    mockSosSessionFindById.mockReturnValue({
      lean: () =>
        Promise.resolve({
          _id: "s1",
          userId: "u1",
          type: "body",
          status: "active",
          address: "台北車站",
          lat: 25.0478,
          lng: 121.5171,
          locationUpdatedAt: new Date("2026-07-09T01:00:00.000Z"),
          shareToken: "token123",
        }),
    });
    mockUserFindById.mockReturnValue({
      select: () => ({
        lean: () => Promise.resolve({ name: "王小明" }),
      }),
    });

    const raw = await getSosLiveLocation({ sessionId: "s1" }, "line-1");
    const result = JSON.parse(raw);
    expect(result.ok).toBe(true);
    expect(result.trackingUrl).toContain("/zh-TW?sos=s1");
  });

  it("planRouteToSosVictim 使用共享位置當起點", async () => {
    mockEmergencyContactFindOne.mockReturnValue({
      sort: () => ({
        select: () => ({
          lean: () =>
            Promise.resolve({
              lastLineLat: 25.03,
              lastLineLng: 121.56,
              lastLineLocationUpdatedAt: new Date("2026-07-09T01:10:00.000Z"),
            }),
        }),
      }),
    });
    mockEmergencyContactFind.mockReturnValue({
      select: () => ({
        lean: () =>
          Promise.resolve([{ _id: "c1", userId: "u1", name: "王小明" }]),
      }),
    });
    mockSosSessionFindById.mockReturnValue({
      lean: () =>
        Promise.resolve({
          _id: "s1",
          userId: "u1",
          type: "body",
          status: "active",
          address: "台北車站",
          lat: 25.0478,
          lng: 121.5171,
          locationUpdatedAt: new Date("2026-07-09T01:00:00.000Z"),
          shareToken: "token123",
        }),
    });
    mockUserFindById.mockReturnValue({
      select: () => ({
        lean: () => Promise.resolve({ name: "王小明" }),
      }),
    });
    mockPlanRoute.mockResolvedValue({
      ok: true,
      data: {
        origin: { lat: 25.03, lng: 121.56 },
        destination: { lat: 25.0478, lng: 121.5171 },
        city: "Taipei",
        routes: [
          { routeName: "route1", totalMinutes: 12, legs: [{ type: "WALK" }] },
        ],
      },
    });

    const raw = await planRouteToSosVictim({ sessionId: "s1" }, "line-1");
    const result = JSON.parse(raw);
    expect(result.ok).toBe(true);
    expect(mockPlanRoute).toHaveBeenCalledWith(
      expect.objectContaining({
        origin: { latitude: 25.03, longitude: 121.56 },
        destination: { latitude: 25.0478, longitude: 121.5171 },
        maxTransfers: 2,
        // The victim's live position must not be moved to a park entrance.
        keepExactDestination: true,
      }),
    );
  });
});

// ---------------------------------------------------------------------------
// executeLocalTool — 新工具註冊
// ---------------------------------------------------------------------------
describe("executeLocalTool dispatches new tools", () => {
  it("getEnvironmentInfo 走到正確函式", async () => {
    mockFetchEnvironment.mockResolvedValue({
      location: { lat: 25, lng: 121 },
      weather: { status: "ok" },
      airQuality: { status: "ok" },
      nearbyCctv: { status: "ok" },
    });
    const raw = await executeLocalTool(
      "getEnvironmentInfo",
      { latitude: 25, longitude: 121 },
      undefined,
    );
    expect(JSON.parse(raw).ok).toBe(true);
  });

  it("getNearbyHazards 走到正確函式", async () => {
    mockHazardFindNearby.mockResolvedValue([]);
    const raw = await executeLocalTool(
      "getNearbyHazards",
      { latitude: 25, longitude: 121 },
      undefined,
    );
    expect(JSON.parse(raw).ok).toBe(true);
  });

  it("findNearbyParking 走到正確函式", async () => {
    mockA11yParking.mockResolvedValue([]);
    const raw = await executeLocalTool(
      "findNearbyParking",
      { latitude: 25, longitude: 121 },
      undefined,
    );
    expect(JSON.parse(raw).ok).toBe(true);
  });

  it("findCampusAccessibility 走到正確函式", async () => {
    mockCampusFindAll.mockResolvedValue({
      items: [],
      totalCount: 0,
      page: 1,
      totalPages: 0,
    });
    const raw = await executeLocalTool(
      "findCampusAccessibility",
      { city: "臺北市" },
      undefined,
    );
    expect(JSON.parse(raw).ok).toBe(true);
  });

  it("getCampusAccessibilityDetails 走到正確函式", async () => {
    mockCampusFindByCampusId.mockResolvedValue({
      campusId: 1,
      schoolId: 33,
      schoolName: "測試大學",
      branchName: "主校區",
      buildingCount: 1,
      facilityCount: 0,
      facilities: [],
      facTypeSummary: [],
    });
    const raw = await executeLocalTool(
      "getCampusAccessibilityDetails",
      { campusId: 1 },
      undefined,
    );
    expect(JSON.parse(raw).ok).toBe(true);
  });

  it.each([
    [undefined, "en", "en"],
    [undefined, "zh-TW", "zh-TW"],
    ["zh-TW", "en", "zh-TW"],
    ["en", "zh-TW", "en"],
    [undefined, undefined, undefined],
  ] as const)(
    "defaults navigation language %s to session %s",
    async (language, sessionLanguage, expected) => {
      mockGenNav.mockResolvedValue({
        ok: true,
        data: { instructions: [], totalSteps: 0, warnings: [] },
      });
      await executeLocalTool(
        "getNavInstructions",
        { language },
        undefined,
        undefined,
        { routeToken: "trusted", language: sessionLanguage },
      );
      expect(mockGenNav).toHaveBeenCalledWith({
        routeToken: "trusted",
        userHeading: undefined,
        language: expected,
      });
    },
  );

  it.each(["ja", null, 7])(
    "rejects an invalid explicit navigation language %s instead of falling back",
    async (language) => {
      const output = await executeLocalTool(
        "getNavInstructions",
        { language },
        undefined,
        undefined,
        { routeToken: "trusted", language: "en" },
      );
      expect(JSON.parse(output)).toMatchObject({
        ok: false,
        reason: "INVALID_ROUTE_ARGUMENTS",
      });
      expect(mockGenNav).not.toHaveBeenCalled();
    },
  );

  it("getNavInstructions only trusts executor context, ignoring model tokens and legacy planning args", async () => {
    mockGenNav.mockResolvedValue({
      ok: true,
      data: { instructions: [], totalSteps: 0, warnings: [] },
    });
    const raw = await executeLocalTool(
      "getNavInstructions",
      { routeToken: "invented", origin: "A", destination: "B", routeIndex: 9 },
      undefined,
      undefined,
      { routeToken: "trusted" },
    );
    expect(JSON.parse(raw).ok).toBe(true);
    expect(mockGenNav).toHaveBeenCalledWith(
      expect.objectContaining({ routeToken: "trusted" }),
    );
    expect(mockPlanRoute).not.toHaveBeenCalled();
  });

  it("planRouteToSosVictim 走到正確函式", async () => {
    mockEmergencyContactFindOne.mockReturnValue({
      sort: () => ({
        select: () => ({
          lean: () =>
            Promise.resolve({
              lastLineLat: 25.03,
              lastLineLng: 121.56,
              lastLineLocationUpdatedAt: new Date("2026-07-09T01:10:00.000Z"),
            }),
        }),
      }),
    });
    mockEmergencyContactFind.mockReturnValue({
      select: () => ({
        lean: () =>
          Promise.resolve([{ _id: "c1", userId: "u1", name: "王小明" }]),
      }),
    });
    mockSosSessionFindById.mockReturnValue({
      lean: () =>
        Promise.resolve({
          _id: "s1",
          userId: "u1",
          type: "body",
          status: "active",
          address: "台北車站",
          lat: 25.0478,
          lng: 121.5171,
          locationUpdatedAt: new Date("2026-07-09T01:00:00.000Z"),
          shareToken: "token123",
        }),
    });
    mockUserFindById.mockReturnValue({
      select: () => ({
        lean: () => Promise.resolve({ name: "王小明" }),
      }),
    });
    mockPlanRoute.mockResolvedValue({
      ok: true,
      data: {
        origin: { lat: 25.03, lng: 121.56 },
        destination: { lat: 25.0478, lng: 121.5171 },
        city: "Taipei",
        routes: [
          { routeName: "route1", totalMinutes: 12, legs: [{ type: "WALK" }] },
        ],
      },
    });

    const raw = await executeLocalTool(
      "planRouteToSosVictim",
      { sessionId: "s1" },
      undefined,
      undefined,
      { lineUserId: "line-1" },
    );
    expect(JSON.parse(raw).ok).toBe(true);
  });

  it("未知工具回錯誤", async () => {
    const raw = await executeLocalTool("noSuchTool", {}, undefined);
    expect(JSON.parse(raw).error).toContain("未知工具");
  });

  it("saveMemory 走到正確函式", async () => {
    const mockSave = memoryServiceMod.saveMemory as unknown as ReturnType<
      typeof vi.fn
    >;
    mockSave.mockResolvedValue({
      _id: "m1",
      content: "坐輪椅",
      category: "preference",
    });
    const raw = await executeLocalTool(
      "saveMemory",
      { content: "坐輪椅", category: "preference" },
      undefined,
      "user123",
      { allowMemoryWrite: true },
    );
    expect(JSON.parse(raw).ok).toBe(true);
    expect(JSON.parse(raw).memory.content).toBe("坐輪椅");
  });

  it("deleteMemory 走到正確函式", async () => {
    const mockDel = memoryServiceMod.deleteMemory as unknown as ReturnType<
      typeof vi.fn
    >;
    mockDel.mockResolvedValue(true);
    const raw = await executeLocalTool(
      "deleteMemory",
      { memoryId: "m1" },
      undefined,
      "user123",
    );
    expect(JSON.parse(raw).ok).toBe(true);
  });

  it("webSearch 走到正確函式", async () => {
    mockGenerateContent.mockResolvedValue({
      text: "搜尋摘要",
      candidates: [{ groundingMetadata: { groundingChunks: [] } }],
    });
    const raw = await executeLocalTool(
      "webSearch",
      { query: "最新無障礙政策" },
      undefined,
    );
    expect(JSON.parse(raw).ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// saveMemory / deleteMemory (agent tool functions)
// ---------------------------------------------------------------------------
describe("saveMemory agent tool", () => {
  const mockSave = memoryServiceMod.saveMemory as unknown as ReturnType<
    typeof vi.fn
  >;

  it("有 userId + 有效 category 成功儲存", async () => {
    mockSave.mockResolvedValue({
      _id: "m1",
      content: "家住板橋",
      category: "place",
    });
    const raw = await saveMemory({
      content: "家住板橋",
      category: "place",
      userId: "u1",
      allowMemoryWrite: true,
    });
    const result = JSON.parse(raw);
    expect(result.ok).toBe(true);
    expect(result.memory.content).toBe("家住板橋");
  });

  it("明確要求記住時以 explicit_user 來源儲存", async () => {
    mockSave.mockResolvedValue({
      _id: "m1",
      content: "學校是台大",
      category: "place",
    });
    await saveMemory({
      content: "學校是台大",
      category: "place",
      userId: "u1",
      allowMemoryWrite: true,
      explicitMemoryRequest: true,
    });
    expect(mockSave).toHaveBeenCalledWith(
      "u1",
      "學校是台大",
      "place",
      expect.objectContaining({ source: "explicit_user" }),
    );
  });

  it("無 userId 回錯誤", async () => {
    const raw = await saveMemory({ content: "test", category: "place" });
    const result = JSON.parse(raw);
    expect(result.ok).toBe(false);
    expect(result.error).toContain("登入");
  });

  it("空 content 回錯誤", async () => {
    const raw = await saveMemory({
      content: "",
      category: "place",
      userId: "u1",
      allowMemoryWrite: true,
    });
    expect(JSON.parse(raw).ok).toBe(false);
  });

  it("無效 category 回錯誤", async () => {
    const raw = await saveMemory({
      content: "test",
      category: "invalid",
      userId: "u1",
      allowMemoryWrite: true,
    });
    expect(JSON.parse(raw).ok).toBe(false);
    expect(JSON.parse(raw).error).toContain("無效");
  });

  it("未允許記憶寫入時回錯誤", async () => {
    const raw = await saveMemory({
      content: "家住板橋",
      category: "place",
      userId: "u1",
    });
    expect(JSON.parse(raw).ok).toBe(false);
    expect(JSON.parse(raw).error).toContain("尚未開啟");
  });
});

describe("deleteMemory agent tool", () => {
  const mockDel = memoryServiceMod.deleteMemory as unknown as ReturnType<
    typeof vi.fn
  >;

  it("有 userId 成功刪除", async () => {
    mockDel.mockResolvedValue(true);
    const raw = await deleteMemory({ memoryId: "m1", userId: "u1" });
    expect(JSON.parse(raw).ok).toBe(true);
  });

  it("找不到回錯誤", async () => {
    mockDel.mockResolvedValue(false);
    const raw = await deleteMemory({ memoryId: "m1", userId: "u1" });
    expect(JSON.parse(raw).ok).toBe(false);
  });

  it("無 userId 回錯誤", async () => {
    const raw = await deleteMemory({ memoryId: "m1" });
    expect(JSON.parse(raw).ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// searchAccessibilityGuide
// ---------------------------------------------------------------------------
describe("searchAccessibilityGuide", () => {
  const mockSearch = searchKnowledge as unknown as ReturnType<typeof vi.fn>;

  it("有結果時回傳 content + source", async () => {
    mockSearch.mockResolvedValue([
      {
        content: "輪椅搭公車步驟…",
        source: "台北市公共運輸處",
        category: "transit_tips",
        title: "輪椅搭公車 SOP",
        score: 0.92,
      },
    ]);
    const raw = await searchAccessibilityGuide({ query: "輪椅怎麼搭公車" });
    const result = JSON.parse(raw);
    expect(result.ok).toBe(true);
    expect(result.results).toHaveLength(1);
    expect(result.results[0].title).toBe("輪椅搭公車 SOP");
  });

  it("無結果時回空陣列", async () => {
    mockSearch.mockResolvedValue([]);
    const raw = await searchAccessibilityGuide({ query: "火星交通" });
    const result = JSON.parse(raw);
    expect(result.ok).toBe(true);
    expect(result.results).toEqual([]);
  });

  it("空 query 回錯誤", async () => {
    const raw = await searchAccessibilityGuide({ query: "" });
    expect(JSON.parse(raw).ok).toBe(false);
  });

  it("service 拋錯回 fallback", async () => {
    mockSearch.mockRejectedValue(new Error("chroma down"));
    const raw = await searchAccessibilityGuide({ query: "test" });
    const result = JSON.parse(raw);
    expect(result.ok).toBe(false);
    expect(result.error).toBe("知識庫查詢失敗");
  });

  it("executeLocalTool dispatch 正確", async () => {
    mockSearch.mockResolvedValue([]);
    const raw = await executeLocalTool(
      "searchAccessibilityGuide",
      { query: "test" },
      undefined,
    );
    expect(JSON.parse(raw).ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// webSearch
// ---------------------------------------------------------------------------
describe("webSearch", () => {
  it("使用 Gemini Google Search 並整理來源", async () => {
    mockGenerateContent.mockResolvedValue({
      text: "台北市近期更新了無障礙交通資訊。",
      candidates: [
        {
          groundingMetadata: {
            webSearchQueries: ["台北市 無障礙交通 最新"],
            groundingChunks: [
              {
                web: {
                  uri: "https://example.gov.tw/news",
                  title: "官方新聞",
                  domain: "example.gov.tw",
                },
              },
              {
                web: {
                  uri: "https://example.gov.tw/news",
                  title: "重複來源",
                  domain: "example.gov.tw",
                },
              },
            ],
          },
        },
      ],
    });

    const raw = await webSearch({ query: "台北市無障礙交通最新政策" });
    const result = JSON.parse(raw);

    expect(result.ok).toBe(true);
    expect(result.answer).toContain("台北市");
    expect(result.webSearchQueries).toEqual(["台北市 無障礙交通 最新"]);
    expect(result.sources).toEqual([
      {
        title: "官方新聞",
        url: "https://example.gov.tw/news",
        domain: "example.gov.tw",
      },
    ]);
    expect(mockGenerateContent).toHaveBeenCalledWith(
      expect.objectContaining({
        model: "test-model",
        contents: "台北市無障礙交通最新政策",
        config: expect.objectContaining({
          tools: [{ googleSearch: {} }],
        }),
      }),
    );
  });

  it("空 query 回錯誤", async () => {
    const raw = await webSearch({ query: "   " });
    expect(JSON.parse(raw).ok).toBe(false);
    expect(mockGenerateContent).not.toHaveBeenCalled();
  });

  it("Gemini 搜尋失敗時回 fallback", async () => {
    mockGenerateContent.mockRejectedValue(new Error("quota"));
    const raw = await webSearch({ query: "最新消息" });
    const result = JSON.parse(raw);
    expect(result.ok).toBe(false);
    expect(result.error).toBe("網路搜尋失敗");
  });
});

describe("bindEmergencyContactCode agent tool", () => {
  it("成功綁定緊急聯絡人，並將 bindCode 與時效改為 undefined", async () => {
    const mockSave = vi.fn().mockResolvedValue({});
    const mockContact = {
      _id: "c1",
      name: "媽媽",
      bindStatus: "pending",
      lineUserId: null,
      bindCode: "K7X2QD",
      bindCodeExpiresAt: new Date(Date.now() + 10000),
      save: mockSave,
    };
    mockEmergencyContactFindOne.mockResolvedValue(mockContact);

    const raw = await bindEmergencyContactCode({ code: "K7X2QD" }, "U1");
    const result = JSON.parse(raw);

    expect(result.ok).toBe(true);
    expect(result.bound).toBe(true);
    expect(result.contactName).toBe("媽媽");
    expect(mockContact.bindStatus).toBe("bound");
    expect(mockContact.lineUserId).toBe("U1");
    expect(mockContact.bindCode).toBeUndefined();
    expect(mockContact.bindCodeExpiresAt).toBeUndefined();
    expect(mockSave).toHaveBeenCalled();
  });

  it("缺少 LINE 使用者資訊時回傳錯誤", async () => {
    const raw = await bindEmergencyContactCode({ code: "K7X2QD" }, undefined);
    const result = JSON.parse(raw);
    expect(result.ok).toBe(false);
    expect(result.error).toContain("缺少 LINE 使用者資訊");
  });

  it("綁定碼格式錯誤時回傳錯誤", async () => {
    const raw = await bindEmergencyContactCode({ code: "SHORT" }, "U1");
    const result = JSON.parse(raw);
    expect(result.ok).toBe(false);
    expect(result.error).toContain("綁定碼格式錯誤");
  });

  it("找不到可用綁定碼或已過期時回傳錯誤", async () => {
    mockEmergencyContactFindOne.mockResolvedValue(null);
    const raw = await bindEmergencyContactCode({ code: "ABCDEF" }, "U1");
    const result = JSON.parse(raw);
    expect(result.ok).toBe(false);
    expect(result.error).toContain("找不到可用的緊急聯絡人綁定碼");
  });
});

describe("bindLineAccountCode agent tool", () => {
  it("成功綁定 LINE 帳號並刪除對應的 LinkCode", async () => {
    mockLineLinkFindOne.mockResolvedValue({
      _id: "link1",
      userId: "u1",
      code: "K7X2QD",
      expiresAt: new Date(Date.now() + 10000),
    });
    mockUserFindOne.mockReturnValue({
      select: () => ({
        lean: () => Promise.resolve(null),
      }),
    });
    mockUserFindById.mockReturnValue({
      select: () => ({
        lean: () =>
          Promise.resolve({ _id: "u1", name: "王小明", lineUserId: null }),
      }),
    });

    const raw = await bindLineAccountCode({ code: "K7X2QD" }, "U1");
    const result = JSON.parse(raw);

    expect(result.ok).toBe(true);
    expect(mockUserUpdateOne).toHaveBeenCalledWith(
      { _id: "u1" },
      { $set: { lineUserId: "U1" } },
    );
    expect(mockLineLinkDeleteOne).toHaveBeenCalledWith({ _id: "link1" });
  });

  it("找不到可用帳號綁定碼時回傳錯誤", async () => {
    mockLineLinkFindOne.mockResolvedValue(null);
    const raw = await bindLineAccountCode({ code: "ABCDEF" }, "U1");
    const result = JSON.parse(raw);
    expect(result.ok).toBe(false);
    expect(result.error).toContain("找不到可用的 LINE 帳號綁定碼");
  });
});

describe("agent transit preference declarations", () => {
  it.each(["planAccessibleRoute"])(
    "%s declares the metro preference enum",
    async (name) => {
      const { openAiChatTools } = await import("../../config/ai/tool");
      const tool = openAiChatTools.find(
        (t) => t.type === "function" && t.function.name === name,
      );
      const props = (tool as any).function.parameters.properties;
      expect(props.transitPreference.enum).toEqual([
        "none",
        "bus",
        "rail",
        "metro",
      ]);
    },
  );
});

describe("agent route administrative city", () => {
  it("preserves explicit null city without failing or inventing an administrative area", async () => {
    mockPlanRoute.mockResolvedValue({
      ok: true,
      data: {
        origin: { lat: 25.04, lng: 121.56 },
        destination: { lat: 25.03, lng: 121.55 },
        city: null,
        routes: [{ routeId: "r1", legs: [] }],
        _canonicalRequest: {
          mode: "normal",
          travelMode: "transit",
          transitPreference: "none",
          maxTransfers: 2,
          avoidStairs: false,
          requireElevator: false,
        },
      },
    });

    const result = JSON.parse(
      await executeLocalTool("planAccessibleRoute", {
        origin: "起點",
        destination: "終點",
      }),
    );

    expect(result).toMatchObject({
      ok: true,
      city: null,
      selectedRouteId: "r1",
    });
    expect(result).toHaveProperty("city");
  });
});

describe("agent transit preference dispatch", () => {
  it.each(["planAccessibleRoute"])(
    "forwards preferences through %s",
    async (tool) => {
      mockPlanRoute.mockResolvedValue({
        ok: false,
        error: "no route in fixture",
      });
      for (const transitPreference of ["bus", "rail", "metro", "none"]) {
        await executeLocalTool(
          tool,
          {
            origin: "台北車站",
            destination: "板橋車站",
            mode: "wheelchair",
            transitPreference,
          },
          undefined,
        );
        expect(mockPlanRoute).toHaveBeenLastCalledWith(
          expect.objectContaining({ transitPreference, mode: "wheelchair" }),
        );
      }
    },
  );
  it.each(["planAccessibleRoute"])(
    "rejects unsupported model output in %s before planning",
    async (tool) => {
      mockPlanRoute.mockClear();
      const result = JSON.parse(
        await executeLocalTool(
          tool,
          { origin: "A", destination: "B", transitPreference: "subway" },
          undefined,
        ),
      );
      expect(result.ok).toBe(false);
      expect(mockPlanRoute).not.toHaveBeenCalled();
    },
  );
});

describe("AI plan full route contract", () => {
  it("plans once, preserves geometry and candidate order, and exposes only public canonical preferences", async () => {
    const routes = ["bus", "rail"].map((id, i) => ({
      routeId: id,
      routeName: id,
      legs: [
        {
          type: i ? "TRA" : "BUS",
          polyline: [
            [120, 24],
            [120.1, 24.1],
          ],
          routeName: "99",
          steps: [{ instruction: "保留指引" }],
        },
      ],
    }));
    const canonical = {
      mode: "wheelchair",
      travelMode: "transit",
      transitPreference: "bus",
      maxTransfers: 2,
      avoidStairs: true,
      requireElevator: true,
      departureTime: "2026-10-10T08:00:00+08:00",
      userId: "private-user",
    };
    const data = {
      origin: { lat: 24, lng: 120 },
      destination: { lat: 24.1, lng: 120.1 },
      city: null,
      routes,
    };
    Object.defineProperty(data, "_canonicalRequest", {
      value: canonical,
      enumerable: false,
    });
    mockPlanRoute.mockResolvedValue({ ok: true, data });
    const result = JSON.parse(
      await executeLocalTool(
        "planAccessibleRoute",
        { origin: "current_location", destination: "台中火車站" },
        { latitude: 24, longitude: 120 },
        "private-user",
      ),
    );
    expect(mockPlanRoute).toHaveBeenCalledTimes(1);
    expect(mockPlanRoute).toHaveBeenCalledWith(
      expect.objectContaining({ userId: "private-user", mode: undefined }),
    );
    expect(attachRouteTokens).toHaveBeenCalledWith(routes, canonical);
    expect(result).toMatchObject({
      routeContractVersion: 1,
      selectedRouteId: "bus",
      planId: expect.any(String),
      effectivePreferences: {
        mode: "wheelchair",
        transitPreference: "bus",
        departureTime: canonical.departureTime,
      },
    });
    expect(result.routes.map((r: any) => r.routeId)).toEqual(["bus", "rail"]);
    expect(result.routes[0]).toMatchObject({
      ...routes[0],
      routeToken: "token-bus",
    });
    expect(JSON.stringify(result)).not.toMatch(
      /private-user|_canonicalRequest/,
    );
  });
  it("returns no successful selection for an empty plan", async () => {
    mockPlanRoute.mockResolvedValue({ ok: true, data: { routes: [] } });
    const result = JSON.parse(
      await executeLocalTool("planAccessibleRoute", {
        origin: "A",
        destination: "B",
      }),
    );
    expect(result.ok).toBe(false);
    expect(result.selectedRouteId).toBeUndefined();
  });
  it("keeps full geometry when token storage is unavailable", async () => {
    const routes = [
      {
        routeId: "bus",
        legs: [
          {
            type: "BUS",
            polyline: [
              [120, 24],
              [120.1, 24.1],
            ],
          },
        ],
      },
    ];
    vi.mocked(attachRouteTokens).mockResolvedValueOnce(routes as never);
    mockPlanRoute.mockResolvedValue({
      ok: true,
      data: {
        routes,
        _canonicalRequest: { mode: "normal", transitPreference: "bus" },
      },
    });
    const result = JSON.parse(
      await executeLocalTool("planAccessibleRoute", {
        origin: "A",
        destination: "B",
      }),
    );
    expect(result).toMatchObject({ ok: true, selectedRouteId: "bus", routes });
    expect(result.routes[0].routeToken).toBeUndefined();
  });
});
