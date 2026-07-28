import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock tdxFetch to prevent real network calls during transit route enrichment
vi.mock("../../config/fetch", () => ({
  tdxFetch: vi.fn().mockResolvedValue({ ok: true, json: async () => [] }),
}));

vi.mock("../environment/environment.service", () => ({
  getWeatherAndAirQuality: vi.fn().mockResolvedValue({}),
}));

// Mock the driving planner (dynamic-imported by the service) — override only
// planValhallaRoute; keep ValhallaRoutingError so `instanceof` checks stay valid.
vi.mock("./planners/valhalla-routing", () => ({
  planValhallaRoute: vi.fn(),
  ValhallaRoutingError: class ValhallaRoutingError extends Error {},
}));

// Spread-actual: only override the a11y hooks the driving path calls.
vi.mock("../a11y/a11y.service", async (importActual) => {
  const actual = await importActual<typeof import("../a11y/a11y.service")>();
  return { ...actual, findNearbyParking: vi.fn(), findNearby: vi.fn() };
});

// Mock route-a11y to isolate Mongo DB calls during transit route enrichment
vi.mock("./planners/route-a11y", () => ({
  nearbyA11y: vi.fn().mockResolvedValue([]),
  attachA11yToLeg: vi.fn(),
  deriveHighlights: vi.fn(),
  enrichLegIndoor: vi.fn(),
  buildAccessibilitySummary: vi.fn().mockReturnValue(""),
}));

// The transit branch dynamic-imports both from the OTP planner.
vi.mock("./planners/otp-routing", () => ({
  planOtpRoute: vi.fn().mockResolvedValue([]),
  planOtpWalk: vi.fn(),
  isOtpCircuitOpen: () => false,
}));

// DB isolation: resolveCityFromStops does findOne().select().lean().
vi.mock("../../model/bus-stop.model", () => ({
  default: {
    findOne: () => ({
      select: () => ({ lean: () => Promise.resolve({ city: "Taipei" }) }),
    }),
  },
}));

// Spread-actual google adapter; getCity is a fallback (city resolves via stops).
vi.mock("../../adapters/google.adapter", async (importActual) => {
  const actual =
    await importActual<typeof import("../../adapters/google.adapter")>();
  return { ...actual, getCity: vi.fn(), getCoordinates: vi.fn() };
});

import { planAccessibleRouteFromRequest } from "./accessible-route.service";
import { planValhallaRoute, ValhallaRoutingError } from "./planners/valhalla-routing";
import { findNearbyParking, findNearby } from "../a11y/a11y.service";
import { planOtpRoute, planOtpWalk } from "./planners/otp-routing";
import { getCity } from "../../adapters/google.adapter";
import { ResponseCode } from "../../types/code";
import { getWeatherAndAirQuality } from "../environment/environment.service";

const driveRequest = {
  travelMode: "drive" as const,
  origin: { latitude: 25.04, longitude: 121.56 },
  destination: { latitude: 25.03, longitude: 121.55 },
};

// Well-formed parking doc: the caller reads location.coordinates + placeName.
const parkingFixture = [
  {
    placeName: "身障停車格A",
    latitude: 25.031,
    longitude: 121.551,
    location: { type: "Point", coordinates: [121.551, 25.031] },
  },
];

const driveRoute = (highlights: string[]) => ({
  routeId: "drive-0",
  routeName: "開車",
  totalMinutes: 20,
  transferCount: 0,
  totalWalkDistanceM: 150,
  legs: [],
  accessibilityHighlights: highlights,
});

const hasParkingGuide = (hl: string[]) =>
  hl.some((h) => h.includes("已為您導引至最近身障停車格"));

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(getCity).mockResolvedValue("Taipei");
  vi.mocked(findNearby).mockResolvedValue({ nearbyOsm: [] } as any);
  vi.mocked(planOtpRoute).mockResolvedValue([]);
  vi.mocked(planOtpWalk).mockResolvedValue([]);
  vi.mocked(getWeatherAndAirQuality).mockResolvedValue({});
});

