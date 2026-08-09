import { beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";

vi.mock("../../config/fetch", () => ({
  tdxFetch: vi.fn().mockResolvedValue({ ok: true, json: async () => [] }),
}));

vi.mock("../environment/environment.service", () => ({
  getWeatherAndAirQuality: vi.fn().mockResolvedValue({}),
}));

vi.mock("./planners/route-a11y", () => ({
  nearbyA11y: vi.fn().mockResolvedValue([]),
  attachA11yToLeg: vi.fn(),
  deriveHighlights: vi.fn(),
  enrichLegIndoor: vi.fn(),
  buildAccessibilitySummary: vi.fn().mockReturnValue(""),
}));

vi.mock("./planners/otp-routing", async (importActual) => {
  const actual = await importActual<typeof import("./planners/otp-routing")>();
  return {
    ...actual,
    planOtpRoute: vi.fn(),
    planOtpRouteDetailed: vi.fn(),
    planOtpWalkDetailed: vi.fn(),
    isOtpCircuitOpen: vi.fn().mockReturnValue(false),
  };
});

vi.mock("../a11y/a11y.service", async (importActual) => {
  const actual = await importActual<typeof import("../a11y/a11y.service")>();
  return {
    ...actual,
    findNearby: vi.fn().mockResolvedValue({ nearbyOsm: [] }),
    findNearbyParking: vi.fn().mockResolvedValue([]),
  };
});

vi.mock("../../model/bus-stop.model", () => ({
  default: {
    findOne: () => ({
      select: () => ({ lean: () => Promise.resolve({ city: "Taipei" }) }),
    }),
  },
}));

vi.mock("../../adapters/google.adapter", async (importActual) => {
  const actual = await importActual<typeof import("../../adapters/google.adapter")>();
  return { ...actual, getCity: vi.fn(), getCoordinates: vi.fn() };
});

vi.mock("./route-token.service", async (importActual) => {
  const actual = await importActual<typeof import("./route-token.service")>();
  return {
    ...actual,
    attachRouteTokens: vi.fn(async (routes) => routes),
  };
});

import { buildTestApp } from "../../../tests/helpers/test-helpers";
import { planOtpWalkDetailed } from "./planners/otp-routing";

const app = buildTestApp();
const URL = "/api/v1/a11y/accessible-route";
const otpWalk = vi.mocked(planOtpWalkDetailed);

beforeEach(() => {
  vi.clearAllMocks();
  otpWalk.mockResolvedValue({
    status: "ok",
    routes: [{
      routeId: "walk-stairs",
      routeName: "步行",
      totalMinutes: 7,
      transferCount: 0,
      totalWalkDistanceM: 420,
      degraded: true,
      warnings: ["目前候選路線仍包含無坡道樓梯，無法完全滿足避開樓梯條件"],
      accessibilityHighlights: [],
      legs: [{
        type: "WALK",
        from: "出發地",
        to: "目的地",
        distanceM: 420,
        minutesEst: 7,
        polyline: [[121.56, 25.04], [121.55, 25.03]],
        a11yFacilities: [],
        steps: [{
          instruction: "沿「圓山市景步道」繼續直行，此路段含樓梯",
          relativeDirection: "CONTINUE",
          absoluteDirection: "NORTH",
          streetName: "圓山市景步道",
          bogusName: false,
          area: false,
          stairs: true,
          distanceM: 420,
          location: [121.56, 25.04],
        }],
      }],
    }],
  });
});

describe("POST /api/v1/a11y/accessible-route stairs degradation", () => {
  it("carries wheelchair avoidStairs through the service and exposes degraded metadata", async () => {
    const response = await request(app).post(URL).send({
      origin: { latitude: 25.04, longitude: 121.56 },
      destination: { latitude: 25.03, longitude: 121.55 },
      travelMode: "walk",
      mode: "wheelchair",
      avoidStairs: true,
    });

    expect(response.status).toBe(200);
    expect(otpWalk).toHaveBeenCalledWith(
      { lat: 25.04, lng: 121.56 },
      { lat: 25.03, lng: 121.55 },
      { mode: "wheelchair", avoidStairs: true },
    );
    expect(response.body.data.routes[0]).toMatchObject({
      degraded: true,
      warnings: ["目前候選路線仍包含無坡道樓梯，無法完全滿足避開樓梯條件"],
    });
    expect(response.body.data.routes[0].legs[0].steps[0].stairs).toBe(true);
  });

  it("publishes degraded and stairs in the generated OpenAPI schemas", async () => {
    const response = await request(app).get("/api/v1/openapi.json");

    expect(response.status).toBe(200);
    expect(response.body.components.schemas.AccessibleRoute.properties.degraded)
      .toMatchObject({ type: "boolean" });
    expect(response.body.components.schemas.WalkStep.properties.stairs)
      .toMatchObject({ type: "boolean" });
  });
});
