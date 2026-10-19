import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import request from "supertest";
vi.mock("./accessible-route.service", async (original) => ({
  ...(await original<typeof import("./accessible-route.service")>()),
  planAccessibleRouteForHttp: vi.fn(),
}));
vi.mock("./bus-arrivals.service", () => ({ getPlannedBusArrivals: vi.fn() }));
import { planAccessibleRouteForHttp } from "./accessible-route.service";
import { getPlannedBusArrivals } from "./bus-arrivals.service";
import {
  startTestServer,
  stopTestServer,
} from "../../../tests/helpers/test-helpers";
import { AccessibleRouteSchema } from "./accessible-route.schema";
import { BusDepartureCandidateSchema } from "../transit/transit.schema";
import { TaiwanCityEn } from "../../types/transit";
let app: Awaited<ReturnType<typeof startTestServer>>;
beforeAll(async () => {
  app = await startTestServer();
});
afterAll(async () => stopTestServer(app));
const departureTime = "2026-10-18T23:59:00+08:00",
  arrivalTime = "2026-10-19T00:20:00+08:00";
const candidate = {
  candidateId: "105|1|BUS|time",
  routeName: "105",
  subRouteUid: "TPE105",
  direction: 1 as const,
  departureStopId: "A",
  arrivalStopId: "B",
  boardingTime: departureTime,
  alightingTime: arrivalTime,
  estimatedWaitMinutes: 0,
  boardingTimeSource: "realtime" as const,
  alightingTimeSource: "realtime" as const,
  vehicleAccessibility: "unknown" as const,
  hasLiftOrRamp: null,
  selected: true,
};
const route = {
  routeId: "pair",
  routeName: "105",
  totalMinutes: 21,
  transferCount: 0,
  departureTime,
  arrivalTime,
  accessibilityHighlights: [],
  legs: [
    {
      type: "BUS",
      routeName: "105",
      subRouteUid: "TPE105",
      subRouteName: "105",
      departureStop: "A",
      arrivalStop: "B",
      departureStopId: "A",
      arrivalStopId: "B",
      direction: 1,
      polyline: [
        [121, 25],
        [121.1, 25.1],
      ],
      waitInfo: { time: 0, source: "realtime" },
      departureStopA11y: [],
      arrivalStopA11y: [],
      departureCandidates: [candidate],
      candidateSearchComplete: false,
    },
  ],
};
describe("pair candidate real Express/OpenAPI additive contract", () => {
  it("survives strict route validation and the production POST envelope across midnight", async () => {
    expect(AccessibleRouteSchema.parse(route)).toMatchObject(route);
    vi.mocked(planAccessibleRouteForHttp).mockResolvedValue({
      ok: true,
      data: {
        origin: { lat: 25, lng: 121 },
        destination: { lat: 25.1, lng: 121.1 },
        city: TaiwanCityEn.Taipei,
        routes: [route],
      },
    } as never);
    const res = await request(app)
      .post("/api/v1/a11y/accessible-route")
      .send({
        origin: { latitude: 25, longitude: 121 },
        destination: { latitude: 25.1, longitude: 121.1 },
      });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      ok: true,
      code: 200,
      data: { routes: [route] },
    });
    expect(
      (Date.parse(res.body.data.routes[0].arrivalTime) -
        Date.parse(res.body.data.routes[0].departureTime)) /
        60000,
    ).toBe(21);
  });
  it("preserves candidates and completeness on the existing refresh envelope", async () => {
    vi.mocked(getPlannedBusArrivals).mockResolvedValue({
      ok: true,
      routeName: "105",
      city: TaiwanCityEn.Taipei,
      operators: [],
      directions: [],
      departureCandidates: [candidate],
      candidateSearchComplete: false,
    });
    const res = await request(app)
      .get("/api/v1/a11y/accessible-route/bus-arrivals")
      .query({ routeToken: "trusted", legIndex: 0 });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      routeName: "105",
      departureCandidates: [candidate],
      candidateSearchComplete: false,
    });
  });
  it("publishes the same shared candidate schema and route ISO fields", async () => {
    const res = await request(app).get("/api/v1/openapi.json");
    expect(res.status).toBe(200);
    const schemas = res.body.components.schemas;
    expect(schemas.AccessibleRoute.properties.departureTime).toMatchObject({
      type: "string",
      format: "date-time",
    });
    expect(schemas.AccessibleRoute.properties.arrivalTime).toMatchObject({
      type: "string",
      format: "date-time",
    });
    expect(schemas.BusDepartureCandidate.properties).toMatchObject({
      selected: { type: "boolean" },
      vehicleAccessibility: { enum: ["low_floor", "high_floor", "unknown"] },
      boardingTimeSource: { enum: ["realtime", "schedule", "unknown"] },
    });
    const serialized = JSON.stringify(schemas.BusLeg);
    expect(serialized).toContain('"maxItems":5');
    expect(serialized).toContain("#/components/schemas/BusDepartureCandidate");
  });
  it("rejects public arrays over five and invalid source/vehicle/offset inputs", () => {
    expect(
      AccessibleRouteSchema.safeParse({
        ...route,
        legs: [
          { ...route.legs[0], departureCandidates: Array(6).fill(candidate) },
        ],
      }).success,
    ).toBe(false);
    for (const patch of [
      { vehicleAccessibility: "" },
      { boardingTimeSource: "terminal" },
      { boardingTime: "23:59" },
      { estimatedWaitMinutes: -1 },
    ])
      expect(
        BusDepartureCandidateSchema.safeParse({ ...candidate, ...patch })
          .success,
      ).toBe(false);
  });
});