describe("planAccessibleRouteFromRequest driving a11y highlights append", () => {
  it("appends the parking highlight without overwriting the walk hint", async () => {
    const walkHint = "起點需步行約 150 公尺至可上車路段";
    vi.mocked(planValhallaRoute).mockResolvedValue([driveRoute([walkHint])] as any);
    vi.mocked(findNearbyParking).mockResolvedValue(parkingFixture as any);

    const res = await planAccessibleRouteFromRequest(driveRequest);

    expect(res.ok).toBe(true);
    expect(res.data!.travelMode).toBe("drive");
    const highlights = res.data!.routes[0].accessibilityHighlights;
    expect(highlights).toContain(walkHint);
    expect(highlights.some((h) => h.includes("身障停車格"))).toBe(true);
  });

  it("keeps a walk-failure warning alongside the appended parking highlight", async () => {
    const warning =
      "起點距可行車路段約 120 公尺，但無法建立可信步行路徑，請留意";
    vi.mocked(planValhallaRoute).mockResolvedValue([driveRoute([warning])] as any);
    vi.mocked(findNearbyParking).mockResolvedValue(parkingFixture as any);

    const res = await planAccessibleRouteFromRequest(driveRequest);

    expect(res.ok).toBe(true);
    const highlights = res.data!.routes[0].accessibilityHighlights;
    expect(highlights).toContain(warning);
    expect(highlights.some((h) => h.includes("身障停車格"))).toBe(true);
  });
});


