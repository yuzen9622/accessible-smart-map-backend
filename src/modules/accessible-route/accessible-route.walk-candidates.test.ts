import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AccessibleRoute, WalkLeg } from "../../types/route";
import type { PlanRouteRequest } from "./accessible-route.types";

vi.mock("../../adapters/taipei-metro-notice.adapter", () => ({
  fetchTaipeiMetroNotices: vi.fn(async () => []),
}));
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
vi.mock("./planners/otp-routing", async (importActual) => ({
  ...(await importActual<typeof import("./planners/otp-routing")>()),
  planOtpRoute: vi.fn(),
  planOtpRouteDetailed: vi.fn(),
  planOtpWalkDetailed: vi.fn(),
  isOtpCircuitOpen: vi.fn().mockReturnValue(false),
}));
vi.mock("./planners/valhalla-routing", () => ({ planValhallaRoute: vi.fn() }));
vi.mock("../a11y/a11y.service", async (importActual) => ({
  ...(await importActual<typeof import("../a11y/a11y.service")>()),
  findNearbyParking: vi.fn().mockResolvedValue([]),
}));
vi.mock("../a11y/a11y.orchestration", async (importActual) => ({
  ...(await importActual<typeof import("../a11y/a11y.orchestration")>()),
  findNearby: vi.fn().mockResolvedValue({ nearbyOsm: [] }),
}));
vi.mock("../../model/bus-stop.model", () => ({
  default: {
    findOne: () => ({
      select: () => ({ lean: async () => ({ city: "Taipei" }) }),
    }),
  },
}));
vi.mock("../../adapters/nlsc.adapter", () => ({
  getNlscAdministrativeArea: vi.fn().mockResolvedValue(null),
}));
vi.mock("../../adapters/google.adapter", async (importActual) => ({
  ...(await importActual<typeof import("../../adapters/google.adapter")>()),
  getCity: vi.fn(),
  getCoordinates: vi.fn(),
}));
vi.mock("./route-token.service", async (importActual) => ({
  ...(await importActual<typeof import("./route-token.service")>()),
  attachRouteTokens: vi.fn(async (routes: AccessibleRoute[]) => routes),
}));
vi.mock("../hazard-report/hazard-report.service", () => ({
  findConfirmedHazardsWithin: vi.fn().mockResolvedValue([]),
}));
vi.mock("./route-elevation-enrichment", () => ({
  attachWalkElevationProfiles: vi.fn(),
}));
vi.mock("../../adapters/otp-sidewalk-index.adapter", () => ({
  annotateSidewalkSegments: vi.fn(),
}));

import { planAccessibleRouteFromRequest } from "./accessible-route.service";
import { planOtpWalkDetailed } from "./planners/otp-routing";
import { planValhallaRoute } from "./planners/valhalla-routing";

const otp = vi.mocked(planOtpWalkDetailed);
const valhalla = vi.mocked(planValhallaRoute);
const request = {
  origin: { latitude: 25.04, longitude: 121.56 },
  destination: { latitude: 25.03, longitude: 121.55 },
  mode: "wheelchair",
  travelMode: "walk",
  avoidStairs: true,
} satisfies PlanRouteRequest;

function route(
  id: string,
  minutes: number,
  corridor: number,
  stairs: number | null = 0,
): AccessibleRoute {
  const polyline: WalkLeg["polyline"] = [
    [121.56, 25.04],
    [121.548 + corridor * 0.012, 25.036 - corridor * 0.001],
    [121.55, 25.03],
  ];
  const leg: WalkLeg = {
    type: "WALK",
    from: "起點",
    to: "終點",
    distanceM: 2000,
    minutesEst: minutes,
    polyline,
    a11yFacilities: [],
    maxSlopePercent: null,
    crossings: null,
    crossingsWithCurbRamp: null,
    minPathWidthCm: null,
    surfaceType: "unknown",
    restPoints: [],
    ...(stairs === null
      ? {}
      : {
          steps: Array.from({ length: Math.max(1, stairs) }, (_, index) => ({
            relativeDirection: "CONTINUE",
            absoluteDirection: "NORTH" as const,
            streetName: `${id}${index + 1}路`,
            bogusName: false,
            area: false,
            stairs: index < stairs,
            steepSlope: false,
            distanceM: 2000 / Math.max(1, stairs),
            location: polyline[0],
          })),
        }),
  };
  return {
    routeId: id,
    routeName: id,
    totalMinutes: minutes,
    totalWalkDistanceM: 2000,
    transferCount: 0,
    accessibilityHighlights: [],
    legs: [leg],
  };
}

async function candidates(avoidStairs = true) {
  const result = await planAccessibleRouteFromRequest({
    ...request,
    avoidStairs,
  });
  expect(result.ok).toBe(true);
  if (!result.ok)
    throw new Error(`Expected routes, received ${result.data?.reason}`);
  return result.data.routes;
}

