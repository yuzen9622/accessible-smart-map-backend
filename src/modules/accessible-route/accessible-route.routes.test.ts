import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";

// Mock only the service seam; the request still exercises router + validation
// + controller + envelope (schema defaults / rejections happen before the mock).
vi.mock("./accessible-route.service", async (importActual) => {
  const actual =
    await importActual<typeof import("./accessible-route.service")>();
  return { ...actual, planAccessibleRouteForHttp: vi.fn() };
});

import { buildTestApp } from "../../../tests/helpers/test-helpers";
import * as service from "./accessible-route.service";

const app = buildTestApp();
const URL = "/api/v1/a11y/accessible-route";
const mockPlan = vi.mocked(service.planAccessibleRouteForHttp);

const okData = (overrides: Record<string, unknown> = {}) => ({
  origin: { lat: 25.04, lng: 121.56 },
  destination: { lat: 25.03, lng: 121.55 },
  city: "Taipei",
  travelMode: "transit",
  routes: [],
  ...overrides,
});

beforeEach(() => {
  vi.resetAllMocks();
});

describe("POST /api/v1/a11y/accessible-route travel modes + waypoints", () => {
  it("returns the additive routeToken contract when caching succeeds", async () => {
    mockPlan.mockResolvedValue({
      ok: true,
      data: okData({
        routes: [{
          routeId: "walk-0",
          routeToken: "high-entropy-capability",
          routeName: "步行",
          totalMinutes: 3,
          transferCount: 0,
          legs: [],
          accessibilityHighlights: [],
        }],
      }),
    } as any);
    const res = await request(app).post(URL).send({
      origin: { latitude: 25, longitude: 121 },
      destination: { latitude: 25.1, longitude: 121.1 },
    });
    expect(res.status).toBe(200);
    expect(res.body.data.routes[0].routeToken).toBe("high-entropy-capability");
  });

  it("echoes travelMode + waypoints for a drive request", async () => {
    mockPlan.mockResolvedValue({
      ok: true,
      data: okData({
        travelMode: "drive",
        waypoints: [{ lat: 25.035, lng: 121.555 }],
        routes: [
          {
            routeId: "drive-0",
            routeName: "開車",
            totalMinutes: 20,
            transferCount: 0,
            legs: [],
            accessibilityHighlights: [],
          },
        ],
      }),
    } as any);

    const res = await request(app)
      .post(URL)
      .send({
        origin: { latitude: 25.04, longitude: 121.56 },
        destination: { latitude: 25.03, longitude: 121.55 },
        travelMode: "drive",
        waypoints: [{ latitude: 25.035, longitude: 121.555 }],
      });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.data.travelMode).toBe("drive");
    expect(res.body.data.waypoints).toHaveLength(1);
  });

  it("defaults travelMode to transit when omitted (passed through to service)", async () => {
    mockPlan.mockResolvedValue({ ok: true, data: okData() } as any);

    const res = await request(app)
      .post(URL)
      .send({
        origin: { latitude: 25, longitude: 121 },
        destination: { latitude: 25.1, longitude: 121.1 },
      });

    expect(res.status).toBe(200);
    expect(mockPlan.mock.calls[0][0].travelMode).toBe("transit");
  });

  it("passes avoidStairs + requireElevator through to the service", async () => {
    mockPlan.mockResolvedValue({ ok: true, data: okData() } as any);

    const res = await request(app)
      .post(URL)
      .send({
        origin: { latitude: 25, longitude: 121 },
        destination: { latitude: 25.1, longitude: 121.1 },
        mode: "elderly",
        avoidStairs: true,
        requireElevator: false,
      });

    expect(res.status).toBe(200);
    expect(mockPlan.mock.calls[0][0].avoidStairs).toBe(true);
    expect(mockPlan.mock.calls[0][0].requireElevator).toBe(false);
  });

  it("leaves both a11y flags undefined when omitted, so the mode default applies", async () => {
    mockPlan.mockResolvedValue({ ok: true, data: okData() } as any);

    await request(app)
      .post(URL)
      .send({
        origin: { latitude: 25, longitude: 121 },
        destination: { latitude: 25.1, longitude: 121.1 },
      });

    expect(mockPlan.mock.calls[0][0].avoidStairs).toBeUndefined();
    expect(mockPlan.mock.calls[0][0].requireElevator).toBeUndefined();
  });

  it("rejects a non-boolean avoidStairs with 400 before calling the service", async () => {
    const res = await request(app)
      .post(URL)
      .send({
        origin: { latitude: 25, longitude: 121 },
        destination: { latitude: 25.1, longitude: 121.1 },
        avoidStairs: "yes",
      });

    expect(res.status).toBe(400);
    expect(mockPlan).not.toHaveBeenCalled();
  });

  it("rejects an invalid travelMode with 400 before calling the service", async () => {
    const res = await request(app)
      .post(URL)
      .send({
        origin: { latitude: 25, longitude: 121 },
        destination: { latitude: 25.1, longitude: 121.1 },
        travelMode: "teleport",
      });

    expect(res.status).toBe(400);
    expect(mockPlan).not.toHaveBeenCalled();
  });

  it("rejects more than 5 waypoints with 400", async () => {
    const res = await request(app)
      .post(URL)
      .send({
        origin: { latitude: 25, longitude: 121 },
        destination: { latitude: 25.1, longitude: 121.1 },
        waypoints: Array.from({ length: 6 }, () => ({
          latitude: 25,
          longitude: 121,
        })),
      });

    expect(res.status).toBe(400);
    expect(mockPlan).not.toHaveBeenCalled();
  });

  it("serializes mixed WALK/DRIVE/WALK legs + walk distance + highlights intact", async () => {
    mockPlan.mockResolvedValue({
      ok: true,
      data: okData({
        travelMode: "drive",
        routes: [
          {
            routeId: "drive-0",
            routeName: "開車",
            totalMinutes: 20,
            transferCount: 0,
            totalWalkDistanceM: 300,
            accessibilityHighlights: [
              "起點需步行約 150 公尺至可上車路段",
              "目的地 300m 內有 2 處身障停車格",
            ],
            legs: [
              {
                type: "WALK",
                from: "起點",
                to: "上車處",
                distanceM: 150,
                minutesEst: 2,
                polyline: [
                  [121.56, 25.04],
                  [121.561, 25.041],
                ],
                a11yFacilities: [],
              },
              {
                type: "DRIVE",
                from: { lat: 25.041, lng: 121.561 },
                to: { lat: 25.031, lng: 121.551 },
                distanceM: 5000,
                durationMin: 12,
                polyline: [
                  [121.561, 25.041],
                  [121.551, 25.031],
                ],
              },
              {
                type: "WALK",
                from: "下車處",
                to: "終點",
                distanceM: 150,
                minutesEst: 2,
                polyline: [
                  [121.551, 25.031],
                  [121.55, 25.03],
                ],
                a11yFacilities: [],
              },
            ],
          },
        ],
      }),
    } as any);

    const res = await request(app)
      .post(URL)
      .send({
        origin: { latitude: 25.04, longitude: 121.56 },
        destination: { latitude: 25.03, longitude: 121.55 },
        travelMode: "drive",
      });

    expect(res.status).toBe(200);
    expect(res.body.data.routes[0].legs.map((l: any) => l.type)).toEqual([
      "WALK",
      "DRIVE",
      "WALK",
    ]);
    expect(res.body.data.routes[0].totalWalkDistanceM).toBe(300);
    expect(res.body.data.routes[0].accessibilityHighlights).toHaveLength(2);
  });

  it("maps a service 503 outcome to HTTP 503", async () => {
    mockPlan.mockResolvedValue({
      ok: false,
      status: 503,
      error: "路線規劃服務暫時忙線，請稍後再試",
    } as any);

    const res = await request(app)
      .post(URL)
      .send({
        origin: { latitude: 25, longitude: 121 },
        destination: { latitude: 25.1, longitude: 121.1 },
        travelMode: "drive",
      });

    expect(res.status).toBe(503);
    expect(res.body.ok).toBe(false);
  });
});
