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
  planOtpRouteDetailed,
} from "./otp-routing";

const origin = { lat: 25.041, lng: 121.565 };
const destination = { lat: 25.033, lng: 121.564 };

const otpGaveUp = {
  data: {
    errors: [
      {
        message:
          "Exception while fetching data (/plan) : TIMEOUT! The request is too resource intensive.",
      },
    ],
  },
};

const okResp = (
  itineraries: unknown[],
  routingErrors: { code: string }[] = [],
) => ({
  data: { data: { plan: { itineraries, routingErrors } } },
});

const transitItinerary = (
  routeName: string,
  startTime = 1_000,
  durationSec = 600,
) => ({
  duration: durationSec,
  walkDistance: 0,
  legs: [
    {
      mode: "BUS",
      startTime,
      endTime: startTime + durationSec * 1_000,
      duration: durationSec,
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

const overTransferItinerary = (startTime: number) => {
  const first = transitItinerary("SNAP_BAD_1", startTime, 600) as any;
  const second = transitItinerary(
    "SNAP_BAD_2",
    startTime + 660_000,
    600,
  ) as any;
  return {
    duration: 1_260,
    walkDistance: 0,
    legs: [...first.legs, ...second.legs],
  };
};

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
    const requested = [...PLAN_QUERY.matchAll(/\{ mode: (\w+) \}/g)].map(
      (m) => m[1],
    );
    expect(new Set(requested)).toEqual(
      new Set([
        "WALK",
        "BUS",
        "TROLLEYBUS",
        "RAIL",
        "SUBWAY",
        "TRAM",
        "MONORAIL",
      ]),
    );
  });
});

describe("OTP PLAN_QUERY searchWindow", () => {
  it("declares and passes searchWindow", () => {
    expect(PLAN_QUERY).toContain("$searchWindow: Long");
    expect(PLAN_QUERY).toContain("searchWindow: $searchWindow");
  });

  it("declares and passes maxTransfers", () => {
    expect(PLAN_QUERY).toContain("$maxTransfers: Int");
    expect(PLAN_QUERY).toContain("maxTransfers: $maxTransfers");
  });

  it("requests routing error codes used by the continuation ladder", () => {
    expect(PLAN_QUERY).toContain("routingErrors { code }");
  });

  it("requests and maps step.feature StairsUse on transit-plan walk legs", async () => {
    const withStairs = transitItinerary("R1") as any;
    withStairs.legs.unshift({
      mode: "WALK",
      startTime: 0,
      endTime: 1_000,
      duration: 1,
      distance: 20,
      from: { name: "Origin" },
      to: { name: "起站" },
      legGeometry: { points: "" },
      steps: [
        {
          distance: 20,
          lon: 121.565,
          lat: 25.041,
          relativeDirection: "CONTINUE",
          absoluteDirection: "NORTH",
          streetName: "圓山市景步道",
          area: false,
          bogusName: false,
          feature: { __typename: "StairsUse" },
        },
      ],
    });
    post.mockResolvedValue(
      okResp([withStairs, transitItinerary("R2"), transitItinerary("R3")]),
    );

    const routes = await planOtpRoute(origin, destination);

    const walkLeg = routes.find((route) => route.routeName === "R1")?.legs[0];
    expect(PLAN_QUERY).toContain("feature { __typename }");
    expect(walkLeg?.type).toBe("WALK");
    expect(walkLeg?.type === "WALK" && walkLeg.steps?.[0].stairs).toBe(true);
  });
});

