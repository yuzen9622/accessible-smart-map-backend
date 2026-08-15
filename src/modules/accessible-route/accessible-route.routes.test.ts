import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import { ROUTE_MSG, ROUTE_REASON } from "../../constants/messages";
import { ResponseCode } from "../../types/code";
import { TaiwanCityEn } from "../../types/transit";

vi.mock("../../config/auth", async () => {
  const { createAuthModuleMock } =
    await import("../../../tests/helpers/auth-mock");
  return createAuthModuleMock();
});

// Mock only the service seam; the request still exercises router + validation
// + controller + envelope (schema defaults / rejections happen before the mock).
vi.mock("./accessible-route.service", async (importActual) => {
  const actual =
    await importActual<typeof import("./accessible-route.service")>();
  return { ...actual, planAccessibleRouteForHttp: vi.fn() };
});

import {
  buildTestApp,
  buildAuthorizationHeader,
} from "../../../tests/helpers/test-helpers";
import * as service from "./accessible-route.service";
import { AccessibleRouteSchema } from "./accessible-route.schema";

const app = buildTestApp();
const URL = "/api/v1/a11y/accessible-route";
const mockPlan = vi.mocked(service.planAccessibleRouteForHttp);
const AUTH = buildAuthorizationHeader({
  _id: "user-abc",
  email: "user@test.com",
});

const okData = (overrides: Record<string, unknown> = {}) => ({
  origin: { lat: 25.04, lng: 121.56 },
  destination: { lat: 25.03, lng: 121.55 },
  city: TaiwanCityEn.Taipei,
  travelMode: "transit" as const,
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
        routes: [
          {
            routeId: "walk-0",
            routeToken: "high-entropy-capability",
            routeName: "步行",
            totalMinutes: 3,
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
        origin: { latitude: 25, longitude: 121 },
        destination: { latitude: 25.1, longitude: 121.1 },
      });
    expect(res.status).toBe(200);
    expect(res.body.data.routes[0].routeToken).toBe("high-entropy-capability");
  });

  it("serializes the additive strict confirmed-hazard advisory contract", async () => {
    const route = {
      routeId: "hazard-route",
      routeName: "避開施工替代路線",
      totalMinutes: 22,
      transferCount: 0,
      legs: [],
      accessibilityHighlights: [],
      hazardAdvisory: {
        onRoute: [],
        avoided: [
          {
            id: "confirmed-1",
            hazardType: "construction",
            severity: "blocking",
            description: "人行道施工中",
            location: { lat: 25.041, lng: 121.567 },
            distanceM: 7.5,
          },
        ],
        blockingOnRoute: 0,
        penaltyPoints: 0,
      },
    };
    mockPlan.mockResolvedValue({
      ok: true,
      data: okData({ routes: [route] }),
    } as any);

    const res = await request(app)
      .post(URL)
      .send({
        origin: { latitude: 25, longitude: 121 },
        destination: { latitude: 25.1, longitude: 121.1 },
      });

    expect(res.status).toBe(200);
    expect(res.body.data.routes[0].hazardAdvisory).toEqual(
      route.hazardAdvisory,
    );
    expect(AccessibleRouteSchema.safeParse(route).success).toBe(true);
    expect(
      AccessibleRouteSchema.safeParse({
        ...route,
        hazardAdvisory: { ...route.hazardAdvisory, unrecognized: true },
      }).success,
    ).toBe(false);
  });

  it("returns 200 with a next-service-day scheduled departure", async () => {
    mockPlan.mockResolvedValue({
      ok: true,
      data: okData({
        routes: [
          {
            routeId: "otp-next-day",
            routeName: "NEXT",
            totalMinutes: 40,
            transferCount: 0,
            departureDate: "2030-01-02",
            legs: [
              {
                type: "BUS",
                routeName: "NEXT",
                departureStop: "東南國中",
                arrivalStop: "台中科大",
                departureTime: "06:20",
                arrivalTime: "07:00",
                waitInfo: { time: "06:20", source: "schedule" },
                direction: 0,
                polyline: [],
                departureStopA11y: [],
                arrivalStopA11y: [],
              },
            ],
            accessibilityHighlights: [],
          },
        ],
      }),
    } as any);

    const res = await request(app)
      .post(URL)
      .send({
        origin: { latitude: 23.80409, longitude: 120.4517439 },
        destination: { latitude: 24.1497433, longitude: 120.6837712 },
        travelMode: "transit",
        departureTime: "2030-01-01T21:51:00+08:00",
      });

    expect(res.status).toBe(200);
    expect(res.body.data.routes[0]).toMatchObject({
      departureDate: "2030-01-02",
      legs: [{ departureTime: "06:20" }],
    });
    expect(res.body.data.routes[0].legs[0]).not.toHaveProperty(
      "estimatedWaitMinutes",
    );
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

  it("maps UPSTREAM_TIMEOUT to the exact HTTP 503 envelope", async () => {
    mockPlan.mockResolvedValue({
      ok: false,
      status: ResponseCode.SERVICE_UNAVAILABLE,
      error: ROUTE_MSG.UPSTREAM_TIMEOUT,
      data: { reason: ROUTE_REASON.UPSTREAM_TIMEOUT },
    });

    const res = await request(app)
      .post(URL)
      .send({
        origin: { latitude: 25, longitude: 121 },
        destination: { latitude: 25.1, longitude: 121.1 },
        travelMode: "drive",
      });

    expect(res.status).toBe(ResponseCode.SERVICE_UNAVAILABLE);
    expect(res.body).toEqual({
      ok: false,
      status: "error",
      code: ResponseCode.SERVICE_UNAVAILABLE,
      message: ROUTE_MSG.UPSTREAM_TIMEOUT,
      data: { reason: ROUTE_REASON.UPSTREAM_TIMEOUT },
    });
  });

  it("maps a service 422 outcome and preserves exact failure data", async () => {
    mockPlan.mockResolvedValue({
      ok: false,
      status: ResponseCode.UNPROCESSABLE_ENTITY,
      error: ROUTE_MSG.OUT_OF_RANGE,
      data: {
        reason: ROUTE_REASON.OUT_OF_RANGE,
        maxDistanceKm: 100,
      },
    });

    const res = await request(app)
      .post(URL)
      .send({
        origin: { latitude: 25, longitude: 121 },
        destination: { latitude: 25.1, longitude: 121.1 },
      });

    expect(res.status).toBe(ResponseCode.UNPROCESSABLE_ENTITY);
    expect(res.body).toMatchObject({
      ok: false,
      status: "error",
      code: ResponseCode.UNPROCESSABLE_ENTITY,
      message: ROUTE_MSG.OUT_OF_RANGE,
    });
    expect(res.body.data).toEqual({
      reason: ROUTE_REASON.OUT_OF_RANGE,
      maxDistanceKm: 100,
    });
  });
  it.each([
    [ROUTE_REASON.NO_ROUTE, ROUTE_MSG.NO_ROUTE],
    [ROUTE_REASON.NO_ACCESSIBLE_ROUTE, ROUTE_MSG.NO_ACCESSIBLE_ROUTE],
  ] as const)(
    "maps %s to the exact HTTP 422 envelope",
    async (reason, message) => {
      mockPlan.mockResolvedValue({
        ok: false,
        status: ResponseCode.UNPROCESSABLE_ENTITY,
        error: message,
        data: { reason },
      });

      const res = await request(app)
        .post(URL)
        .send({
          origin: { latitude: 25, longitude: 121 },
          destination: { latitude: 25.1, longitude: 121.1 },
        });

      expect(res.status).toBe(ResponseCode.UNPROCESSABLE_ENTITY);
      expect(res.body).toEqual({
        ok: false,
        status: "error",
        code: ResponseCode.UNPROCESSABLE_ENTITY,
        message,
        data: { reason },
      });
    },
  );
});