function stairCounts(routes: AccessibleRoute[]) {
  return routes.map((candidate) =>
    candidate.legs.reduce(
      (count, leg) =>
        count +
        (leg.type === "WALK"
          ? (leg.steps?.filter((step) => step.stairs).length ?? 0)
          : 0),
      0,
    ),
  );
}

beforeEach(() => {
  vi.stubEnv("ROUTE_WALK_PLANNER", "otp");
  vi.clearAllMocks();
  otp.mockResolvedValue({ status: "ok", routes: [route("有樓梯", 8, 0, 2)] });
  valhalla.mockResolvedValue([]);
});
afterEach(() => vi.unstubAllEnvs());

describe("outdoor walking candidates", () => {
  it("prefers fewer stairs while retaining labelled alternatives from both engines", async () => {
    otp.mockResolvedValue({
      status: "ok",
      routes: [route("東路", 8, 0, 2), route("中路", 12, 1)],
    });
    valhalla.mockResolvedValue([route("西路", 10, 2, 1)]);

    const routes = await candidates();

    expect(routes.map((candidate) => candidate.totalMinutes)).toEqual([
      12, 10, 8,
    ]);
    expect(stairCounts(routes)).toEqual([0, 1, 2]);
    expect(new Set(routes.map((candidate) => candidate.routeId)).size).toBe(3);
    expect(
      routes.some((candidate) => candidate.routeId.startsWith("otp-")),
    ).toBe(true);
    expect(
      routes.some((candidate) => candidate.routeId.startsWith("valhalla-")),
    ).toBe(true);
  });

  it("orders by time when the stairs preference is off without excluding stairs", async () => {
    otp.mockResolvedValue({ status: "ok", routes: [route("慢路", 12, 1)] });
    valhalla.mockResolvedValue([route("快路", 8, 0, 2)]);

    const routes = await candidates(false);

    expect(routes.map((candidate) => candidate.totalMinutes)).toEqual([8, 12]);
    expect(stairCounts(routes)).toEqual([2, 0]);
  });

  it("does not treat missing steps as evidence of a stair-free route", async () => {
    otp.mockResolvedValue({
      status: "ok",
      routes: [route("步驟未知", 5, 0, null)],
    });
    valhalla.mockResolvedValue([route("步驟完整", 10, 1, 1)]);

    const routes = await candidates();

    expect(routes[0].totalMinutes).toBe(10);
    expect(stairCounts(routes)[0]).toBe(1);
  });

  it("keeps Valhalla candidates when OTP is unavailable", async () => {
    otp.mockResolvedValue({ status: "unavailable", routes: [] });
    valhalla.mockResolvedValue([route("仍可規劃", 10, 1, 1)]);

    const routes = await candidates();

    expect(routes).toHaveLength(1);
    expect(routes[0].routeId).toContain("仍可規劃");
    expect(stairCounts(routes)).toEqual([1]);
  });

  it("keeps OTP candidates when the optional Valhalla query times out", async () => {
    valhalla.mockRejectedValue(new Error("Valhalla timeout"));

    const routes = await candidates();

    expect(routes).toHaveLength(1);
    expect(routes[0].routeId).toContain("有樓梯");
    expect(stairCounts(routes)).toEqual([2]);
  });

  it("reports upstream unavailability when OTP is empty and Valhalla times out", async () => {
    otp.mockResolvedValue({ status: "no_route", routes: [] });
    valhalla.mockRejectedValue(new Error("Valhalla timeout"));

    const result = await planAccessibleRouteFromRequest(request);

    expect(result).toMatchObject({
      ok: false,
      data: { reason: "UPSTREAM_TIMEOUT" },
    });
  });

  it("retains positive stairs evidence when engines return the same geometry", async () => {
    otp.mockResolvedValue({
      status: "ok",
      routes: [route("未報樓梯", 8, 0), route("確有樓梯", 12, 0, 1)],
    });
    valhalla.mockResolvedValue([route("另一引擎未報樓梯", 7, 0)]);

    const routes = await candidates();

    expect(routes).toHaveLength(1);
    expect(stairCounts(routes)).toEqual([1]);
    expect(routes[0].routeId).toContain("確有樓梯");
  });

  it.each([
    {
      label: "an internal exact destination",
      extra: { keepExactDestination: true },
    },
    {
      label: "a waypoint",
      extra: { waypoints: [{ latitude: 25.035, longitude: 121.555 }] },
    },
  ])("keeps hard stair avoidance for $label", async ({ extra }) => {
    const result = await planAccessibleRouteFromRequest({
      ...request,
      ...extra,
    });

    expect(result).toMatchObject({
      ok: false,
      status: 422,
      data: { reason: "NO_ACCESSIBLE_ROUTE" },
    });
    expect(valhalla).not.toHaveBeenCalled();
    expect(otp).toHaveBeenCalled();
    for (const [, , options] of otp.mock.calls) {
      expect(options).toMatchObject({ mode: "wheelchair", avoidStairs: true });
      expect(options).not.toHaveProperty("includeWalkingAlternatives");
    }
  });
});