describe("OTP BUS leg sub-route identity", () => {
  it("retains absolute boarding time and access-walk completion without exposing internal metadata", async () => {
    const departure = new Date("2030-01-01T09:00:00+08:00");
    const boardAt = new Date("2030-01-01T10:00:00+08:00").getTime();
    const walkEnds = departure.getTime() + 10 * 60_000;
    const bus = transitItinerary("PLANNED", boardAt);
    const walk = walkOnlyItinerary().legs[0];
    post.mockResolvedValue(
      okResp([
        {
          ...bus,
          duration: 70 * 60,
          legs: [
            { ...walk, startTime: departure.getTime(), endTime: walkEnds },
            ...bus.legs,
          ],
        },
      ]),
    );
    const routes = await planOtpRoute(origin, destination, {
      departureTime: departure,
    });
    const leg = routes.flatMap((r) => r.legs).find((l) => l.type === "BUS");
    expect(leg).toMatchObject({
      departureTime: "10:00",
      _scheduledDepartureTime: boardAt,
      _boardingReadyTime: walkEnds,
      _scheduledTripId: "PLANNED_trip",
    });
    expect(JSON.stringify(leg)).not.toContain("_boardingReadyTime");
    expect(JSON.stringify(leg)).not.toContain("_scheduledTripId");
    expect(JSON.stringify(leg)).not.toContain("_scheduledDepartureTime");
  });

  it("maps the scheduled GTFS sub-route UID and name onto the BUS leg", async () => {
    const itineraries = threeDistinctTransitItineraries();
    itineraries[0].legs[0].route.gtfsId = "1:TPE3070_0";
    itineraries[0].legs[0].route.longName = "307 往撫遠街";
    post.mockResolvedValue(okResp(itineraries));

    const routes = await planOtpRoute(origin, destination);
    const busLeg = routes.find((route) => route.routeName === "R1")?.legs[0];

    expect(busLeg).toMatchObject({
      type: "BUS",
      subRouteUid: "TPE3070",
      subRouteName: "307 往撫遠街",
    });
  });

  it("uses the GTFS route suffix as TDX direction even when trip direction disagrees", async () => {
    const itineraries = threeDistinctTransitItineraries();
    itineraries[0].legs[0].route.gtfsId = "1:TXG7_1";
    tripLean.mockResolvedValue([{ tripId: "R1_trip", directionId: 0 }]);
    post.mockResolvedValue(okResp(itineraries));

    const routes = await planOtpRoute(origin, destination);
    const busLeg = routes.find((route) => route.routeName === "R1")?.legs[0];

    expect(busLeg).toMatchObject({
      type: "BUS",
      subRouteUid: "TXG7",
      direction: 1,
    });
  });
});

