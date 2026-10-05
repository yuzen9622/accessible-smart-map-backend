import { beforeEach, describe, expect, it, vi } from "vitest";

const { post, store } = vi.hoisted(() => ({
  post: vi.fn(),
  store: new Map<string, string>(),
}));

vi.mock("axios", () => ({
  default: { create: () => ({ post }), isAxiosError: () => false },
}));
vi.mock("../../../config/redis", () => ({
  redisClient: {},
  redisGet: vi.fn(async (key: string) => store.get(key) ?? null),
  redisSet: vi.fn(async (key: string, value: string) => {
    store.set(key, value);
  }),
}));
vi.mock("../../../model/bus-stop.model", () => ({
  default: { find: () => ({ limit: () => ({ lean: async () => [] }) }) },
}));
vi.mock("../../../model/metro-station.model", () => ({
  default: { find: () => ({ limit: () => ({ lean: async () => [] }) }) },
}));
vi.mock("../../../model/train-station.model", () => ({
  default: { find: () => ({ limit: () => ({ lean: async () => [] }) }) },
}));
vi.mock("../../../model/gtfs-trip.model", () => ({
  GtfsTrip: { find: () => ({ select: () => ({ lean: async () => [] }) }) },
}));

import { PLAN_QUERY, planOtpRouteDetailed } from "./otp-routing";

const origin = { lat: 25.04123, lng: 121.56512 };
const destination = { lat: 25.03321, lng: 121.56433 };
const departure = new Date("2026-10-01T09:01:30+08:00");

