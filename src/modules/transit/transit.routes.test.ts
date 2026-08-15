import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";

// Mock the bus service seam while keeping every other export of the module real,
// so importing the whole app graph stays intact. Per-test we set the return of
// each method used by the route under test.
vi.mock("./bus.service", async (orig) => ({
  ...((await orig()) as any),
  resolveBusCity: vi.fn(),
  getBusRouteInfo: vi.fn(),
  getBusRouteDetail: vi.fn(),
  getBusArrivalAtStop: vi.fn(),
  getBusTimetable: vi.fn(),
  getBusRealtimeOnRoute: vi.fn(),
  searchBusRoutes: vi.fn(),
  searchBusStops: vi.fn(),
  getNearbyStops: vi.fn(),
}));

import { buildTestApp } from "../../../tests/helpers/test-helpers";
import * as busService from "./bus.service";
import { ResponseCode } from "../../types/code";
import { MSG } from "../../constants/messages";

const app = buildTestApp();
const BASE = "/api/v1/transit";

beforeEach(() => {
  vi.resetAllMocks();
  // Sensible happy-path defaults; individual tests override as needed.
  vi.mocked(busService.resolveBusCity).mockResolvedValue("Taipei" as any);
});

describe("GET /api/v1/transit/bus/route", () => {
  it("returns 200 + service data with the `ok` flag stripped", async () => {
    vi.mocked(busService.getBusRouteInfo).mockResolvedValue({
      ok: true,
      route: { routeName: "307", stops: ["A", "B"] },
    } as any);

    const res = await request(app)
      .get(`${BASE}/bus/route`)
      .query({ routeName: "307", city: "台北" });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      ok: true,
      status: "success",
      code: ResponseCode.OK,
      message: MSG.OK,
      data: { route: { routeName: "307", stops: ["A", "B"] } },
    });
  });

  it("rejects a missing routeName with 400 (schema)", async () => {
    const res = await request(app)
      .get(`${BASE}/bus/route`)
      .query({ city: "台北" });

    expect(res.status).toBe(ResponseCode.INVALID_INPUT);
    expect(vi.mocked(busService.getBusRouteInfo)).not.toHaveBeenCalled();
  });

  it("rejects unknown query keys with 400 (strict schema)", async () => {
    const res = await request(app)
      .get(`${BASE}/bus/route`)
      .query({ routeName: "307", surprise: "x" });

    expect(res.status).toBe(ResponseCode.INVALID_INPUT);
  });

  it("returns 400 when the city cannot be resolved", async () => {
    vi.mocked(busService.resolveBusCity).mockResolvedValue(null);

    const res = await request(app)
      .get(`${BASE}/bus/route`)
      .query({ routeName: "307" });

    expect(res.status).toBe(ResponseCode.INVALID_INPUT);
    expect(res.body.message).toContain("有效的縣市");
    expect(vi.mocked(busService.getBusRouteInfo)).not.toHaveBeenCalled();
  });

  it("maps a service not-found error to 404", async () => {
    vi.mocked(busService.getBusRouteInfo).mockResolvedValue({
      ok: false,
      status: 404,
      error: "找不到路線",
    } as any);

    const res = await request(app)
      .get(`${BASE}/bus/route`)
      .query({ routeName: "307", city: "台北" });

    expect(res.status).toBe(ResponseCode.NOT_FOUND);
    expect(res.body.message).toBe("找不到路線");
  });

  it("returns 500 with the thrown message when the service throws", async () => {
    vi.mocked(busService.getBusRouteInfo).mockRejectedValue(
      new Error("db down"),
    );

    const res = await request(app)
      .get(`${BASE}/bus/route`)
      .query({ routeName: "307", city: "台北" });

    expect(res.status).toBe(ResponseCode.INTERNAL_ERROR);
    expect(res.body.message).toBe("db down");
  });
});

describe("GET /api/v1/transit/bus/route-detail", () => {
  it("returns 200 + route detail data", async () => {
    vi.mocked(busService.getBusRouteDetail).mockResolvedValue({
      ok: true,
      routeName: "307",
      directions: [{ direction: 0, stops: [] }],
      timetable: { firstBus: "06:00" },
    } as any);

    const res = await request(app)
      .get(`${BASE}/bus/route-detail`)
      .query({ routeName: "307", city: "台北" });

    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      routeName: "307",
      directions: [{ direction: 0, stops: [] }],
    });
  });
});