describe("planAccessibleRouteFromRequest parking-aware arrival", () => {
  it("routes to the parking anchor with the true dest as finalWalkTarget (drive)", async () => {
    vi.mocked(findNearbyParking).mockResolvedValue(parkingFixture as any);
    vi.mocked(planValhallaRoute).mockResolvedValue([driveRoute([])] as any);

    const res = await planAccessibleRouteFromRequest(driveRequest);

    const [, dest, opts] = vi.mocked(planValhallaRoute).mock.calls[0];
    expect(dest.lat).toBeCloseTo(25.031);
    expect(dest.lng).toBeCloseTo(121.551);
    expect(opts.finalWalkTarget!.lat).toBeCloseTo(25.03);
    expect(opts.finalWalkTarget!.lng).toBeCloseTo(121.55);

    expect(res.ok).toBe(true);
    expect(hasParkingGuide(res.data!.routes[0].accessibilityHighlights)).toBe(true);
    expect(res.data!.destination).toEqual({ lat: 25.03, lng: 121.55 });
  });

  it("applies the same treatment to motorcycle", async () => {
    vi.mocked(findNearbyParking).mockResolvedValue(parkingFixture as any);
    vi.mocked(planValhallaRoute).mockResolvedValue([driveRoute([])] as any);

    const res = await planAccessibleRouteFromRequest({
      ...driveRequest,
      travelMode: "motorcycle",
    });

    const [, dest, opts] = vi.mocked(planValhallaRoute).mock.calls[0];
    expect(dest.lat).toBeCloseTo(25.031);
    expect(dest.lng).toBeCloseTo(121.551);
    expect(opts.finalWalkTarget!.lat).toBeCloseTo(25.03);
    expect(opts.finalWalkTarget!.lng).toBeCloseTo(121.55);
    expect(res.ok).toBe(true);
    expect(hasParkingGuide(res.data!.routes[0].accessibilityHighlights)).toBe(true);
  });

  it("routes straight to the true destination when no parking is found", async () => {
    vi.mocked(findNearbyParking).mockResolvedValue([] as any);
    vi.mocked(planValhallaRoute).mockResolvedValue([driveRoute([])] as any);

    const res = await planAccessibleRouteFromRequest(driveRequest);

    const [, dest, opts] = vi.mocked(planValhallaRoute).mock.calls[0];
    expect(dest.lat).toBeCloseTo(25.03);
    expect(dest.lng).toBeCloseTo(121.55);
    expect(opts.finalWalkTarget).toBeUndefined();
    expect(res.ok).toBe(true);
    expect(hasParkingGuide(res.data!.routes[0].accessibilityHighlights)).toBe(false);
  });

  it("falls back to the true destination when the parking lookup rejects", async () => {
    vi.mocked(findNearbyParking).mockRejectedValue(new Error("mongo down"));
    vi.mocked(planValhallaRoute).mockResolvedValue([driveRoute([])] as any);

    const res = await planAccessibleRouteFromRequest(driveRequest);

    const [, dest, opts] = vi.mocked(planValhallaRoute).mock.calls[0];
    expect(dest.lat).toBeCloseTo(25.03);
    expect(dest.lng).toBeCloseTo(121.55);
    expect(opts.finalWalkTarget).toBeUndefined();
    expect(res.ok).toBe(true);
    expect(hasParkingGuide(res.data!.routes[0].accessibilityHighlights)).toBe(false);
  });

  it("retries against the true destination when the parking bay is unreachable", async () => {
    vi.mocked(findNearbyParking).mockResolvedValue(parkingFixture as any);
    vi.mocked(planValhallaRoute)
      .mockResolvedValueOnce([] as any)
      .mockResolvedValueOnce([driveRoute([])] as any);

    const res = await planAccessibleRouteFromRequest(driveRequest);

    const calls = vi.mocked(planValhallaRoute).mock.calls;
    expect(calls).toHaveLength(2);
    expect(calls[1][1].lat).toBeCloseTo(25.03);
    expect(calls[1][1].lng).toBeCloseTo(121.55);
    expect(calls[1][2].finalWalkTarget).toBeUndefined();
    expect(res.ok).toBe(true);
    expect(hasParkingGuide(res.data!.routes[0].accessibilityHighlights)).toBe(false);
  });

  it("returns NOT_FOUND when both the parking bay and the true dest are unreachable", async () => {
    vi.mocked(findNearbyParking).mockResolvedValue(parkingFixture as any);
    vi.mocked(planValhallaRoute).mockResolvedValue([] as any);

    const res = await planAccessibleRouteFromRequest(driveRequest);

    expect(res.ok).toBe(false);
    expect(res.status).toBe(ResponseCode.NOT_FOUND);
  });

  it("does NOT retry (and stays 503) when the first plan is upstream-unavailable", async () => {
    vi.mocked(findNearbyParking).mockResolvedValue(parkingFixture as any);
    vi.mocked(planValhallaRoute).mockRejectedValue(new ValhallaRoutingError("upstream"));

    const res = await planAccessibleRouteFromRequest(driveRequest);

    expect(vi.mocked(planValhallaRoute).mock.calls).toHaveLength(1);
    expect(res.ok).toBe(false);
    expect(res.status).toBe(ResponseCode.SERVICE_UNAVAILABLE);
  });

  it("does NOT retry (and stays 500) when the first plan errors", async () => {
    vi.mocked(findNearbyParking).mockResolvedValue(parkingFixture as any);
    vi.mocked(planValhallaRoute).mockRejectedValue(new Error("boom"));

    const res = await planAccessibleRouteFromRequest(driveRequest);

    expect(vi.mocked(planValhallaRoute).mock.calls).toHaveLength(1);
    expect(res.ok).toBe(false);
    expect(res.status).toBe(ResponseCode.INTERNAL_ERROR);
  });

  it("does not run the parking lookup for transit", async () => {
    const res = await planAccessibleRouteFromRequest({
      ...driveRequest,
      travelMode: "transit",
    });

    expect(findNearbyParking).not.toHaveBeenCalled();
    expect(res.ok).toBe(false);
  });

  it("does not run the parking arrival lookup for walk mode", async () => {
    vi.mocked(planValhallaRoute).mockResolvedValue([driveRoute([])] as any);

    const res = await planAccessibleRouteFromRequest({
      ...driveRequest,
      travelMode: "walk",
    });

    expect(findNearbyParking).not.toHaveBeenCalled();
    expect(res.ok).toBe(true);
  });
});

