import { describe, expect, it, vi, beforeEach } from "vitest";

const { post, busLean, metroLean, trainLean, tripLean } = vi.hoisted(() => ({
  post: vi.fn(),
  busLean: vi.fn(),
  metroLean: vi.fn(),
  trainLean: vi.fn(),
  tripLean: vi.fn(),
}));

vi.mock("axios", () => ({
  default: { create: () => ({ post }), isAxiosError: () => false },
}));

vi.mock("../../../model/bus-stop.model", () => ({
  default: {
    find: () => ({ limit: () => ({ lean: busLean }) }),
  },
}));

vi.mock("../../../model/metro-station.model", () => ({
  default: {
    find: () => ({ limit: () => ({ lean: metroLean }) }),
  },
}));

vi.mock("../../../model/train-station.model", () => ({
  default: {
    find: () => ({ limit: () => ({ lean: trainLean }) }),
  },
}));

vi.mock("../../../model/gtfs-trip.model", () => ({
  GtfsTrip: {
    find: () => ({ select: () => ({ lean: tripLean }) }),
  },
}));

import {
  PLAN_QUERY,
  SUPPORTED_TRANSIT_MODES,
  planOtpRoute,
} from "./otp-routing";

const origin = { lat: 25.041, lng: 121.565 };
const destination = { lat: 25.033, lng: 121.564 };

const okResp = (itineraries: unknown[]) => ({
  data: { data: { plan: { itineraries } } },
});

const transitItinerary = (routeName: string) => ({
  duration: 600,
  walkDistance: 0,
  legs: [
    {
      mode: "BUS",
      startTime: 1_000,
      endTime: 601_000,
      duration: 600,
      distance: 5_000,
      from: {
        name: "起站",
        stop: { gtfsId: "1:BUS_A", code: "A", lat: 25.041, lon: 121.565 },
      },
      to: {
        name: "終站",
        stop: { gtfsId: "1:BUS_B", code: "B", lat: 25.033, lon: 121.564 },
      },
      route: {
        gtfsId: `1:${routeName}`,
        shortName: routeName,
        longName: routeName,
        type: 3,
        agency: { gtfsId: "1:BUS" },
      },
      trip: { gtfsId: `1:${routeName}_trip`, wheelchairAccessible: true },
      legGeometry: { points: "" },
      intermediatePlaces: [],
      steps: [],
    },
  ],
});

const threeDistinctTransitItineraries = () => [
  transitItinerary("R1"),
  transitItinerary("R2"),
  transitItinerary("R3"),
];

const walkOnlyItinerary = () => ({
  duration: 600,
  walkDistance: 500,
  legs: [
    {
      mode: "WALK",
      startTime: 1_000,
      endTime: 601_000,
      duration: 600,
      distance: 500,
      from: { name: "Origin" },
      to: { name: "Destination" },
      legGeometry: { points: "" },
      steps: [],
    },
  ],
});

beforeEach(() => {
  vi.clearAllMocks();
  busLean.mockResolvedValue([]);
  metroLean.mockResolvedValue([]);
  trainLean.mockResolvedValue([]);
  tripLean.mockResolvedValue([]);
});

// The OTP plan query must request an explicit mode allowlist (not the broad
// `TRANSIT` composite) so OTP never returns AIRPLANE/FERRY / offshore-island legs.
describe("OTP PLAN_QUERY transportModes allowlist", () => {
  const modes = [...SUPPORTED_TRANSIT_MODES];

  it("requests WALK plus every supported transit mode (single source of truth)", () => {
    expect(PLAN_QUERY).toContain("{ mode: WALK }");
    for (const m of modes) expect(PLAN_QUERY).toContain(`{ mode: ${m} }`);
  });

  it("does not request the broad TRANSIT composite or any air/water mode", () => {
    expect(PLAN_QUERY).not.toContain("{ mode: TRANSIT }");
    expect(PLAN_QUERY).not.toContain("AIRPLANE");
    expect(PLAN_QUERY).not.toContain("FERRY");
  });

  // Fixed-expectation guard: catches an accidental shrink of SUPPORTED_TRANSIT_MODES
  // that the dynamic test above would silently pass in lockstep with the query.
  it("resolves to exactly WALK + the 6 allowed transit modes", () => {
    const requested = [...PLAN_QUERY.matchAll(/\{ mode: (\w+) \}/g)].map((m) => m[1]);
    expect(new Set(requested)).toEqual(
      new Set(["WALK", "BUS", "TROLLEYBUS", "RAIL", "SUBWAY", "TRAM", "MONORAIL"]),
    );
  });
});