// The OTP `wheelchair` flag is step-free routing, so it must follow the caller's
// avoidStairs constraint — not the accessibility mode, which only tunes scoring.
describe("planOtpRoute wheelchair flag follows avoidStairs", () => {
  beforeEach(() => {
    post.mockResolvedValue(okResp(threeDistinctTransitItineraries()));
  });

  it("defaults to mode === wheelchair when avoidStairs is omitted", async () => {
    await planOtpRoute(origin, destination, { mode: "wheelchair" });
    expect(post.mock.calls[0][1].variables.wheelchair).toBe(true);

    post.mockClear();
    await planOtpRoute(origin, destination, { mode: "elderly" });
    expect(post.mock.calls[0][1].variables.wheelchair).toBe(false);
  });

  it("turns step-free routing on for a non-wheelchair mode", async () => {
    await planOtpRoute(origin, destination, {
      mode: "elderly",
      avoidStairs: true,
    });
    expect(post.mock.calls[0][1].variables.wheelchair).toBe(true);
  });

  it("lets an explicit false override wheelchair mode", async () => {
    await planOtpRoute(origin, destination, {
      mode: "wheelchair",
      avoidStairs: false,
    });
    expect(post.mock.calls[0][1].variables.wheelchair).toBe(false);
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

  it("caps OTP's own search at the requested transfers, counted as rides", async () => {
    post
      .mockResolvedValueOnce(okResp([]))
      .mockResolvedValueOnce(okResp(threeDistinctTransitItineraries()));

    await planOtpRoute(origin, destination, { maxTransfers: 1 });

    expect(post).toHaveBeenCalledTimes(2);
    expect(
      post.mock.calls.map((call) => call[1].variables.maxTransfers),
    ).toEqual([2, 2]);
  });

  it("leaves OTP's transfer default alone without a cap", async () => {
    post.mockResolvedValueOnce(okResp(threeDistinctTransitItineraries()));

    await planOtpRoute(origin, destination);

    expect(post.mock.calls[0][1].variables).not.toHaveProperty(
      "maxTransfers",
      expect.anything(),
    );
  });

  it("retries an empty narrow result with the wide window", async () => {
    post
      .mockResolvedValueOnce(okResp([]))
      .mockResolvedValueOnce(okResp(threeDistinctTransitItineraries()));

    await planOtpRoute(origin, destination);

    expect(post).toHaveBeenCalledTimes(2);
    expect(post.mock.calls[1][1].variables).toMatchObject({
      numItineraries: 15,
      searchWindow: 7200,
    });
  });

  it("skips the diversity widening after a slow primary that already has a route", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    post.mockImplementationOnce(async () => {
      vi.setSystemTime(new Date(Date.now() + 7_000));
      return okResp([transitItinerary("R1")]);
    });

    const routes = await planOtpRoute(origin, destination);
    vi.useRealTimers();

    expect(post).toHaveBeenCalledTimes(1);
    expect(routes.map((route) => route.routeName)).toEqual(["R1"]);
  });

  it("still widens after a slow primary without a usable route", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    post
      .mockImplementationOnce(async () => {
        vi.setSystemTime(new Date(Date.now() + 7_000));
        return okResp([]);
      })
      .mockResolvedValueOnce(okResp(threeDistinctTransitItineraries()));

    await planOtpRoute(origin, destination);
    vi.useRealTimers();

    expect(post.mock.calls[1][1].variables.searchWindow).toBe(7200);
  });

  it("keeps a usable narrow route when the wide result is empty", async () => {
    post
      .mockResolvedValueOnce(okResp([transitItinerary("R1")]))
      .mockResolvedValueOnce(okResp([]));

    const routes = await planOtpRoute(origin, destination);

    expect(post).toHaveBeenCalledTimes(2);
    expect(routes.map((route) => route.routeName)).toEqual(["R1"]);
  });

  it("keeps a usable narrow route when the wide query times out", async () => {
    post
      .mockResolvedValueOnce(okResp([transitItinerary("R1")]))
      .mockRejectedValueOnce({ code: "ECONNABORTED" });

    const result = await planOtpRouteDetailed(origin, destination);

    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.routes.map((route) => route.routeName)).toEqual(["R1"]);
    expect(post).toHaveBeenCalledTimes(2);
  });

  it("continues to the next service day and preserves absolute schedule semantics", async () => {
    const departureTime = new Date("2030-01-01T13:51:00.000Z");
    const scheduledDeparture = new Date("2030-01-01T22:20:00.000Z").getTime();
    const noTransit = [{ code: "NO_TRANSIT_CONNECTION_IN_SEARCH_WINDOW" }];
    post
      .mockResolvedValueOnce(okResp([], noTransit))
      .mockResolvedValueOnce(okResp([], noTransit))
      .mockResolvedValueOnce(
        okResp([transitItinerary("NEXT", scheduledDeparture, 2_400)]),
      );

    const routes = await planOtpRoute(origin, destination, { departureTime });

    expect(post).toHaveBeenCalledTimes(3);
    expect(post.mock.calls[2][1].variables).toMatchObject({
      date: "2030-01-01",
      time: "23:51",
      searchWindow: 28800,
    });
    expect(routes[0].departureDate).toBe("2030-01-02");
    expect(routes[0]._scheduledDepartureTime).toBe(scheduledDeparture);
    expect(routes[0]._scheduledEndTime).toBe(scheduledDeparture + 2_400_000);
    expect(routes[0]._isFutureScheduled).toBe(true);
    expect(routes[0].legs[0]).toMatchObject({
      type: "BUS",
      departureTime: "06:20",
      waitInfo: { time: "06:20", source: "schedule" },
    });
    expect(routes[0].legs[0]).not.toHaveProperty("estimatedWaitMinutes");
    expect(JSON.stringify(routes[0])).not.toContain("_scheduledDepartureTime");
  });

  it("continues later on the same day without adding departureDate", async () => {
    const departureTime = new Date("2029-12-31T18:00:00.000Z");
    const scheduledDeparture = new Date("2030-01-01T06:00:00.000Z").getTime();
    const noTransit = [{ code: "NO_TRANSIT_CONNECTION_IN_SEARCH_WINDOW" }];
    post
      .mockResolvedValueOnce(okResp([], noTransit))
      .mockResolvedValueOnce(okResp([], noTransit))
      .mockResolvedValueOnce(
        okResp([transitItinerary("LATER", scheduledDeparture, 1_800)]),
      );

    const routes = await planOtpRoute(origin, destination, { departureTime });

    expect(post.mock.calls[2][1].variables).toMatchObject({
      date: "2030-01-01",
      time: "04:00",
    });
    expect(routes[0].departureDate).toBeUndefined();
    expect(routes[0]._scheduledDepartureTime).toBe(scheduledDeparture);
    expect(routes[0].legs[0]).toMatchObject({
      type: "BUS",
      departureTime: "14:00",
    });
    expect(routes[0].legs[0]).not.toHaveProperty("estimatedWaitMinutes");
  });

  it("retains the earliest continuation when stairs ranking would drop it", async () => {
    const departureTime = new Date("2030-01-01T13:51:00.000Z");
    const firstDeparture = new Date("2030-01-01T22:20:00.000Z").getTime();
    const noTransit = [{ code: "NO_TRANSIT_CONNECTION_IN_SEARCH_WINDOW" }];
    const earliest = transitItinerary("EARLY", firstDeparture) as any;
    earliest.legs.unshift({
      mode: "WALK",
      startTime: firstDeparture - 60_000,
      endTime: firstDeparture,
      duration: 60,
      distance: 20,
      from: { name: "Origin" },
      to: { name: "起站" },
      legGeometry: { points: "" },
      steps: [
        {
          distance: 20,
          lon: 121.565,
          lat: 25.041,
          relativeDirection: "CONTINUE",
          absoluteDirection: "NORTH",
          streetName: "樓梯",
          area: false,
          bogusName: false,
          feature: { __typename: "StairsUse" },
        },
      ],
    });
    const continuationRoutes = [
      earliest,
      transitItinerary("LATE1", firstDeparture + 60_000),
      transitItinerary("LATE2", firstDeparture + 120_000),
      transitItinerary("LATE3", firstDeparture + 180_000),
    ];
    post
      .mockResolvedValueOnce(okResp([], noTransit))
      .mockResolvedValueOnce(okResp([], noTransit))
      .mockResolvedValueOnce(okResp(continuationRoutes));

    const routes = await planOtpRoute(origin, destination, {
      departureTime,
      avoidStairs: true,
      limit: 3,
    });

    expect(routes).toHaveLength(3);
    expect(routes[0].routeName).toBe("EARLY");
  });

  it("pins the continuation route that arrives first and keeps first-leg departure semantics", async () => {
    const departureTime = new Date("2030-01-01T13:51:00.000Z");
    const routeStart = new Date("2030-01-01T22:20:00.000Z").getTime();
    const noTransit = [{ code: "NO_TRANSIT_CONNECTION_IN_SEARCH_WINDOW" }];
    const earlyRoute = transitItinerary(
      "EARLY_START",
      routeStart + 17 * 60_000,
    ) as any;
    earlyRoute.duration = 2_400;
    earlyRoute.legs.unshift({
      mode: "WALK",
      startTime: routeStart,
      endTime: routeStart + 17 * 60_000,
      duration: 17 * 60,
      distance: 1_000,
      from: { name: "Origin" },
      to: { name: "起站" },
      legGeometry: { points: "" },
      steps: [],
    });
    const earlierBusLaterStart = transitItinerary(
      "EARLIER_BUS",
      routeStart + 5 * 60_000,
    );
    post
      .mockResolvedValueOnce(okResp([], noTransit))
      .mockResolvedValueOnce(okResp([], noTransit))
      .mockResolvedValueOnce(okResp([earlierBusLaterStart, earlyRoute]));

    const routes = await planOtpRoute(origin, destination, { departureTime });

    // EARLY_START leaves first (walk at 06:20) but its bus arrives at 06:47;
    // EARLIER_BUS arrives at 06:35, so it takes the pinned slot.
    expect(routes[0].routeName).toBe("EARLIER_BUS");
    const earlyStart = routes.find((r) => r.routeName === "EARLY_START");
    expect(earlyStart?._scheduledDepartureTime).toBe(routeStart);
    expect(earlyStart?.legs.find((leg) => leg.type === "BUS")).toMatchObject({
      departureTime: "06:37",
    });
  });

  it("continues after an error-free snap result contains only over-transfer itineraries", async () => {
    const departureTime = new Date("2030-01-01T13:51:00.000Z");
    const scheduledDeparture = new Date("2030-01-01T22:20:00.000Z").getTime();
    busLean.mockResolvedValue([
      {
        location: { coordinates: [121.566, 25.042] },
        stopName: { Zh_tw: "接駁站" },
      },
    ]);
    post
      .mockResolvedValueOnce(okResp([]))
      .mockResolvedValueOnce(okResp([]))
      .mockResolvedValueOnce(
        okResp([overTransferItinerary(scheduledDeparture)], []),
      )
      .mockResolvedValueOnce(
        okResp([transitItinerary("ORIGINAL", scheduledDeparture, 2_400)]),
      );

    const routes = await planOtpRoute(origin, destination, {
      departureTime,
      maxTransfers: 0,
    });

    expect(post).toHaveBeenCalledTimes(4);
    expect(post.mock.calls[2][1].variables).toMatchObject({
      fromLat: 25.042,
      fromLon: 121.566,
      toLat: 25.042,
      toLon: 121.566,
    });
    expect(post.mock.calls[3][1].variables).toMatchObject({
      fromLat: origin.lat,
      fromLon: origin.lng,
      toLat: destination.lat,
      toLon: destination.lng,
      date: "2030-01-01",
      time: "23:51",
    });
    expect(routes[0].routeName).toBe("ORIGINAL");
    expect(routes[0].legs[0]).toMatchObject({ type: "BUS" });
    expect(routes[0].legs.at(-1)).toMatchObject({ type: "BUS" });
  });

  it("tries original coordinates before snapped coordinates at one continuation anchor", async () => {
    const departureTime = new Date("2030-01-01T13:51:00.000Z");
    const scheduledDeparture = new Date("2030-01-01T22:20:00.000Z").getTime();
    const noTransit = [{ code: "NO_TRANSIT_CONNECTION_IN_SEARCH_WINDOW" }];
    busLean.mockResolvedValue([
      {
        location: { coordinates: [121.566, 25.042] },
        stopName: { Zh_tw: "接駁站" },
      },
    ]);
    // No routing error from the first two queries: OTP did not say transit
    // connects these endpoints, so the snapped endpoints stay in play.
    post
      .mockResolvedValueOnce(okResp([]))
      .mockResolvedValueOnce(okResp([]))
      .mockResolvedValueOnce(
        okResp([overTransferItinerary(scheduledDeparture)], []),
      )
      .mockResolvedValueOnce(okResp([], noTransit))
      .mockResolvedValueOnce(
        okResp([transitItinerary("SNAPPED", scheduledDeparture, 2_400)]),
      );

    const routes = await planOtpRoute(origin, destination, {
      departureTime,
      maxTransfers: 0,
    });

    expect(post).toHaveBeenCalledTimes(5);
    expect(post.mock.calls[3][1].variables).toMatchObject({
      fromLat: origin.lat,
      fromLon: origin.lng,
      toLat: destination.lat,
      toLon: destination.lng,
      date: "2030-01-01",
      time: "23:51",
    });
    expect(post.mock.calls[4][1].variables).toMatchObject({
      fromLat: 25.042,
      fromLon: 121.566,
      toLat: 25.042,
      toLon: 121.566,
      date: "2030-01-01",
      time: "23:51",
    });
    expect(routes[0].legs[0]).toMatchObject({ type: "WALK", from: "出發地" });
    expect(routes[0].legs.at(-1)).toMatchObject({ type: "WALK", to: "目的地" });
    expect(routes[0]._scheduledEndTime).toBeGreaterThan(
      scheduledDeparture + 2_400_000,
    );
  });

  it("skips the stop snap when OTP reports service only outside the window", async () => {
    const departureTime = new Date("2030-01-01T17:00:00.000Z");
    const scheduledDeparture = new Date("2030-01-01T20:50:00.000Z").getTime();
    const outsideWindow = [{ code: "NO_TRANSIT_CONNECTION_IN_SEARCH_WINDOW" }];
    busLean.mockResolvedValue([
      {
        location: { coordinates: [121.566, 25.042] },
        stopName: { Zh_tw: "接駁站" },
      },
    ]);
    post
      .mockResolvedValueOnce(okResp([], outsideWindow))
      .mockResolvedValueOnce(okResp([], outsideWindow))
      .mockResolvedValueOnce(
        okResp([transitItinerary("FIRST", scheduledDeparture, 2_400)]),
      );
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    const routes = await planOtpRoute(origin, destination, { departureTime });

    expect(busLean).not.toHaveBeenCalled();
    expect(post).toHaveBeenCalledTimes(3);
    expect(post.mock.calls[2][1].variables).toMatchObject({
      fromLat: origin.lat,
      fromLon: origin.lng,
      searchWindow: 28800,
    });
    expect(routes[0].routeName).toBe("FIRST");
    const timing = log.mock.calls.find(
      (call) => call[0] === "[route-timing] otp",
    );
    expect(JSON.parse(timing?.[1] as string)).toMatchObject({
      snapSkipped: 1,
      continuationQueries: 1,
      otpContinuation: expect.any(Number),
    });
    log.mockRestore();
  });

  it("reports unavailable when a continuation timeout leaves no usable route", async () => {
    const noTransit = [{ code: "NO_TRANSIT_CONNECTION_IN_SEARCH_WINDOW" }];
    post
      .mockResolvedValueOnce(okResp([], noTransit))
      .mockResolvedValueOnce(okResp([], noTransit))
      .mockRejectedValueOnce({ code: "ETIMEDOUT" });

    await expect(planOtpRouteDetailed(origin, destination)).resolves.toEqual({
      status: "unavailable",
      routes: [],
    });
    expect(post).toHaveBeenCalledTimes(3);
  });

  it("keeps a usable walk fallback when a continuation times out", async () => {
    const noTransit = [{ code: "NO_TRANSIT_CONNECTION_IN_SEARCH_WINDOW" }];
    post
      .mockResolvedValueOnce(okResp([walkOnlyItinerary()], noTransit))
      .mockResolvedValueOnce(okResp([], noTransit))
      .mockRejectedValueOnce({ code: "ETIMEDOUT" });

    const result = await planOtpRouteDetailed(origin, destination);

    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.routes).toHaveLength(1);
    expect(result.routes[0].routeName).toBe("步行路線");
  });

  it("reports no_route after successful queries produce no usable itinerary", async () => {
    post.mockResolvedValue(okResp([]));

    await expect(planOtpRouteDetailed(origin, destination)).resolves.toEqual({
      status: "no_route",
      routes: [],
    });
  });

  it("reports successful routes and keeps the array wrapper compatible", async () => {
    post.mockResolvedValue(okResp(threeDistinctTransitItineraries()));

    const detailed = await planOtpRouteDetailed(origin, destination);

    expect(detailed.status).toBe("ok");
    if (detailed.status !== "ok") return;
    await expect(planOtpRoute(origin, destination)).resolves.toEqual(
      detailed.routes,
    );
  });

  it("stops the continuation ladder at the absolute 24-hour horizon", async () => {
    const noTransit = [{ code: "NO_TRANSIT_CONNECTION_IN_SEARCH_WINDOW" }];
    post.mockResolvedValue(okResp([], noTransit));

    await expect(planOtpRoute(origin, destination)).resolves.toEqual([]);

    expect(post).toHaveBeenCalledTimes(5);
    expect(
      post.mock.calls.map((call) => call[1].variables.searchWindow),
    ).toEqual([3600, 7200, 28800, 28800, 21600]);
    expect(post.mock.calls[2][1].variables.time).not.toBe(
      post.mock.calls[3][1].variables.time,
    );
  });

  it("retries a WALK-only narrow result with the wide window", async () => {
    post
      .mockResolvedValueOnce(okResp([walkOnlyItinerary()]))
      .mockResolvedValueOnce(okResp(threeDistinctTransitItineraries()));

    await planOtpRoute(origin, destination);

    expect(post).toHaveBeenCalledTimes(2);
    expect(post.mock.calls[1][1].variables.searchWindow).toBe(7200);
  });

  it("settles on the walk itinerary when OTP reports walking is better", async () => {
    busLean.mockResolvedValue([
      {
        location: { coordinates: [121.565, 25.041] },
        stopName: { Zh_tw: "公車站" },
      },
    ]);
    post.mockResolvedValue(
      okResp([walkOnlyItinerary()], [{ code: "WALKING_BETTER_THAN_TRANSIT" }]),
    );

    const result = await planOtpRouteDetailed(origin, destination, {
      mode: "wheelchair",
    });

    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.routes.map((route) => route.routeName)).toEqual(["步行路線"]);
    expect(post).toHaveBeenCalledTimes(1);
  });

  it("skips every optional stage once the request budget is spent", async () => {
    busLean.mockResolvedValue([
      {
        location: { coordinates: [121.565, 25.041] },
        stopName: { Zh_tw: "公車站" },
      },
    ]);
    post.mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, 30));
      return okResp([]);
    });

    const result = await planOtpRouteDetailed(origin, destination, {
      deadline: Date.now() + 10,
    });

    // Only the primary query ran: no widening, stop snap or later service.
    expect(result).toEqual({ status: "no_route", routes: [] });
    expect(post).toHaveBeenCalledTimes(1);
  });

  it("does not plan at all when the request budget is already spent", async () => {
    const result = await planOtpRouteDetailed(origin, destination, {
      deadline: Date.now() - 1,
    });

    expect(result).toEqual({ status: "unavailable", routes: [] });
    expect(post).not.toHaveBeenCalled();
  });

  it("caps optional stages at the remaining budget", async () => {
    busLean.mockResolvedValue([
      {
        location: { coordinates: [121.565, 25.041] },
        stopName: { Zh_tw: "公車站" },
      },
    ]);
    post.mockResolvedValue(okResp([]));

    await planOtpRouteDetailed(origin, destination, {
      deadline: Date.now() + 5_000,
    });

    // The primary keeps the client default; later stages get at most 5 s.
    expect(post.mock.calls[0][2]).toBeUndefined();
    const later = post.mock.calls.slice(1);
    expect(later.length).toBeGreaterThan(0);
    for (const call of later) {
      expect(call[2]?.timeout).toBeGreaterThan(0);
      expect(call[2]?.timeout).toBeLessThanOrEqual(5_000);
    }
  });

  it("reports OTP's own walking-is-better verdict", async () => {
    post.mockResolvedValue(
      okResp([walkOnlyItinerary()], [{ code: "WALKING_BETTER_THAN_TRANSIT" }]),
    );

    const result = await planOtpRouteDetailed(origin, destination, {
      mode: "wheelchair",
    });

    expect(result).toMatchObject({ status: "ok", walkingBetter: true });
  });

  it("does not call a walk-only answer better when OTP found no transit", async () => {
    busLean.mockResolvedValue([]);
    post.mockResolvedValue(okResp([walkOnlyItinerary()]));

    const result = await planOtpRouteDetailed(origin, destination);

    expect(result.status).toBe("ok");
    expect(result).not.toHaveProperty("walkingBetter");
  });

  it("keeps searching when walking is better but no walk itinerary is usable", async () => {
    post.mockResolvedValue(
      okResp([], [{ code: "WALKING_BETTER_THAN_TRANSIT" }]),
    );

    await planOtpRouteDetailed(origin, destination);

    expect(post.mock.calls.length).toBeGreaterThan(1);
  });

  it("returns a WALK-only itinerary when no transit result replaces it", async () => {
    post
      .mockResolvedValueOnce(okResp([walkOnlyItinerary()]))
      .mockResolvedValueOnce(okResp([]));

    const routes = await planOtpRoute(origin, destination);

    expect(routes).toHaveLength(1);
    expect(routes[0]).toMatchObject({
      routeName: "步行路線",
      transferCount: 0,
    });
    expect(routes[0].legs).toHaveLength(1);
    expect(routes[0].legs[0]).toMatchObject({ type: "WALK" });
  });

  it("reports unavailable immediately after a primary timeout", async () => {
    post.mockRejectedValueOnce({ code: "ECONNABORTED" });

    await expect(planOtpRouteDetailed(origin, destination)).resolves.toEqual({
      status: "unavailable",
      routes: [],
    });
    expect(post).toHaveBeenCalledTimes(1);
  });

  it("does not escalate after OTP abandons the primary query at its processing timeout", async () => {
    post.mockResolvedValueOnce(otpGaveUp);

    await expect(planOtpRouteDetailed(origin, destination)).resolves.toEqual({
      status: "unavailable",
      routes: [],
    });
    expect(post).toHaveBeenCalledTimes(1);
  });

  it.each(["LOCATION_NOT_FOUND", "OUTSIDE_BOUNDS"])(
    "returns no_route for terminal routing error %s without a usable itinerary",
    async (code) => {
      post.mockResolvedValueOnce(okResp([], [{ code }]));

      await expect(planOtpRouteDetailed(origin, destination)).resolves.toEqual({
        status: "no_route",
        routes: [],
      });
      expect(post).toHaveBeenCalledTimes(1);
    },
  );

  it("returns a usable itinerary that accompanies a terminal routing error", async () => {
    post.mockResolvedValueOnce(
      okResp([transitItinerary("R1")], [{ code: "LOCATION_NOT_FOUND" }]),
    );

    const result = await planOtpRouteDetailed(origin, destination);

    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.routes.map((route) => route.routeName)).toEqual(["R1"]);
    expect(post).toHaveBeenCalledTimes(1);
  });

  it("returns a walk fallback that accompanies a terminal routing error", async () => {
    post.mockResolvedValueOnce(
      okResp([walkOnlyItinerary()], [{ code: "LOCATION_NOT_FOUND" }]),
    );

    const result = await planOtpRouteDetailed(origin, destination);

    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.routes.map((route) => route.routeName)).toEqual(["步行路線"]);
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

  it("reports unavailable only after a wide timeout when later queries leave no usable route", async () => {
    post
      .mockResolvedValueOnce(okResp([]))
      .mockRejectedValueOnce({ code: "ECONNABORTED" })
      .mockRejectedValueOnce({ code: "ECONNABORTED" });

    await expect(planOtpRouteDetailed(origin, destination)).resolves.toEqual({
      status: "unavailable",
      routes: [],
    });
    expect(post).toHaveBeenCalledTimes(3);
  });

  it("reports unavailable after a snap retry timeout leaves no usable output", async () => {
    busLean.mockResolvedValue([
      {
        location: { coordinates: [121.565, 25.041] },
        stopName: { Zh_tw: "公車站" },
      },
    ]);
    post
      .mockResolvedValueOnce(okResp([]))
      .mockResolvedValueOnce(okResp([]))
      .mockRejectedValueOnce({ code: "ETIMEDOUT" });

    await expect(planOtpRouteDetailed(origin, destination)).resolves.toEqual({
      status: "unavailable",
      routes: [],
    });
    expect(post).toHaveBeenCalledTimes(3);
  });

  it("keeps a walk fallback when the snap retry times out", async () => {
    busLean.mockResolvedValue([
      {
        location: { coordinates: [121.565, 25.041] },
        stopName: { Zh_tw: "公車站" },
      },
    ]);
    post
      .mockResolvedValueOnce(okResp([walkOnlyItinerary()]))
      .mockResolvedValueOnce(okResp([]))
      .mockRejectedValueOnce({ code: "ETIMEDOUT" });

    const result = await planOtpRouteDetailed(origin, destination);

    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.routes.map((route) => route.routeName)).toEqual(["步行路線"]);
    expect(post).toHaveBeenCalledTimes(3);
  });

  it("still tries snapped endpoints after OTP abandons the primary query", async () => {
    busLean.mockResolvedValue([
      {
        location: { coordinates: [121.565, 25.041] },
        stopName: { Zh_tw: "公車站" },
      },
    ]);
    post
      .mockResolvedValueOnce(otpGaveUp)
      .mockResolvedValueOnce(okResp(threeDistinctTransitItineraries()));

    await expect(planOtpRoute(origin, destination)).resolves.toHaveLength(3);
    expect(post).toHaveBeenCalledTimes(2);
    expect(post.mock.calls[1][1].variables.searchWindow).toBe(3600);
  });

  it("does not continue to later service after OTP abandons the wide query", async () => {
    const noTransit = [{ code: "NO_TRANSIT_CONNECTION_IN_SEARCH_WINDOW" }];
    post
      .mockResolvedValueOnce(okResp([], noTransit))
      .mockResolvedValueOnce(otpGaveUp)
      .mockResolvedValue(okResp([], noTransit));

    await expect(planOtpRouteDetailed(origin, destination)).resolves.toEqual({
      status: "unavailable",
      routes: [],
    });
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

  it("advances continuation from the narrow window after a non-timeout wide error", async () => {
    const departureTime = new Date("2030-01-01T13:51:00.000Z");
    const noTransit = [{ code: "NO_TRANSIT_CONNECTION_IN_SEARCH_WINDOW" }];
    const scheduledDeparture = new Date("2030-01-01T15:20:00.000Z").getTime();
    post
      .mockResolvedValueOnce(okResp([], noTransit))
      .mockRejectedValueOnce({ code: "ERR_BAD_RESPONSE" })
      .mockResolvedValueOnce(
        okResp([transitItinerary("AFTER_GAP", scheduledDeparture)]),
      );

    const routes = await planOtpRoute(origin, destination, { departureTime });

    expect(routes[0].routeName).toBe("AFTER_GAP");
    expect(post.mock.calls[2][1].variables).toMatchObject({
      date: "2030-01-01",
      time: "22:51",
      searchWindow: 28800,
    });
  });

  it("never counts a stage cut short by the request budget as an OTP outage", async () => {
    vi.resetModules();
    const isolatedPost = vi.fn(
      async (_url: string, _body: unknown, config?: { timeout?: number }) => {
        if (config?.timeout) {
          await new Promise((resolve) => setTimeout(resolve, config.timeout));
          throw { code: "ECONNABORTED" };
        }
        return okResp([]);
      },
    );
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
    for (let i = 0; i < 4; i += 1) {
      // Wide enough that the instant primary never spends it under load,
      // short enough that the capped stages are what times out.
      await isolatedOtpRouting.planOtpRouteDetailed(origin, destination, {
        deadline: Date.now() + 400,
      });
    }

    expect(isolatedPost.mock.calls.some((call) => call[2]?.timeout)).toBe(true);
    expect(isolatedOtpRouting.isOtpCircuitOpen()).toBe(false);

    vi.doUnmock("axios");
    vi.resetModules();
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
    await expect(
      isolatedOtpRouting.planOtpRouteDetailed(origin, destination),
    ).resolves.toEqual({ status: "unavailable", routes: [] });
    expect(isolatedPost).toHaveBeenCalledTimes(6);

    vi.doUnmock("axios");
    vi.resetModules();
  });

  it.each([
    "Processing timeout",
    "Exception while fetching data (/plan) : TIMEOUT! The request is too resource intensive.",
  ])(
    "does not open the breaker when OTP answers queries with %s",
    async (message) => {
      vi.resetModules();
      const isolatedPost = vi.fn().mockResolvedValue({
        data: { errors: [{ message }] },
      });
      vi.doMock("axios", () => ({
        default: {
          create: () => ({ post: isolatedPost }),
          isAxiosError: () => false,
        },
      }));

      const isolatedOtpRouting = await import("./otp-routing");
      for (let i = 0; i < 4; i += 1) {
        await isolatedOtpRouting.planOtpRouteDetailed(origin, destination);
      }

      expect(isolatedOtpRouting.isOtpCircuitOpen()).toBe(false);

      vi.doUnmock("axios");
      vi.resetModules();
    },
  );

  it("opens the breaker after consecutive HTTP 5xx answers", async () => {
    vi.resetModules();
    const isolatedPost = vi
      .fn()
      .mockRejectedValue({ response: { status: 503 } });
    vi.doMock("axios", () => ({
      default: {
        create: () => ({ post: isolatedPost }),
        isAxiosError: () => false,
      },
    }));

    const isolatedOtpRouting = await import("./otp-routing");
    for (let i = 0; i < 3; i += 1) {
      await isolatedOtpRouting.planOtpRouteDetailed(origin, destination);
    }

    expect(isolatedOtpRouting.isOtpCircuitOpen()).toBe(true);

    vi.doUnmock("axios");
    vi.resetModules();
  });
});