describe("accessible-route OpenAPI", () => {
  it("publishes 422 route reasons, the 503 timeout reason, and no stale route 404", async () => {
    const res = await request(app).get("/api/v1/openapi.json");

    expect(res.status).toBe(200);
    const responses = res.body.paths["/a11y/accessible-route"].post.responses;
    for (const reason of [
      ROUTE_REASON.OUT_OF_RANGE,
      ROUTE_REASON.OUT_OF_COVERAGE,
      ROUTE_REASON.NO_ACCESSIBLE_ROUTE,
      ROUTE_REASON.NO_ROUTE,
    ]) {
      expect(responses["422"].description).toContain(reason);
    }
    expect(responses["503"].description).toContain(
      ROUTE_REASON.UPSTREAM_TIMEOUT,
    );
    expect(responses["404"]).toBeUndefined();
    expect(res.body.components.schemas.RouteFailureData).toMatchObject({
      type: "object",
      additionalProperties: false,
      properties: {
        reason: { enum: Object.values(ROUTE_REASON) },
        maxDistanceKm: { type: "number" },
      },
    });
    expect(
      res.body.components.schemas.ErrorResponse.properties.data.anyOf,
    ).toEqual(
      expect.arrayContaining([
        { $ref: "#/components/schemas/RouteFailureData" },
        expect.objectContaining({
          properties: expect.objectContaining({
            errors: expect.objectContaining({ type: "array" }),
          }),
        }),
      ]),
    );
    expect(res.body.components.schemas.RouteHazardAdvisory).toMatchObject({
      type: "object",
      additionalProperties: false,
      properties: {
        onRoute: { type: "array" },
        avoided: { type: "array" },
        blockingOnRoute: { type: "integer" },
        penaltyPoints: { type: "number" },
      },
    });
    expect(res.body.components.schemas.WalkLeg.properties).toEqual(
      expect.objectContaining({
        maxSlopePercent: expect.any(Object),
        crossings: expect.any(Object),
        crossingsWithCurbRamp: expect.any(Object),
        minPathWidthCm: expect.any(Object),
        surfaceType: expect.objectContaining({
          enum: ["paved", "gravel", "unknown"],
        }),
        restPoints: expect.objectContaining({ type: "array" }),
      }),
    );
  });
});

describe("POST /api/v1/a11y/accessible-route optional auth", () => {
  const body = { origin: "台北車站", destination: "台北101" };

  it("works anonymously with no Authorization header", async () => {
    mockPlan.mockResolvedValue({ ok: true, data: okData() });

    const res = await request(app).post(URL).send(body);

    expect(res.status).toBe(200);
    expect(mockPlan).toHaveBeenCalledWith(
      expect.objectContaining({ userId: undefined }),
    );
  });

  it("passes the authenticated userId through to the planner", async () => {
    mockPlan.mockResolvedValue({ ok: true, data: okData() });

    const res = await request(app)
      .post(URL)
      .set("Authorization", AUTH)
      .send(body);

    expect(res.status).toBe(200);
    expect(mockPlan).toHaveBeenCalledWith(
      expect.objectContaining({ userId: "user-abc" }),
    );
  });

  it("returns 403 for a garbage Bearer token instead of silently going anonymous", async () => {
    const res = await request(app)
      .post(URL)
      .set("Authorization", "Bearer not-a-real-jwt")
      .send(body);

    expect(res.status).toBe(403);
    expect(mockPlan).not.toHaveBeenCalled();
  });
});
