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
vi.mock("../traffic/road-incident.service", () => ({
  getActiveRoadIncidents: vi.fn().mockResolvedValue([]),
}));
vi.mock("./route-elevation-enrichment", () => ({
  attachWalkElevationProfiles: vi.fn(),
}));
vi.mock("../../adapters/otp-sidewalk-index.adapter", () => ({
  annotateSidewalkSegments: vi.fn(),
  walkSidewalkEvidence: vi.fn(),
}));

import { planAccessibleRouteFromRequest } from "./accessible-route.service";
import { planOtpWalkDetailed } from "./planners/otp-routing";
import { walkSidewalkEvidence } from "../../adapters/otp-sidewalk-index.adapter";
import { planValhallaRoute } from "./planners/valhalla-routing";
import { getActiveRoadIncidents } from "../traffic/road-incident.service";
import type { RoadIncident } from "../../types/traffic";

const otp = vi.mocked(planOtpWalkDetailed);
const sidewalkEvidence = vi.mocked(walkSidewalkEvidence);
/** Sidewalk evidence per candidate name; unnamed candidates have none. */
let evidenceByName: Record<string, { share: number; unramped?: number }> = {};
const valhalla = vi.mocked(planValhallaRoute);
const incidents = vi.mocked(getActiveRoadIncidents);
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
  incidents.mockResolvedValue([]);
  evidenceByName = {};
  sidewalkEvidence.mockImplementation(async (routes) => {
    const result = new Map();
    for (const candidate of routes) {
      const name = Object.keys(evidenceByName).find((key) =>
        candidate.routeId.includes(key),
      );
      const evidence = name ? evidenceByName[name] : { share: 0 };
      result.set(candidate, {
        sidewalkShare: evidence.share,
        unrampedCrossings: evidence.unramped ?? 0,
      });
    }
    return result;
  });
});
afterEach(() => vi.unstubAllEnvs());