const walkRequest = {
  travelMode: "walk" as const,
  origin: { latitude: 25.04, longitude: 121.56 },
  destination: { latitude: 25.03, longitude: 121.55 },
};

const walkRoute = () => ({
  routeId: "walk-0",
  routeName: "步行",
  totalMinutes: 10,
  transferCount: 0,
  totalWalkDistanceM: 800,
  legs: [
    {
      type: "WALK",
      from: "出發地",
      to: "目的地",
      distanceM: 800,
      minutesEst: 10,
      polyline: [
        [121.56, 25.04],
        [121.55, 25.03],
      ],
      a11yFacilities: [],
    },
  ],
  accessibilityHighlights: [],
});

describe("planAccessibleRouteFromRequest walk mode OTP", () => {
  it("uses the OTP walk route and does not call Valhalla", async () => {
    vi.mocked(planOtpWalk).mockResolvedValue([walkRoute()] as any);

    const res = await planAccessibleRouteFromRequest(walkRequest);

    expect(res.ok).toBe(true);
    expect(res.data!.routes[0].routeName).toBe("步行");
    expect(vi.mocked(planValhallaRoute).mock.calls).toHaveLength(0);
  });

  it("runs finalize enrichment on the OTP walk route", async () => {
    vi.mocked(planOtpWalk).mockResolvedValue([walkRoute()] as any);
    vi.mocked(findNearby).mockResolvedValue({
      nearbyOsm: [{ category: "elevator" }],
    } as any);

    const res = await planAccessibleRouteFromRequest(walkRequest);

    expect(res.ok).toBe(true);
    const highlights = res.data!.routes[0].accessibilityHighlights;
    expect(highlights.some((h) => h.includes("電梯"))).toBe(true);
  });

  it("falls back to Valhalla when OTP returns no walk route", async () => {
    vi.mocked(planOtpWalk).mockResolvedValue([]);
    vi.mocked(planValhallaRoute).mockResolvedValue([driveRoute([])] as any);

    const res = await planAccessibleRouteFromRequest(walkRequest);

    expect(res.ok).toBe(true);
    expect(vi.mocked(planValhallaRoute).mock.calls.length).toBeGreaterThan(0);
  });

  it("falls back to Valhalla when OTP rejects", async () => {
    vi.mocked(planOtpWalk).mockRejectedValue(new Error("otp down"));
    vi.mocked(planValhallaRoute).mockResolvedValue([driveRoute([])] as any);

    const res = await planAccessibleRouteFromRequest(walkRequest);

    expect(res.ok).toBe(true);
    expect(vi.mocked(planValhallaRoute).mock.calls.length).toBeGreaterThan(0);
  });

  it("does not call OTP walk for walk + waypoints", async () => {
    vi.mocked(planValhallaRoute).mockResolvedValue([driveRoute([])] as any);

    const res = await planAccessibleRouteFromRequest({
      ...walkRequest,
      waypoints: [{ latitude: 25.035, longitude: 121.555 }],
    });

    expect(res.ok).toBe(true);
    expect(vi.mocked(planOtpWalk).mock.calls).toHaveLength(0);
    expect(vi.mocked(planValhallaRoute).mock.calls.length).toBeGreaterThan(0);
  });

  it("does not call OTP walk for drive mode", async () => {
    vi.mocked(planValhallaRoute).mockResolvedValue([driveRoute([])] as any);
    vi.mocked(findNearbyParking).mockResolvedValue([] as any);

    const res = await planAccessibleRouteFromRequest(driveRequest);

    expect(res.ok).toBe(true);
    expect(vi.mocked(planOtpWalk).mock.calls).toHaveLength(0);
  });
});