describe("OTP PLAN_QUERY searchWindow", () => {
  it("declares and passes searchWindow", () => {
    expect(PLAN_QUERY).toContain("$searchWindow: Long");
    expect(PLAN_QUERY).toContain("searchWindow: $searchWindow");
  });
});

describe("planOtpRoute search windows and timeouts", () => {
  it("uses one narrow query when it already has three distinct transit routes", async () => {
    post.mockResolvedValue(okResp(threeDistinctTransitItineraries()));

    await planOtpRoute(origin, destination);

    expect(post).toHaveBeenCalledTimes(1);
    expect(post.mock.calls[0][1].variables).toMatchObject({
      numItineraries: 8,
      searchWindow: 3600,
    });
  });

  it("retries an empty narrow result with the wide window", async () => {
    post
      .mockResolvedValueOnce(okResp([]))
      .mockResolvedValueOnce(okResp(threeDistinctTransitItineraries()));

    await planOtpRoute(origin, destination);

    expect(post).toHaveBeenCalledTimes(2);
    expect(post.mock.calls[1][1].variables).toMatchObject({
      numItineraries: 15,
      searchWindow: 28800,
    });
  });

  it("retries a WALK-only narrow result with the wide window", async () => {
    post
      .mockResolvedValueOnce(okResp([walkOnlyItinerary()]))
      .mockResolvedValueOnce(okResp(threeDistinctTransitItineraries()));

    await planOtpRoute(origin, destination);

    expect(post).toHaveBeenCalledTimes(2);
    expect(post.mock.calls[1][1].variables.searchWindow).toBe(28800);
  });

  it("returns immediately after a primary timeout", async () => {
    post.mockRejectedValueOnce({ code: "ECONNABORTED" });

    await expect(planOtpRoute(origin, destination)).resolves.toEqual([]);
    expect(post).toHaveBeenCalledTimes(1);
  });

  it("keeps the snap flow after a non-timeout primary error", async () => {
    busLean.mockResolvedValue([
      {
        location: { coordinates: [121.565, 25.041] },
        stopName: { Zh_tw: "公車站" },
      },
    ]);
    post
      .mockRejectedValueOnce({ code: "ERR_BAD_RESPONSE" })
      .mockResolvedValueOnce(okResp(threeDistinctTransitItineraries()));

    await planOtpRoute(origin, destination);

    expect(post.mock.calls.length).toBeGreaterThan(1);
  });

  it("returns after a wide-query timeout without issuing a snap query", async () => {
    post
      .mockResolvedValueOnce(okResp([]))
      .mockRejectedValueOnce({ code: "ECONNABORTED" });

    await expect(planOtpRoute(origin, destination)).resolves.toEqual([]);
    expect(post).toHaveBeenCalledTimes(2);
  });

  it("keeps the narrow window for snap after a non-timeout wide-query error", async () => {
    busLean.mockResolvedValue([
      {
        location: { coordinates: [121.565, 25.041] },
        stopName: { Zh_tw: "公車站" },
      },
    ]);
    post
      .mockResolvedValueOnce(okResp([]))
      .mockRejectedValueOnce({ code: "ERR_BAD_RESPONSE" })
      .mockResolvedValueOnce(okResp(threeDistinctTransitItineraries()));

    await expect(planOtpRoute(origin, destination)).resolves.toHaveLength(3);
    expect(post).toHaveBeenCalledTimes(3);
    expect(post.mock.calls[2][1].variables.searchWindow).toBe(3600);
  });

  it("records at most one breaker failure per plan call", async () => {
    vi.resetModules();
    const isolatedPost = vi.fn();
    for (let i = 0; i < 3; i += 1) {
      isolatedPost
        .mockRejectedValueOnce({ code: "ERR_BAD_RESPONSE" })
        .mockRejectedValueOnce({ code: "ECONNABORTED" });
    }
    vi.doMock("axios", () => ({
      default: {
        create: () => ({ post: isolatedPost }),
        isAxiosError: () => false,
      },
    }));
    busLean.mockResolvedValue([
      {
        location: { coordinates: [121.565, 25.041] },
        stopName: { Zh_tw: "公車站" },
      },
    ]);

    const isolatedOtpRouting = await import("./otp-routing");

    for (let i = 0; i < 2; i += 1) {
      await expect(
        isolatedOtpRouting.planOtpRoute(origin, destination),
      ).resolves.toEqual([]);
    }
    expect(isolatedOtpRouting.isOtpCircuitOpen()).toBe(false);

    await expect(
      isolatedOtpRouting.planOtpRoute(origin, destination),
    ).resolves.toEqual([]);
    expect(isolatedOtpRouting.isOtpCircuitOpen()).toBe(true);
    expect(isolatedPost).toHaveBeenCalledTimes(6);

    vi.doUnmock("axios");
    vi.resetModules();
  });
});
