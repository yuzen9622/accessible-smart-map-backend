import { encode } from "@googlemaps/polyline-codec";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OtpItinerary } from "./otp-routing.types";

const { post } = vi.hoisted(() => ({ post: vi.fn() }));
vi.mock("axios", () => ({
  default: { create: () => ({ post }), isAxiosError: () => false },
}));

import { planOtpWalkDetailed } from "./otp-routing";

const origin = { lat: 25.02111, lng: 121.53591 };
const destination = { lat: 25.04624, lng: 121.51747 };
const primaryShape: [number, number][] = [
  [25.02111, 121.53591],
  [25.035, 121.53],
  [25.04624, 121.51747],
];
const referenceShape: [number, number][] = [
  [25.02111, 121.53591],
  [25.035, 121.52],
  [25.04624, 121.51747],
];
const response = (itineraries: OtpItinerary[]) => ({
  data: { data: { plan: { itineraries } } },
});

function itinerary(points: [number, number][]): OtpItinerary {
  return {
    duration: 6000,
    walkDistance: 4500,
    legs: [
      {
        mode: "WALK",
        startTime: 0,
        endTime: 6_000_000,
        duration: 6000,
        distance: 4500,
        from: { name: "Origin" },
        to: { name: "Destination" },
        legGeometry: { points: encode(points, 5) },
        steps: [
          {
            distance: 4500,
            lat: points[0][0],
            lon: points[0][1],
            streetName: "steps",
            relativeDirection: "DEPART",
            absoluteDirection: "NORTH",
            feature: { __typename: "StairsUse" },
          },
        ],
      },
    ],
  };
}

beforeEach(() => {
  post.mockReset();
  vi.stubEnv("ROUTE_WALK_PLANNER", "otp");
});
afterEach(() => {
  vi.unstubAllEnvs();
});

describe("official OTP walking candidates with a stair preference", () => {
  it("retains wheelchair routing and adds a same-speed walking reference without dropping stairs", async () => {
    post
      .mockResolvedValueOnce(response([itinerary(primaryShape)]))
      .mockResolvedValueOnce(response([itinerary(referenceShape)]));

    const result = await planOtpWalkDetailed(origin, destination, {
      mode: "wheelchair",
      avoidStairs: true,
      includeWalkingAlternatives: true,
    });

    expect(result.status).toBe("ok");
    expect(result.routes).toHaveLength(2);
    expect(post).toHaveBeenCalledTimes(2);
    const primary = post.mock.calls[0][1];
    const reference = post.mock.calls[1][1];
    expect(primary.variables).toMatchObject({
      fromLat: origin.lat,
      fromLon: origin.lng,
      toLat: destination.lat,
      toLon: destination.lng,
      wheelchair: true,
      walkSpeed: 0.8,
    });
    expect(reference.variables).toEqual({
      ...primary.variables,
      wheelchair: false,
    });
    expect(new Set(result.routes.map((route) => route.routeId)).size).toBe(2);
    expect(result.routes.map((route) => route.legs[0].polyline)).toEqual(
      expect.arrayContaining([
        primaryShape.map(([lat, lng]) => [lng, lat]),
        referenceShape.map(([lat, lng]) => [lng, lat]),
      ]),
    );
    for (const route of result.routes) {
      const leg = route.legs[0];
      if (leg.type !== "WALK") throw new Error("Expected a walking candidate");
      expect(leg.steps?.some((step) => step.stairs)).toBe(true);
      expect(route).not.toHaveProperty("walkPolicy");
    }
    expect(primary.query).not.toContain("walkPolicy");
    expect(reference.query).not.toContain("walkPolicy");
  });

  it("retains hard stair exclusion for callers that did not enable alternatives", async () => {
    post.mockResolvedValueOnce(response([itinerary(primaryShape)]));

    expect(
      await planOtpWalkDetailed(origin, destination, {
        mode: "wheelchair",
        avoidStairs: true,
      }),
    ).toEqual({ status: "no_route", routes: [] });
    expect(post).toHaveBeenCalledTimes(1);
    expect(post.mock.calls[0][1].variables.wheelchair).toBe(true);
  });

  it("keeps the original candidate when the optional reference query fails", async () => {
    post
      .mockResolvedValueOnce(response([itinerary(primaryShape)]))
      .mockRejectedValueOnce(new Error("Optional reference unavailable"));

    const result = await planOtpWalkDetailed(origin, destination, {
      mode: "wheelchair",
      avoidStairs: true,
      includeWalkingAlternatives: true,
    });

    expect(result.status).toBe("ok");
    expect(result.routes).toHaveLength(1);
    expect(result.routes[0].legs[0].polyline).toEqual(
      primaryShape.map(([lat, lng]) => [lng, lat]),
    );
    const leg = result.routes[0].legs[0];
    if (leg.type !== "WALK") throw new Error("Expected a walking candidate");
    expect(leg.steps?.some((step) => step.stairs)).toBe(true);
  });

  it("can return a marked reference candidate when the primary query finds no itinerary", async () => {
    post
      .mockResolvedValueOnce(response([]))
      .mockResolvedValueOnce(response([itinerary(referenceShape)]));

    const result = await planOtpWalkDetailed(origin, destination, {
      mode: "wheelchair",
      avoidStairs: true,
      includeWalkingAlternatives: true,
    });

    expect(result.status).toBe("ok");
    expect(result.routes).toHaveLength(1);
    expect(post.mock.calls.map((call) => call[1].variables.wheelchair)).toEqual(
      [true, false],
    );
    expect(result.routes[0]).not.toHaveProperty("walkPolicy");
    const leg = result.routes[0].legs[0];
    if (leg.type !== "WALK") throw new Error("Expected a walking candidate");
    expect(leg.steps?.some((step) => step.stairs)).toBe(true);
  });
});