describe("planAccessibleRouteFromRequest — 台北市公車與大眾運輸路徑規劃 (Taipei Transit Route Planning)", () => {
  const nccuOrigin = { latitude: 24.9868, longitude: 121.5762 }; // 政大
  const mainStationDest = { latitude: 25.0478, longitude: 121.517 }; // 台北車站
  const cckMemMem = { latitude: 25.0347, longitude: 121.5217 }; // 中正紀念堂

  const rooseveltBusRoute = {
    routeId: "otp-roosevelt-0",
    routeName: "羅斯福路幹線",
    totalMinutes: 28,
    transferCount: 0,
    totalWalkDistanceM: 400,
    legs: [
      {
        type: "WALK",
        from: "國立政治大學",
        to: "政大公車站",
        distanceM: 150,
        minutesEst: 3,
        polyline: [[121.5762, 24.9868], [121.5760, 24.9865]],
        a11yFacilities: [],
      },
      {
        type: "BUS",
        routeName: "羅斯福路幹線",
        departureStop: "政大",
        arrivalStop: "台北車站(忠孝)",
        cityCode: "Taipei",
        waitInfo: { time: 180, source: "realtime" },
        estimatedWaitMinutes: 3,
        direction: 0,
        polyline: [[121.5760, 24.9865], [121.5170, 25.0478]],
        departureStopA11y: [],
        arrivalStopA11y: [],
        tdxCity: "Taipei",
      },
      {
        type: "WALK",
        from: "台北車站(忠孝)",
        to: "台北車站捷運站出口",
        distanceM: 250,
        minutesEst: 4,
        polyline: [[121.5170, 25.0478], [121.5175, 25.0480]],
        a11yFacilities: [],
      },
    ],
    accessibilityHighlights: ["低底盤公車直達"],
  };

  it("測試 Case A: 政大 ➔ 台北車站 (輪椅模式公車路徑規劃)", async () => {
    vi.mocked(planOtpRoute).mockResolvedValue([rooseveltBusRoute] as any);

    const req = {
      travelMode: "transit" as const,
      origin: nccuOrigin,
      destination: mainStationDest,
      mode: "wheelchair" as const,
    };

    const res = await planAccessibleRouteFromRequest(req);

    expect(res.ok).toBe(true);
    if (!res.ok) return;

    expect(res.data.travelMode).toBe("transit");
    expect(res.data.routes).toHaveLength(1);
    const primaryRoute = res.data.routes[0];
    expect(primaryRoute.routeName).toBe("羅斯福路幹線");
    expect(primaryRoute.transferCount).toBe(0);
    expect(primaryRoute.legs.some((l) => l.type === "BUS")).toBe(true);

    expect(vi.mocked(planOtpRoute)).toHaveBeenCalledWith(
      { lat: nccuOrigin.latitude, lng: nccuOrigin.longitude },
      { lat: mainStationDest.latitude, lng: mainStationDest.longitude },
      expect.objectContaining({ mode: "wheelchair" })
    );
  });

  it("測試 Case B: 板橋車站 ➔ 撫遠街 (307 幹線公車無障礙路線規劃)", async () => {
    const bus307Route = {
      routeId: "otp-307",
      routeName: "307",
      totalMinutes: 35,
      transferCount: 0,
      totalWalkDistanceM: 200,
      legs: [
        {
          type: "BUS",
          routeName: "307",
          departureStop: "板橋公車站",
          arrivalStop: "撫遠街口",
          cityCode: "Taipei",
          waitInfo: { time: 120, source: "realtime" },
          estimatedWaitMinutes: 2,
          direction: 0,
          polyline: [],
          departureStopA11y: [],
          arrivalStopA11y: [],
          tdxCity: "Taipei",
        },
      ],
      accessibilityHighlights: ["全線低底盤公車"],
    };

    vi.mocked(planOtpRoute).mockResolvedValue([bus307Route] as any);

    const req = {
      travelMode: "transit" as const,
      origin: { latitude: 25.0143, longitude: 121.4638 }, // 板橋車站
      destination: { latitude: 25.0602, longitude: 121.5684 }, // 撫遠街口
      mode: "elderly" as const,
    };

    const res = await planAccessibleRouteFromRequest(req);

    expect(res.ok).toBe(true);
    if (!res.ok) return;

    expect(res.data.routes[0].routeName).toBe("307");
    expect(res.data.routes[0].accessibilityHighlights).toContain("全線低底盤公車");
  });

  it("測試 Case C: 帶途經點公車路線規劃 (政大 ➔ 中正紀念堂 ➔ 台北車站)", async () => {
    const seg1Route = {
      routeId: "seg1",
      routeName: "羅斯福路幹線 (段1)",
      totalMinutes: 15,
      transferCount: 0,
      legs: [
        { type: "WALK", from: "政大", to: "公車站", distanceM: 50, minutesEst: 1, polyline: [], a11yFacilities: [] },
        { type: "BUS", routeName: "羅斯福路幹線", departureStop: "政大", arrivalStop: "中正紀念堂", waitInfo: { time: 0, source: "realtime" }, estimatedWaitMinutes: 0, direction: 0, polyline: [], departureStopA11y: [], arrivalStopA11y: [] },
        { type: "WALK", from: "公車站", to: "中正紀念堂", distanceM: 50, minutesEst: 1, polyline: [], a11yFacilities: [] },
      ],
      accessibilityHighlights: [],
    };

    const seg2Route = {
      routeId: "seg2",
      routeName: "信義幹線 (段2)",
      totalMinutes: 10,
      transferCount: 0,
      legs: [
        { type: "WALK", from: "中正紀念堂", to: "公車站", distanceM: 50, minutesEst: 1, polyline: [], a11yFacilities: [] },
        { type: "BUS", routeName: "信義幹線", departureStop: "中正紀念堂", arrivalStop: "台北車站", waitInfo: { time: 0, source: "realtime" }, estimatedWaitMinutes: 0, direction: 0, polyline: [], departureStopA11y: [], arrivalStopA11y: [] },
        { type: "WALK", from: "公車站", to: "台北車站", distanceM: 50, minutesEst: 1, polyline: [], a11yFacilities: [] },
      ],
      accessibilityHighlights: [],
    };

    vi.mocked(planOtpRoute)
      .mockResolvedValueOnce([seg1Route] as any)
      .mockResolvedValueOnce([seg2Route] as any);

    const req = {
      travelMode: "transit" as const,
      origin: nccuOrigin,
      destination: mainStationDest,
      waypoints: [cckMemMem],
      mode: "wheelchair" as const,
    };

    const res = await planAccessibleRouteFromRequest(req);

    expect(res.ok).toBe(true);
    if (!res.ok) return;

    expect(res.data.waypoints).toBeDefined();
    expect(res.data.routes[0].totalMinutes).toBe(25);
    expect(res.data.routes[0].routeName).toContain("羅斯福路幹線");
    expect(res.data.routes[0].routeName).toContain("信義幹線");
  });

  it("測試 Case D: 無可行公車/大眾運輸路線時回傳 404 (NOT_FOUND)", async () => {
    vi.mocked(planOtpRoute).mockResolvedValue([]);

    const req = {
      travelMode: "transit" as const,
      origin: { latitude: 24.00, longitude: 120.00 }, // 偏遠山區/外海
      destination: { latitude: 24.01, longitude: 120.01 },
    };

    const res = await planAccessibleRouteFromRequest(req);

    expect(res.ok).toBe(false);
    if (res.ok) return;

    expect(res.status).toBe(ResponseCode.NOT_FOUND);
    expect(res.error).toContain("找不到連通的公車或捷運路線");
  });
});