describe("outdoor walking candidates", () => {
  it("drops known-stairs candidates when a known step-free one exists", async () => {
    otp.mockResolvedValue({
      status: "ok",
      routes: [
        route("東路", 8, 0, 2),
        route("中路", 12, 1),
        route("西路", 10, 2, 1),
      ],
    });

    const routes = await candidates();

    expect(routes.map((candidate) => candidate.routeId)).toEqual([
      "otp-walk-中路",
    ]);
    expect(stairCounts(routes)).toEqual([0]);
    expect(otp).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({
        avoidStairs: true,
        includeWalkingAlternatives: true,
      }),
    );
    expect(valhalla).not.toHaveBeenCalled();
  });

  it("returns the least-stairs candidate with a warning when every candidate has stairs", async () => {
    otp.mockResolvedValue({
      status: "ok",
      routes: [route("東路", 8, 0, 2), route("西路", 10, 2, 1)],
    });

    const routes = await candidates();

    expect(stairCounts(routes)).toEqual([1, 2]);
    for (const candidate of routes) {
      expect(candidate.degraded).toBe(true);
      expect(candidate.warnings?.join("|")).toContain("樓梯");
    }
  });

  it("keeps stair candidates when none is step-free", async () => {
    otp.mockResolvedValue({ status: "ok", routes: [route("東路", 8, 0, 2)] });

    const routes = await candidates();

    expect(stairCounts(routes)).toEqual([2]);
    expect(routes[0].degraded).toBe(true);
  });

  it("orders by time when the stairs preference is off without excluding stairs", async () => {
    otp.mockResolvedValue({
      status: "ok",
      routes: [route("慢路", 12, 1), route("快路", 8, 0, 2)],
    });

    const routes = await candidates(false);

    expect(routes.map((candidate) => candidate.totalMinutes)).toEqual([8, 12]);
    expect(stairCounts(routes)).toEqual([2, 0]);
  });

  it("does not treat missing steps as evidence of a stair-free route", async () => {
    otp.mockResolvedValue({
      status: "ok",
      routes: [route("步驟未知", 5, 0, null), route("步驟完整", 10, 1, 1)],
    });

    const routes = await candidates();

    expect(routes[0].totalMinutes).toBe(10);
    expect(stairCounts(routes)[0]).toBe(1);
  });

  it("reports upstream unavailability without asking Valhalla when OTP is unavailable", async () => {
    otp.mockResolvedValue({ status: "unavailable", routes: [] });

    const result = await planAccessibleRouteFromRequest(request);

    expect(result).toMatchObject({
      ok: false,
      data: { reason: "UPSTREAM_TIMEOUT" },
    });
    expect(valhalla).not.toHaveBeenCalled();
  });

  it("reports no route when OTP finds none", async () => {
    otp.mockResolvedValue({ status: "no_route", routes: [] });

    const result = await planAccessibleRouteFromRequest(request);

    expect(result).toMatchObject({ ok: false, data: { reason: "NO_ROUTE" } });
    expect(valhalla).not.toHaveBeenCalled();
  });

  it("retains positive stairs evidence when candidates share the same geometry", async () => {
    otp.mockResolvedValue({
      status: "ok",
      routes: [
        route("未報樓梯", 8, 0),
        route("確有樓梯", 12, 0, 1),
        route("另一候選未報樓梯", 7, 0),
      ],
    });

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

describe("step-free walks prefer confirmed sidewalk", () => {
  it("takes the step-free candidate with more sidewalk within the detour cap", async () => {
    otp.mockResolvedValue({
      status: "ok",
      routes: [route("車道", 8, 0), route("人行道", 10, 1)],
    });
    evidenceByName = { 車道: { share: 0.2 }, 人行道: { share: 0.8 } };

    const routes = await candidates();

    expect(routes[0].routeId).toContain("人行道");
  });

  it("keeps the faster candidate when the sidewalk one exceeds the detour cap", async () => {
    otp.mockResolvedValue({
      status: "ok",
      routes: [route("車道", 8, 0), route("人行道", 11, 1)],
    });
    evidenceByName = { 車道: { share: 0.2 }, 人行道: { share: 0.8 } };

    const routes = await candidates();

    expect(routes[0].routeId).toContain("車道");
  });

  it("avoids proven-unramped crossings before comparing sidewalk", async () => {
    otp.mockResolvedValue({
      status: "ok",
      routes: [route("無坡道", 8, 0), route("有坡道", 9, 1)],
    });
    evidenceByName = {
      無坡道: { share: 0.9, unramped: 1 },
      有坡道: { share: 0.3 },
    };

    const routes = await candidates();

    expect(routes[0].routeId).toContain("有坡道");
  });

  it("still drops known stairs before looking at sidewalk", async () => {
    otp.mockResolvedValue({
      status: "ok",
      routes: [route("樓梯人行道", 8, 0, 1), route("平路", 9, 1)],
    });
    evidenceByName = { 樓梯人行道: { share: 1 }, 平路: { share: 0 } };

    const routes = await candidates();

    expect(routes[0].routeId).toContain("平路");
    expect(stairCounts(routes)).toEqual([0]);
  });

  it("leaves walks without the stairs preference ordered by time", async () => {
    otp.mockResolvedValue({
      status: "ok",
      routes: [route("人行道", 10, 1), route("車道", 8, 0)],
    });
    evidenceByName = { 車道: { share: 0 }, 人行道: { share: 1 } };

    const routes = await candidates(false);

    expect(routes[0].routeId).toContain("車道");
    expect(sidewalkEvidence).not.toHaveBeenCalled();
  });
});

describe("government road events on walking routes", () => {
  const sidewalkWork = (
    points?: RoadIncident["points"],
    overrides: Partial<RoadIncident> = {},
  ): RoadIncident => ({
    incidentId: "work-1",
    title: "道路施工",
    description: "人行道更新工程",
    severity: "advisory",
    location: { lat: 25.035, lng: 121.56 },
    ...(points ? { points } : {}),
    ...overrides,
  });

  async function twoStepFreeCorridors() {
    otp.mockResolvedValue({
      status: "ok",
      routes: [route("中路", 12, 1), route("西路", 10, 2)],
    });
    return candidates();
  }

  it("adds an advisory without changing order, candidates or degraded state", async () => {
    const baseline = await twoStepFreeCorridors();
    incidents.mockResolvedValue([sidewalkWork()]);

    const routes = await twoStepFreeCorridors();

    expect(routes.map((candidate) => candidate.routeId)).toEqual(
      baseline.map((candidate) => candidate.routeId),
    );
    const hit = routes.find((candidate) => candidate.routeId.includes("中路"));
    expect(hit?.hazardAdvisory?.onRoute).toEqual([
      expect.objectContaining({
        id: "tdx:work-1",
        source: "government",
        severity: "difficult",
      }),
    ]);
    expect(hit?.hazardAdvisory?.avoided).toEqual([]);
    expect(hit?.degraded).toBeUndefined();
    const miss = routes.find(
      (candidate) => !candidate.routeId.includes("中路"),
    );
    expect(miss).toBeDefined();
    expect(miss?.hazardAdvisory).toBeUndefined();
  });

  it("ignores carriageway-only advisories", async () => {
    incidents.mockResolvedValue([
      sidewalkWork(undefined, { title: "路面養護", description: "車道刨鋪" }),
    ]);

    const routes = await twoStepFreeCorridors();

    expect(routes.every((candidate) => !candidate.hazardAdvisory)).toBe(true);
  });

  it("skips a malformed multi-point event without failing the request", async () => {
    incidents.mockResolvedValue([
      sidewalkWork([
        { lat: 25.035, lng: 121.56 },
        { lat: 95, lng: 121.56 },
      ]),
    ]);

    const routes = await twoStepFreeCorridors();

    expect(routes.length).toBeGreaterThan(0);
    expect(routes.every((candidate) => !candidate.hazardAdvisory)).toBe(true);
  });

  it("keeps valid events when another event is malformed", async () => {
    incidents.mockResolvedValue([
      sidewalkWork(
        [
          { lat: 95, lng: 121.56 },
          { lat: 25.035, lng: 121.56 },
        ],
        { incidentId: "broken" },
      ),
      sidewalkWork(undefined, { incidentId: "valid" }),
    ]);

    const routes = await twoStepFreeCorridors();

    const hit = routes.find((candidate) => candidate.routeId.includes("中路"));
    expect(hit?.hazardAdvisory?.onRoute.map((hazard) => hazard.id)).toEqual([
      "tdx:valid",
    ]);
  });

  it("returns the routes unchanged when the incident lookup fails", async () => {
    const baseline = await twoStepFreeCorridors();
    incidents.mockRejectedValue(new Error("TDX down"));

    const routes = await twoStepFreeCorridors();

    expect(routes.map((candidate) => candidate.routeId)).toEqual(
      baseline.map((candidate) => candidate.routeId),
    );
    expect(routes.every((candidate) => !candidate.hazardAdvisory)).toBe(true);
  });
});