describe("GET /api/v1/transit/bus/arrival", () => {
  const VALID = {
    routeName: "307",
    stopName: "台北車站",
    city: "台北",
    direction: "0",
  };

  it("returns 200 + service data on success", async () => {
    vi.mocked(busService.getBusArrivalAtStop).mockResolvedValue({
      ok: true,
      arrivals: [{ estimateMinutes: 3, isLowFloor: true }],
    } as any);

    const res = await request(app).get(`${BASE}/bus/arrival`).query(VALID);

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({
      arrivals: [{ estimateMinutes: 3, isLowFloor: true }],
    });
    expect(vi.mocked(busService.getBusArrivalAtStop)).toHaveBeenCalledWith(
      expect.objectContaining({
        routeName: "307",
        stopName: "台北車站",
        city: "Taipei",
        direction: 0,
      }),
    );
  });

  it("rejects a missing stopName with 400 (schema)", async () => {
    const res = await request(app)
      .get(`${BASE}/bus/arrival`)
      .query({ routeName: "307", city: "台北" });

    expect(res.status).toBe(ResponseCode.INVALID_INPUT);
  });

  it("rejects an out-of-range direction with 400 (schema)", async () => {
    const res = await request(app)
      .get(`${BASE}/bus/arrival`)
      .query({ ...VALID, direction: "5" });

    expect(res.status).toBe(ResponseCode.INVALID_INPUT);
  });

  it("returns 400 when the city cannot be resolved", async () => {
    vi.mocked(busService.resolveBusCity).mockResolvedValue(null);

    const res = await request(app)
      .get(`${BASE}/bus/arrival`)
      .query({ routeName: "307", stopName: "台北車站" });

    expect(res.status).toBe(ResponseCode.INVALID_INPUT);
    expect(res.body.message).toContain("有效的縣市");
  });

  it("maps a service not-found error to 404", async () => {
    vi.mocked(busService.getBusArrivalAtStop).mockResolvedValue({
      ok: false,
      status: 404,
      error: "找不到到站資料",
    } as any);

    const res = await request(app).get(`${BASE}/bus/arrival`).query(VALID);

    expect(res.status).toBe(ResponseCode.NOT_FOUND);
    expect(res.body.message).toBe("找不到到站資料");
  });
});

describe("GET /api/v1/transit/bus/timetable", () => {
  it("returns 200 + service data on success", async () => {
    vi.mocked(busService.getBusTimetable).mockResolvedValue({
      ok: true,
      timetable: { firstBus: "06:00", lastBus: "23:00" },
    } as any);

    const res = await request(app)
      .get(`${BASE}/bus/timetable`)
      .query({ routeName: "307", city: "台北" });

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({
      timetable: { firstBus: "06:00", lastBus: "23:00" },
    });
  });

  it("returns 400 when the city cannot be resolved", async () => {
    vi.mocked(busService.resolveBusCity).mockResolvedValue(null);

    const res = await request(app)
      .get(`${BASE}/bus/timetable`)
      .query({ routeName: "307" });

    expect(res.status).toBe(ResponseCode.INVALID_INPUT);
  });

  it("maps a service upstream error to 500", async () => {
    vi.mocked(busService.getBusTimetable).mockResolvedValue({
      ok: false,
      status: 500,
      error: "TDX 錯誤",
    } as any);

    const res = await request(app)
      .get(`${BASE}/bus/timetable`)
      .query({ routeName: "307", city: "台北" });

    expect(res.status).toBe(500);
    expect(res.body.message).toBe("TDX 錯誤");
  });
});

