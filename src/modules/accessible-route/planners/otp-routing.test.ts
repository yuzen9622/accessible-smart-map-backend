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

describe("OTP metro line names", () => {
  it.each([
    ["TRTC_BL_BL-1_1", "南港展覽館－頂埔", "BL", "板南線", 1],
    ["TRTC_BL_BL-1_0", "頂埔－南港展覽館", "BL", "板南線", 0],
    ["TRTC_R_R-1_0", "淡水－象山", "R", "淡水信義線", 0],
    ["TRTC_R_R-2_1", "大安－北投", "R", "淡水信義線", 1],
    ["TRTC_G_G-1_0", "松山－新店", "G", "松山新店線", 0],
    ["TRTC_O_O-1_0", "南勢角－迴龍", "O", "中和新蘆線", 0],
    ["TRTC_BR_BR-1_0", "動物園－南港展覽館", "BR", "文湖線", 0],
    ["TRTC_R_R-3_0", "北投－新北投", "R", "新北投支線", 0],
    ["TRTC_R_R-3_1", "新北投－北投", "R", "新北投支線", 1],
    ["TRTC_G_G-3_0", "七張－小碧潭", "G", "小碧潭支線", 0],
    ["TRTC_G_G-3_1", "小碧潭－七張", "G", "小碧潭支線", 1],
    ["NTMC_Y_Y-1_0", "大坪林－新北產業園區", "Y", "環狀線", 0],
    ["NTMC_Y_Y-1_1", "新北產業園區－大坪林", "Y", "環狀線", 1],
    ["NTMC_LB", "原始三鶯路線名稱", "LB", "三鶯線", 0],
    ["TYMC_A_A-1_0", "台北車站－老街溪站", "A", "桃園機場捷運", 0],
    ["TYMC_A_A-2_1", "機場第二航廈站－台北車站", "A", "桃園機場捷運", 1],
    ["TYMC_A_A-3_1", "老街溪站－機場第一航廈站", "A", "桃園機場捷運", 1],
    ["NTDLRT_V_V-1_0", "紅樹林－崁頂", "V", "淡海輕軌綠山線", 0],
    ["NTDLRT_V_V-1_1", "崁頂－紅樹林", "V", "淡海輕軌綠山線", 1],
    ["NTDLRT_V_V-2_0", "紅樹林－淡水漁人碼頭", "V", "淡海輕軌藍海線", 0],
    ["NTDLRT_V_V-2_1", "淡水漁人碼頭－紅樹林", "V", "淡海輕軌藍海線", 1],
    ["NTDLRT_V", "原始淡海路線名稱", "V", "淡海輕軌", 0],
    ["NTALRT_K_K-1_0", "雙城－十四張", "K", "安坑輕軌", 0],
    ["NTALRT_K_K-1_1", "十四張－雙城", "K", "安坑輕軌", 1],
    ["NTALRT_K_K-2_0", "安康－十四張", "K", "安坑輕軌", 0],
    ["TRTC_BL_BL-1_1", "", "BL", "板南線", 1],
    ["NTMC_X_X-1_0", "未知新北路線名稱", "X", "未知新北路線名稱", 0],
    ["TMRT_G_G-1_0", "烏日文心北屯線", "G", "烏日文心北屯線", 0],
    ["KLRT_C_C_0", "高雄環狀輕軌", "C", "高雄環狀輕軌", 0],
    ["TRTCMG_MK_MK-1_0", "動物園－貓空", "MK", "貓空纜車", 0],
    ["TRTC_X_X-1_0", "原始路線名稱", "X", "原始路線名稱", 0],
    ["KRTC_R_R-1_0", "高雄紅線原始名稱", "R", "紅線", 0],
    ["KRTC_O_O_1", "橘線", "O", "橘線", 1],
  ])(
    "uses the line name for %s without changing trip details",
    async (routeId, sourceName, lineId, lineName, direction) => {
      const itinerary = transitItinerary(sourceName);
      const leg = itinerary.legs[0];
      leg.mode =
        routeId.startsWith("NTDLRT_") || routeId.startsWith("NTALRT_")
          ? "TRAM"
          : "SUBWAY";
      leg.route.gtfsId = `1:${routeId}`;
      leg.trip.gtfsId = `1:${routeId}_trip`;
      tripLean.mockResolvedValue([
        { tripId: `${routeId}_trip`, directionId: direction },
      ]);
      post.mockResolvedValue(okResp([itinerary]));

      const routes = await planOtpRoute(origin, destination, { limit: 1 });

      expect(routes).toHaveLength(1);
      expect(routes[0].routeName).toBe(lineName);
      expect(routes[0].legs[0]).toMatchObject({
        type: "METRO",
        lineId,
        lineName,
        lineUid: routeId,
        direction,
        departureStation: "起站",
        arrivalStation: "終站",
        rideMinutes: 10,
      });
    },
  );

  it("uses branch and main line names in the transfer summary", async () => {
    const branch = transitItinerary("新北投－北投");
    const main = transitItinerary("北投－象山", 661_000);
    branch.legs[0].mode = "SUBWAY";
    branch.legs[0].route.gtfsId = "1:TRTC_R_R-3_1";
    main.legs[0].mode = "SUBWAY";
    main.legs[0].route.gtfsId = "1:TRTC_R_R-1_1";
    post.mockResolvedValue(
      okResp([
        { ...branch, duration: 1_260, legs: [...branch.legs, ...main.legs] },
      ]),
    );

    const routes = await planOtpRoute(origin, destination, { limit: 1 });

    expect(routes[0].routeName).toBe("新北投支線 → 淡水信義線");
    expect(routes[0].transferCount).toBe(1);
    expect(routes[0].totalMinutes).toBe(21);
    expect(routes[0].legs).toMatchObject([
      { type: "METRO", lineName: "新北投支線", lineUid: "TRTC_R_R-3_1" },
      { type: "METRO", lineName: "淡水信義線", lineUid: "TRTC_R_R-1_1" },
    ]);
  });

  const metroItinerary = (
    routeId: string,
    stops: { gtfsId?: string; name?: string }[] | null | undefined,
    startTime = 1_000,
  ) => {
    const itinerary = transitItinerary("南港展覽館－頂埔", startTime);
    const leg = itinerary.legs[0] as (typeof itinerary.legs)[number] & {
      trip: { stops?: unknown };
    };
    leg.mode = "SUBWAY";
    leg.route.gtfsId = `1:${routeId}`;
    leg.trip.gtfsId = `1:${routeId}_trip`;
    leg.from = {
      name: "市政府",
      stop: { ...leg.from.stop, gtfsId: "1:TRTC_BL18" },
    };
    leg.to = {
      name: "台北車站",
      stop: { ...leg.to.stop, gtfsId: "1:TRTC_BL12" },
    };
    if (stops !== undefined) leg.trip.stops = stops;
    return itinerary;
  };

  it("requests feed English names for the boarding and alighting stops", () => {
    expect(PLAN_QUERY).toContain(
      'from { name stop { gtfsId code lat lon name nameEn: name(language: "en") } }',
    );
    expect(PLAN_QUERY).toContain(
      'to { name stop { gtfsId code lat lon name nameEn: name(language: "en") } }',
    );
  });

  it("requests the trip stop list so the terminal comes from the selected trip", () => {
    expect(PLAN_QUERY).toContain(
      'trip { gtfsId wheelchairAccessible stops { gtfsId name nameEn: name(language: "en") } }',
    );
  });

  it.each([
    ["full-length train", "TRTC_BL_BL-1_1", "板南線", "TRTC_BL01", "頂埔"],
    ["short-turn train", "TRTC_BL_BL-2_1", "板南線", "TRTC_BL05", "亞東醫院"],
    [
      "reverse direction",
      "TRTC_BL_BL-1_0",
      "板南線",
      "TRTC_BL23",
      "南港展覽館",
    ],
    ["main-line short turn", "TRTC_R_R-2_0", "淡水信義線", "TRTC_R28", "北投"],
    ["branch line", "TRTC_R_R-3_1", "新北投支線", "TRTC_R22", "北投"],
    ["cable car", "TRTCMG_MK_MK-1_0", "貓空纜車", "TRTCMG_MK04", "貓空"],
  ])(
    "keeps line name, trip terminal and alighting station apart (%s)",
    async (_case, routeId, lineName, terminalId, terminal) => {
      post.mockResolvedValue(
        okResp([
          metroItinerary(routeId, [
            { gtfsId: "1:TRTC_BL18", name: "市政府" },
            { gtfsId: "1:TRTC_BL12", name: "台北車站" },
            { gtfsId: `1:${terminalId}`, name: ` ${terminal} ` },
          ]),
        ]),
      );

      const [route] = await planOtpRoute(origin, destination, { limit: 1 });

      expect(route.legs[0]).toMatchObject({
        type: "METRO",
        lineName,
        terminalStation: terminal,
        terminalStationUid: terminalId,
        arrivalStation: "台北車站",
        arrivalStationUid: "TRTC_BL12",
      });
      expect(JSON.parse(JSON.stringify(route.legs[0]))).toMatchObject({
        terminalStation: terminal,
      });
    },
  );

  it.each([
    ["stop list missing", undefined],
    ["stop list null", null],
    ["stop list empty", []],
    ["terminal without a name", [{ gtfsId: "1:TRTC_BL01", name: "  " }]],
  ])("omits the terminal instead of guessing when %s", async (_case, stops) => {
    post.mockResolvedValue(okResp([metroItinerary("TRTC_BL_BL-1_1", stops)]));

    const [route] = await planOtpRoute(origin, destination, { limit: 1 });

    expect(route.legs[0]).toMatchObject({
      type: "METRO",
      lineName: "板南線",
      arrivalStation: "台北車站",
    });
    expect(route.legs[0]).not.toHaveProperty("terminalStation");
    expect(route.legs[0]).not.toHaveProperty("terminalStationUid");
  });

  it("gives each metro leg of a transfer its own trip terminal", async () => {
    const first = metroItinerary("TRTC_BL_BL-2_1", [
      { gtfsId: "1:TRTC_BL12", name: "台北車站" },
      { gtfsId: "1:TRTC_BL05", name: "亞東醫院" },
    ]);
    const second = metroItinerary(
      "TRTC_R_R-1_1",
      [
        { gtfsId: "1:TRTC_R10", name: "台北車站" },
        { gtfsId: "1:TRTC_R28", name: "淡水" },
      ],
      661_000,
    );
    post.mockResolvedValue(
      okResp([
        { ...first, duration: 1_260, legs: [...first.legs, ...second.legs] },
      ]),
    );

    const [route] = await planOtpRoute(origin, destination, { limit: 1 });

    expect(route.legs).toMatchObject([
      { lineName: "板南線", terminalStation: "亞東醫院" },
      { lineName: "淡水信義線", terminalStation: "淡水" },
    ]);
  });

  it.each([
    ["TRTC_BL_BL-1_1", "TRTC_BL"],
    ["TRTC_BL_BL-2_1", "TRTC_BL"],
    ["TRTC_R_R-3_0", "TRTC_R_R-3"],
    ["TRTC_G_G-3_1", "TRTC_G_G-3"],
    ["TRTCMG_MK_MK-1_0", "TRTCMG_MK"],
    ["NTDLRT_V_V-2_0", "NTDLRT_V_V-2"],
    ["NTALRT_K_K-2_0", "NTALRT_K"],
    ["KRTC_O_O_0", "KRTC_O"],
    ["TMRT_G_G-1_1", "TMRT_G"],
    ["KLRT_C_C_0", "KLRT_C"],
  ])("labels %s with line key %s for client i18n", async (routeId, lineKey) => {
    post.mockResolvedValue(okResp([metroItinerary(routeId, undefined)]));

    const [route] = await planOtpRoute(origin, destination, { limit: 1 });

    expect(route.legs[0]).toMatchObject({ type: "METRO", lineKey });
  });

  it("omits the line key for lines outside the label table", async () => {
    post.mockResolvedValue(okResp([metroItinerary("TRTC_X_X-1_0", undefined)]));

    const [route] = await planOtpRoute(origin, destination, { limit: 1 });

    expect(route.legs[0]).not.toHaveProperty("lineKey");
    expect(route.legs[0]).toMatchObject({ lineName: "南港展覽館－頂埔" });
  });

  it("takes English station names from the feed translations of the same stops", async () => {
    const itinerary = metroItinerary("TRTC_BL_BL-1_1", [
      {
        gtfsId: "1:TRTC_BL12",
        name: "台北車站",
        nameEn: "Taipei Main Station",
      },
      { gtfsId: "1:TRTC_BL01", name: "頂埔", nameEn: "Dingpu" },
    ]);
    const leg = itinerary.legs[0] as unknown as {
      from: { stop: Record<string, unknown> };
      to: { stop: Record<string, unknown> };
    };
    leg.from.stop = {
      ...leg.from.stop,
      name: "市政府",
      nameEn: "Taipei City Hall",
    };
    // OTP returns the source name when translations.txt has no English row.
    leg.to.stop = { ...leg.to.stop, name: "台北車站", nameEn: "台北車站" };
    post.mockResolvedValue(okResp([itinerary]));

    const [route] = await planOtpRoute(origin, destination, { limit: 1 });

    expect(route.legs[0]).toMatchObject({
      fromNameEn: "Taipei City Hall",
      terminalStation: "頂埔",
      terminalNameEn: "Dingpu",
    });
    expect(route.legs[0]).not.toHaveProperty("toNameEn");
  });

  it("keeps bus route names unchanged", async () => {
    post.mockResolvedValue(okResp([transitItinerary("307")]));

    const routes = await planOtpRoute(origin, destination, { limit: 1 });

    expect(routes[0].routeName).toBe("307");
    expect(routes[0].legs[0]).toMatchObject({ type: "BUS", routeName: "307" });
  });
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

  it("preserves intermediate stop instants across route-token JSON serialization", async () => {
    const boardAt = Date.parse("2030-01-01T10:00:00+08:00");
    const bus = transitItinerary("TIMED", boardAt);
    post.mockResolvedValue(
      okResp([
        {
          ...bus,
          legs: [
            {
              ...bus.legs[0],
              intermediatePlaces: [
                {
                  name: "中途站",
                  lat: 25.04,
                  lon: 121.56,
                  stop: { gtfsId: "1:MID" },
                  arrivalTime: boardAt + 300_000,
                  departureTime: boardAt + 330_000,
                },
              ],
            },
          ],
        },
      ]),
    );
    const routes = await planOtpRoute(origin, destination, {
      departureTime: new Date(boardAt - 600_000),
    });
    const leg = routes.flatMap((r) => r.legs).find((l) => l.type === "BUS");
    expect(JSON.parse(JSON.stringify(leg)).scheduledTrip).toMatchObject({
      tripId: "TIMED_trip",
      stops: [
        { name: "起站", departureAt: boardAt },
        {
          name: "中途站",
          stopUid: "MID",
          arrivalAt: boardAt + 300_000,
          departureAt: boardAt + 330_000,
        },
        { name: "終站", arrivalAt: boardAt + 600_000 },
      ],
    });
    expect(PLAN_QUERY).toContain("arrivalTime departureTime");
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

    const options = { departureTime: new Date("2030-01-01T09:00:00+08:00") };
    const detailed = await planOtpRouteDetailed(origin, destination, options);

    expect(detailed.status).toBe("ok");
    if (detailed.status !== "ok") return;
    await expect(planOtpRoute(origin, destination, options)).resolves.toEqual(
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