function busItinerary(routeName: string, startTime: number) {
  return {
    duration: 600,
    walkDistance: 0,
    legs: [
      {
        mode: "BUS",
        startTime,
        endTime: startTime + 600_000,
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
  };
}

const later = departure.getTime() + 5 * 60_000;
const okResp = (
  itineraries: unknown[],
  routingErrors: { code: string }[] = [],
) => ({
  data: { data: { plan: { itineraries, routingErrors } } },
});

beforeEach(() => {
  store.clear();
  post.mockReset();
  post.mockResolvedValue(
    okResp([
      busItinerary("R1", later),
      busItinerary("R2", later),
      busItinerary("R3", later),
    ]),
  );
});

describe("OTP plan result cache", () => {
  it("serves an identical repeat request without calling OTP", async () => {
    await planOtpRouteDetailed(origin, destination, {
      departureTime: departure,
    });
    const calls = post.mock.calls.length;
    expect(calls).toBeGreaterThan(0);

    const again = await planOtpRouteDetailed(origin, destination, {
      departureTime: departure,
    });

    expect(post.mock.calls.length).toBe(calls);
    expect(again.routes.length).toBeGreaterThan(0);
  });

  it("shares one entry for endpoints a few metres apart in the same 2-minute bucket", async () => {
    await planOtpRouteDetailed(origin, destination, {
      departureTime: departure,
    });
    const calls = post.mock.calls.length;

    await planOtpRouteDetailed(
      { lat: origin.lat + 0.00002, lng: origin.lng - 0.00002 },
      destination,
      { departureTime: new Date(departure.getTime() + 20_000) },
    );

    expect(post.mock.calls.length).toBe(calls);
  });

  it("queries OTP with the rounded endpoints and the bucket start time", async () => {
    await planOtpRouteDetailed(origin, destination, {
      departureTime: departure,
    });

    const { variables } = post.mock.calls[0][1];
    expect(variables).toMatchObject({
      fromLat: 25.0412,
      fromLon: 121.5651,
      toLat: 25.0332,
      toLon: 121.5643,
      time: "09:00",
    });
  });

  it("drops cached itineraries that start before the real departure", async () => {
    post.mockResolvedValue(
      okResp([
        busItinerary("EARLY", departure.getTime() - 30_000),
        busItinerary("R1", later),
        busItinerary("R2", later),
        busItinerary("R3", later),
      ]),
    );

    const result = await planOtpRouteDetailed(origin, destination, {
      departureTime: departure,
    });

    expect(JSON.stringify(result.routes)).not.toContain("EARLY");
  });

  it("keeps a walk-only itinerary that starts at the bucket start, shifted to the real departure", async () => {
    const bucketStart = new Date("2026-10-01T09:00:00+08:00").getTime();
    post.mockResolvedValue(
      okResp(
        [
          {
            duration: 600,
            walkDistance: 700,
            legs: [
              {
                mode: "WALK",
                startTime: bucketStart,
                endTime: bucketStart + 600_000,
                duration: 600,
                distance: 700,
                from: { name: "Origin" },
                to: { name: "Destination" },
                legGeometry: { points: "" },
                steps: [],
              },
            ],
          },
        ],
        [{ code: "WALKING_BETTER_THAN_TRANSIT" }],
      ),
    );

    const result = await planOtpRouteDetailed(origin, destination, {
      departureTime: departure,
      mode: "wheelchair",
    });

    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.routes.map((route) => route.routeName)).toEqual(["步行路線"]);
    expect(result.routes[0]._scheduledDepartureTime).toBe(departure.getTime());
    expect(post).toHaveBeenCalledTimes(1);
  });

  it("does not cache a failed query", async () => {
    post.mockRejectedValue(new Error("boom"));
    await planOtpRouteDetailed(origin, destination, {
      departureTime: departure,
    });
    expect([...store.keys()].length).toBe(0);
  });
});

describe("OTP transit preferences", () => {
  it("sends the metro weight matrix, isolates its cache entry and shares none with omitted", async () => {
    for (const transitPreference of [
      undefined,
      "none",
      "metro",
      "metro",
      "rail",
    ] as const) {
      const result = await planOtpRouteDetailed(origin, destination, {
        departureTime: departure,
        transitPreference,
      });
      expect(result.status).toBe("ok");
    }
    const mainCalls = post.mock.calls.filter(
      (call) => call[1].query === PLAN_QUERY,
    );
    expect(mainCalls).toHaveLength(3);
    // Bus-only answers lack metro and rail: each preference adds one cached
    // preferred-only search.
    expect(post).toHaveBeenCalledTimes(5);
    const variables = mainCalls.map((call) => call[1].variables);
    expect(variables[0].modeWeight).toBeUndefined();
    expect(variables[1].modeWeight).toEqual({
      BUS: 1.5,
      TROLLEYBUS: 1.5,
      RAIL: 1.5,
      SUBWAY: 1,
      TRAM: 1,
      MONORAIL: 1,
    });
    expect(variables[2].modeWeight).toMatchObject({ RAIL: 1, SUBWAY: 1.5 });
    const query = mainCalls[1][1].query;
    for (const mode of ["BUS", "RAIL", "SUBWAY", "TRAM", "MONORAIL"])
      expect(query).toContain(`{ mode: ${mode} }`);
  });

  it.each(["SUBWAY", "TRAM", "MONORAIL"])(
    "maps OTP %s legs to METRO, not BUS",
    async (otpMode) => {
      const itinerary = busItinerary("MR", later);
      itinerary.legs[0].mode = otpMode;
      post.mockResolvedValue(okResp([itinerary]));
      const result = await planOtpRouteDetailed(origin, destination, {
        departureTime: departure,
        transitPreference: "metro",
      });
      expect(result.status).toBe("ok");
      expect(result.routes[0].legs[0]).toMatchObject({
        type: "METRO",
        rideMinutes: 10,
      });
    },
  );

  it("isolates bus and rail cache entries while none shares the default entry", async () => {
    for (const transitPreference of [
      undefined,
      "none",
      "bus",
      "rail",
      "bus",
      "rail",
    ] as const) {
      const result = await planOtpRouteDetailed(origin, destination, {
        departureTime: departure,
        transitPreference,
      });
      expect(result.status).toBe("ok");
      expect(result.routes[0].legs[0]).toMatchObject({
        type: "BUS",
        rideMinutes: 10,
      });
    }
    const mainCalls = post.mock.calls.filter(
      (call) => call[1].query === PLAN_QUERY,
    );
    expect(mainCalls).toHaveLength(3);
    // Only rail lacks its mode in the bus answer, once thanks to the cache.
    expect(post).toHaveBeenCalledTimes(4);
    const variables = mainCalls.map((call) => call[1].variables);
    expect(variables[0].modeWeight).toBeUndefined();
    expect(variables[1].modeWeight).toMatchObject({
      BUS: 1,
      TROLLEYBUS: 1,
      RAIL: 1.5,
      SUBWAY: 1.5,
    });
    expect(variables[2].modeWeight).toMatchObject({
      BUS: 1.5,
      RAIL: 1,
      SUBWAY: 1.5,
    });
    expect(mainCalls[1][1].query).toContain("modeWeight: $modeWeight");
  });

  it("keeps the preference and wheelchair constraint across later search attempts", async () => {
    post.mockResolvedValue(okResp([]));
    await planOtpRouteDetailed(origin, destination, {
      departureTime: departure,
      transitPreference: "rail",
      mode: "wheelchair",
    });
    const plans = post.mock.calls.filter(
      (call) => call[1].query === PLAN_QUERY,
    );
    expect(plans.length).toBeGreaterThan(2);
    const preferred = post.mock.calls.filter(
      (call) =>
        call[1].query.includes("query Plan(") && call[1].query !== PLAN_QUERY,
    );
    expect(preferred).toHaveLength(1);
    expect(preferred[0][1].variables).toMatchObject({ wheelchair: true });
    for (const call of plans) {
      expect(call[1].variables).toMatchObject({
        wheelchair: true,
        modeWeight: { BUS: 1.5, RAIL: 1 },
      });
    }
  });
});

describe("OTP preferred-mode candidate search", () => {
  const metroItinerary = () => {
    const itinerary = busItinerary("BL", later + 60_000);
    itinerary.legs[0].mode = "SUBWAY";
    return itinerary;
  };
  const isPreferredQuery = (call: unknown[]) =>
    (call[1] as { query: string }).query !== PLAN_QUERY;

  it("restricts the extra query to WALK plus the preferred modes", async () => {
    await planOtpRouteDetailed(origin, destination, {
      departureTime: departure,
      transitPreference: "metro",
    });
    const preferred = post.mock.calls.filter(isPreferredQuery);
    expect(preferred).toHaveLength(1);
    const modes = [...preferred[0][1].query.matchAll(/\{ mode: (\w+) \}/g)].map(
      (m) => m[1],
    );
    expect(modes).toEqual(["WALK", "SUBWAY", "TRAM", "MONORAIL"]);
    expect(preferred[0][1].variables.modeWeight).toBeUndefined();
    expect(preferred[0][1].variables.numItineraries).toBe(3);
  });

  it("keeps a preferred route even when the main answer fills the limit", async () => {
    const buses = Array.from({ length: 15 }, (_, i) =>
      busItinerary(`R${i}`, later),
    );
    post.mockImplementation(async (_url, body: { query: string }) =>
      body.query === PLAN_QUERY
        ? okResp(buses)
        : okResp([metroItinerary(), busItinerary("WALKISH", later)]),
    );
    const result = await planOtpRouteDetailed(origin, destination, {
      departureTime: departure,
      transitPreference: "metro",
    });
    expect(result.status).toBe("ok");
    expect(result.routes).toHaveLength(15);
    expect(result.routes[14].legs.map((leg) => leg.type)).toEqual(["METRO"]);
    expect(result.routes[14]._isFutureScheduled).toBe(false);
    expect(result.routes.some((r) => r.routeName === "WALKISH")).toBe(false);
  });

  it("skips the extra query when the main answer already rides the mode", async () => {
    await planOtpRouteDetailed(origin, destination, {
      departureTime: departure,
      transitPreference: "bus",
    });
    expect(post.mock.calls.filter(isPreferredQuery)).toHaveLength(0);
  });

  it("skips the extra query for single-route waypoint segments", async () => {
    await planOtpRouteDetailed(origin, destination, {
      departureTime: departure,
      transitPreference: "metro",
      limit: 1,
    });
    expect(post.mock.calls.filter(isPreferredQuery)).toHaveLength(0);
  });

  it("fails soft when the extra query errors", async () => {
    post.mockImplementation(async (_url, body: { query: string }) => {
      if (body.query !== PLAN_QUERY) throw new Error("boom");
      return okResp([busItinerary("R1", later)]);
    });
    const result = await planOtpRouteDetailed(origin, destination, {
      departureTime: departure,
      transitPreference: "metro",
    });
    expect(result.status).toBe("ok");
    expect(result.routes.map((r) => r.routeName)).toEqual(["R1"]);
  });

  it("answers without the extra query once its budget elapses", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    try {
      vi.setSystemTime(departure);
      post.mockImplementation((_url, body: { query: string }) =>
        body.query === PLAN_QUERY
          ? Promise.resolve(
              okResp([
                busItinerary("R1", later),
                busItinerary("R2", later),
                busItinerary("R3", later),
              ]),
            )
          : new Promise(() => undefined),
      );
      const pending = planOtpRouteDetailed(origin, destination, {
        departureTime: departure,
        transitPreference: "metro",
      });
      await vi.advanceTimersByTimeAsync(6_000);
      const result = await pending;
      expect(result.status).toBe("ok");
      expect(result.routes.map((r) => r.routeName)).toEqual(["R1", "R2", "R3"]);
    } finally {
      vi.useRealTimers();
    }
  });
});