describe("GET /api/v1/transit/bus/positions", () => {
  it("returns 200 + service data and coerces direction to a number", async () => {
    vi.mocked(busService.getBusRealtimeOnRoute).mockResolvedValue({
      ok: true,
      vehicles: [{ plate: "AAA-1", isLowFloor: true }],
    } as any);

    const res = await request(app)
      .get(`${BASE}/bus/positions`)
      .query({ routeName: "307", city: "台北", direction: "1" });

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({
      vehicles: [{ plate: "AAA-1", isLowFloor: true }],
    });
    expect(vi.mocked(busService.getBusRealtimeOnRoute)).toHaveBeenCalledWith(
      expect.objectContaining({
        routeName: "307",
        city: "Taipei",
        direction: 1,
      }),
    );
  });

  it("returns 400 when the city cannot be resolved", async () => {
    vi.mocked(busService.resolveBusCity).mockResolvedValue(null);

    const res = await request(app)
      .get(`${BASE}/bus/positions`)
      .query({ routeName: "307" });

    expect(res.status).toBe(ResponseCode.INVALID_INPUT);
  });

  it("maps a service not-found error to 404", async () => {
    vi.mocked(busService.getBusRealtimeOnRoute).mockResolvedValue({
      ok: false,
      status: 404,
      error: "目前無營運車輛",
    } as any);

    const res = await request(app)
      .get(`${BASE}/bus/positions`)
      .query({ routeName: "307", city: "台北" });

    expect(res.status).toBe(ResponseCode.NOT_FOUND);
    expect(res.body.message).toBe("目前無營運車輛");
  });
});

describe("GET /api/v1/transit/bus/search-routes", () => {
  it("returns matching route options", async () => {
    vi.mocked(busService.searchBusRoutes).mockResolvedValue({
      ok: true,
      routes: [
        {
          routeName: "307",
          city: "Taipei",
          departure: "撫順街口",
          destination: "板橋國中",
        },
      ],
    } as any);

    const res = await request(app)
      .get(`${BASE}/bus/search-routes`)
      .query({ keyword: "307" });

    expect(res.status).toBe(200);
    expect(res.body.data.routes).toHaveLength(1);
  });

  it("rejects an empty keyword", async () => {
    const res = await request(app)
      .get(`${BASE}/bus/search-routes`)
      .query({ keyword: "" });

    expect(res.status).toBe(ResponseCode.INVALID_INPUT);
    expect(vi.mocked(busService.searchBusRoutes)).not.toHaveBeenCalled();
  });
});

describe("GET /api/v1/transit/bus/search-stops", () => {
  it("returns matching stop options", async () => {
    vi.mocked(busService.searchBusStops).mockResolvedValue({
      ok: true,
      stops: [
        {
          stopUid: "TPE1",
          stopName: "台北車站",
          city: "Taipei",
          coordinates: [121.51, 25.04],
          routes: ["307"],
        },
      ],
    } as any);

    const res = await request(app)
      .get(`${BASE}/bus/search-stops`)
      .query({ keyword: "台北" });

    expect(res.status).toBe(200);
    expect(res.body.data.stops).toHaveLength(1);
    expect(vi.mocked(busService.searchBusStops)).toHaveBeenCalledWith("台北");
  });

  it("rejects an empty keyword", async () => {
    const res = await request(app)
      .get(`${BASE}/bus/search-stops`)
      .query({ keyword: "" });

    expect(res.status).toBe(ResponseCode.INVALID_INPUT);
    expect(vi.mocked(busService.searchBusStops)).not.toHaveBeenCalled();
  });

  it("rejects unexpected query fields", async () => {
    const res = await request(app)
      .get(`${BASE}/bus/search-stops`)
      .query({ keyword: "台北", foo: "1" });

    expect(res.status).toBe(ResponseCode.INVALID_INPUT);
    expect(vi.mocked(busService.searchBusStops)).not.toHaveBeenCalled();
  });
});

describe("GET /api/v1/transit/bus/nearby-stops", () => {
  it("returns nearby stops with default radius and limit", async () => {
    vi.mocked(busService.getNearbyStops).mockResolvedValue({
      ok: true,
      stops: [{ stopName: "台北車站", distance: 120, routes: ["307"] }],
    } as any);

    const res = await request(app)
      .get(`${BASE}/bus/nearby-stops`)
      .query({ lat: 25.0478, lng: 121.5171 });

    expect(res.status).toBe(200);
    expect(res.body.data.stops).toHaveLength(1);
    expect(vi.mocked(busService.getNearbyStops)).toHaveBeenCalledWith({
      lat: 25.0478,
      lng: 121.5171,
      radius: 500,
      limit: 10,
    });
  });

  it("rejects missing coordinates", async () => {
    const res = await request(app)
      .get(`${BASE}/bus/nearby-stops`)
      .query({ lat: 25.0478 });

    expect(res.status).toBe(ResponseCode.INVALID_INPUT);
    expect(vi.mocked(busService.getNearbyStops)).not.toHaveBeenCalled();
  });
});
