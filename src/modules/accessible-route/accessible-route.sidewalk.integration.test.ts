import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import request from "supertest";
import type { Server } from "node:http";
import { AccessibleRouteSchema } from "./accessible-route.schema";
import {
  startTestServer,
  stopTestServer,
} from "../../../tests/helpers/test-helpers";

vi.hoisted(() => {
  if (process.env.SIDEWALK_OTP_URL)
    process.env.OTP_BASE_URL = process.env.SIDEWALK_OTP_URL;
  delete process.env.REDIS_URL;
  delete process.env.PED_GRAPH_DATABASE_URL;
});

vi.mock("../../adapters/google.adapter", async (original) => ({
  ...(await original<typeof import("../../adapters/google.adapter")>()),
  getCity: async () => "Taichung",
}));
vi.mock("../../adapters/nlsc.adapter", () => ({
  getNlscAdministrativeArea: async () => null,
}));
vi.mock("../a11y/a11y.service", async (original) => ({
  ...(await original<typeof import("../a11y/a11y.service")>()),
  findNearbyParking: async () => [],
  findParkArrivalCandidates: async () => ({
    nearbyEntrances: [],
    containingParks: [],
  }),
  findEntrancesOfParks: async () => [],
}));
vi.mock("../a11y/a11y.orchestration", async (original) => ({
  ...(await original<typeof import("../a11y/a11y.orchestration")>()),
  findNearby: async () => [],
}));
vi.mock("../hazard-report/hazard-report.service", () => ({
  findConfirmedHazardsWithin: async () => [],
}));
vi.mock("../traffic/road-incident.service", () => ({
  getActiveRoadIncidents: async () => [],
}));
vi.mock("../environment/environment.service", () => ({
  getWeatherAndAirQuality: async () => ({}),
}));

const origin = { latitude: 24.1401444, longitude: 120.68586 };
const destinations = [
  { latitude: 24.1415199, longitude: 120.6857675 },
  { latitude: 24.1416399, longitude: 120.6856752 },
];
const modes = [
  { mode: "normal", avoidStairs: false },
  { mode: "normal", avoidStairs: true },
  { mode: "wheelchair", avoidStairs: true },
  { mode: "wheelchair", avoidStairs: false },
];

function longitudeAt(points: number[][], latitude: number): number {
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1];
    const b = points[i];
    if (
      a[1] === b[1] ||
      latitude < Math.min(a[1], b[1]) ||
      latitude > Math.max(a[1], b[1])
    )
      continue;
    return a[0] + ((b[0] - a[0]) * (latitude - a[1])) / (b[1] - a[1]);
  }
  throw new Error("Route did not pass the screenshot-area cross-section");
}

describe.skipIf(!process.env.SIDEWALK_OTP_URL)(
  "screenshot-area real OTP through Express",
  () => {
    let server: Server;
    beforeAll(async () => {
      server = await startTestServer();
    });
    afterAll(async () => {
      await stopTestServer(server);
    });
    for (const [segment, destination] of destinations.entries()) {
      for (const reverse of [false, true]) {
        for (const settings of modes) {
          it(`segment ${segment}, reverse=${reverse}, ${settings.mode}, avoidStairs=${settings.avoidStairs}`, async () => {
            const response = await request(server)
              .post("/api/v1/a11y/accessible-route")
              .send({
                origin: reverse ? destination : origin,
                destination: reverse ? origin : destination,
                travelMode: "walk",
                ...settings,
              });
            expect(response.status, JSON.stringify(response.body)).toBe(200);
            expect(response.body.data.routes.length).toBeGreaterThan(0);
            for (const route of AccessibleRouteSchema.array().parse(
              response.body.data.routes,
            )) {
              const points = route.legs.flatMap((leg) =>
                "polyline" in leg ? (leg.polyline ?? []) : [],
              );
              expect(longitudeAt(points, 24.1408)).toBeLessThan(120.68575);
              expect(route.walkPolicy).toMatchObject({
                version: "sidewalk-priority-v1",
                profile: settings.mode,
                avoidStairs: settings.avoidStairs,
              });
              if (!route.walkPolicy)
                throw new Error("Executed walk policy omitted");
              expect(route.walkPolicy.carriagewayMillimetres).toBe(0);
              if (settings.avoidStairs)
                expect(
                  route.legs.some(
                    (leg) =>
                      leg.type === "WALK" &&
                      leg.steps?.some((step) => step.stairs),
                  ),
                ).toBe(false);
            }
          }, 30_000);
        }
      }
    }
  },
);
