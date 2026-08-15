import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./nav-instructions.service", async (importActual) => {
  const actual =
    await importActual<typeof import("./nav-instructions.service")>();
  return { ...actual, generateNavInstructionsFromInput: vi.fn() };
});

import { buildTestApp } from "../../../tests/helpers/test-helpers";
import { generateNavInstructionsFromInput } from "./nav-instructions.service";

const app = buildTestApp();
const URL = "/api/v1/a11y/route/instructions";
const generate = vi.mocked(generateNavInstructionsFromInput);

const WALK_POLYLINE: [number, number][] = [
  [121.5654, 25.0418],
  [121.5651, 25.0417],
  [121.5648, 25.0421],
  [121.562, 25.0455],
];

const walkLeg = (steps: Record<string, unknown>[]) => ({
  type: "WALK",
  from: { lat: 25.0418, lng: 121.5654 },
  to: "終點",
  distanceM: 640,
  minutesEst: 9,
  polyline: WALK_POLYLINE,
  a11yFacilities: [],
  steps,
});

const otpRoute = {
  routeId: "walk-0",
  routeName: "步行",
  totalMinutes: 9,
  transferCount: 0,
  totalWalkDistanceM: 640,
  legs: [
    walkLeg([
      {
        relativeDirection: "DEPART",
        absoluteDirection: "NORTHWEST",
        streetName: "open area",
        bogusName: true,
        area: true,
        stairs: false,
        distanceM: 40,
        location: WALK_POLYLINE[0],
      },
      {
        relativeDirection: "RIGHT",
        absoluteDirection: "NORTHEAST",
        streetName: "基隆路一段147巷",
        bogusName: false,
        area: false,
        stairs: false,
        distanceM: 600,
        location: WALK_POLYLINE[2],
      },
    ]),
  ],
};

const valhallaRoute = {
  routeId: "walk-1",
  routeName: "步行",
  totalMinutes: 14,
  transferCount: 0,
  totalWalkDistanceM: 1040,
  legs: [
    walkLeg([
      {
        instruction: "沿目前道路出發",
        maneuver: "DEPART",
        relativeDirection: "DEPART",
        absoluteDirection: null,
        streetName: "",
        bogusName: true,
        area: false,
        stairs: false,
        distanceM: 1040,
        location: WALK_POLYLINE[0],
      },
    ]),
  ],
};

beforeEach(() => {
  vi.resetAllMocks();
  generate.mockResolvedValue({
    ok: true,
    data: {
      instructions: [
        {
          text: "沿測試路線前進，續行約 100 公尺",
          type: "depart",
          bearing: 90,
          relativeDirection: null,
          distanceM: 100,
          streetName: "測試路線",
          legType: "WALK",
          stairs: false,
          legIndex: 0,
          polylineIndex: 0,
          cumulativeDistanceM: 0,
        },
      ],
      initialBearing: 90,
      totalSteps: 1,
      warnings: [],
    },
  });
});

describe("POST /api/v1/a11y/route/instructions route contracts", () => {
  it.each([
    ["OTP walk", otpRoute],
    ["Valhalla fallback walk", valhallaRoute],
  ])("accepts the %s route shape", async (_label, route) => {
    const response = await request(app).post(URL).send({ route });
    expect(response.status).toBe(200);
    expect(response.body.data.instructions[0]).toMatchObject({
      legIndex: 0,
      cumulativeDistanceM: 0,
    });
    expect(generate).toHaveBeenCalledWith(
      expect.objectContaining({
        route: expect.objectContaining({ routeId: route.routeId }),
      }),
    );
  });

  it("accepts a multi-leg walk + waypoints route", async () => {
    const route = {
      ...otpRoute,
      routeId: "fixture-waypoints",
      legs: [otpRoute.legs[0], otpRoute.legs[0]],
    };
    const response = await request(app).post(URL).send({ route });
    expect(response.status).toBe(200);
    expect(generate.mock.calls[0][0].route?.legs).toHaveLength(2);
  });

  it("accepts routeToken without requiring an inline route", async () => {
    const response = await request(app).post(URL).send({
      routeToken: "fixture-capability",
      userHeading: 45,
    });
    expect(response.status).toBe(200);
    expect(generate).toHaveBeenCalledWith({
      route: undefined,
      routeToken: "fixture-capability",
      userHeading: 45,
    });
  });
});
