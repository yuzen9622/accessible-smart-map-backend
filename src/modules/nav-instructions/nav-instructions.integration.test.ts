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
  it("resolves the route from routeToken", async () => {
    const response = await request(app).post(URL).send({
      routeToken: "fixture-capability",
      userHeading: 45,
    });
    expect(response.status).toBe(200);
    expect(response.body.data.instructions[0]).toMatchObject({
      legIndex: 0,
      cumulativeDistanceM: 0,
    });
    expect(generate).toHaveBeenCalledWith({
      routeToken: "fixture-capability",
      userHeading: 45,
    });
  });

  it("rejects a request without routeToken", async () => {
    const response = await request(app).post(URL).send({ userHeading: 45 });
    expect(response.status).toBe(400);
    expect(generate).not.toHaveBeenCalled();
  });

  it("rejects an inline route payload", async () => {
    const response = await request(app)
      .post(URL)
      .send({
        routeToken: "fixture-capability",
        route: { routeId: "walk-0", legs: [{ type: "WALK", polyline: [] }] },
      });
    expect(response.status).toBe(400);
    expect(generate).not.toHaveBeenCalled();
  });
});
