import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const {
  getCanonicalBusPair,
  getSelectedBusGeometry,
  isBusSelectionAccessible,
  readNavigationTokenStrict,
  storeInitialNavigationEnvelope,
  redisGet,
  redisSet,
} = vi.hoisted(() => ({
  getCanonicalBusPair: vi.fn(),
  getSelectedBusGeometry: vi.fn(),
  isBusSelectionAccessible: vi.fn(),
  readNavigationTokenStrict: vi.fn(),
  storeInitialNavigationEnvelope: vi.fn(),
  redisGet: vi.fn(),
  redisSet: vi.fn(),
}));
vi.mock("../../config/redis", () => ({ redisGet, redisSet }));
vi.mock("./navigation-state.repository", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./navigation-state.repository")>()),
  readNavigationTokenStrict,
  storeInitialNavigationEnvelope,
  navigationTokenKey: (token: string) => `voice-nav:route:${token}`,
}));
vi.mock("./accessible-route.service", () => ({ isBusSelectionAccessible }));
vi.mock("../transit/bus.service", () => ({ getSelectedBusGeometry }));
vi.mock("../transit/bus-stop-pair-eta.service", async (original) => ({
  ...(await original<typeof import("../transit/bus-stop-pair-eta.service")>()),
  getCanonicalBusPair,
}));
import { resolveCandidateGroup } from "./bus-stop-pair-candidates";
import { createCandidateRequestBudget } from "../transit/bus-stop-pair-eta.service";
import { storeOfferedBusCandidates } from "./bus-plan.repository";
import { attachRouteTokens } from "./route-token.service";
import { selectBusDeparture, sameBusDeparture } from "./bus-selection.service";
import type { AccessibleRoute, BusLeg } from "../../types/route";
import type { CanonicalPlanRouteRequest } from "./accessible-route.types";
const start = Date.parse("2030-01-01T09:55:00+08:00");
const storage = new Map<string, string>();
const canonical: CanonicalPlanRouteRequest = {
  origin: { latitude: 25, longitude: 121 },
  destination: { latitude: 25.1, longitude: 121.1 },
  userLocation: { latitude: 25, longitude: 121 },
  travelMode: "transit",
  mode: "normal",
  maxTransfers: 2,
  format: "standard",
  waypoints: [],
  avoidStairs: false,
  requireElevator: false,
  needsAccessibleToilet: false,
  needsHandrail: false,
};
function live(id: string, minutes: number, end: number, plate = id) {
  const board = {
    seq: 1,
    stopUID: `${id}A`,
    lat: 25,
    lng: 121,
    stopName: { Zh_tw: "A" },
  };
  const alight = {
    seq: 2,
    stopUID: `${id}B`,
    lat: 25.1,
    lng: 121.1,
    stopName: { Zh_tw: "B" },
  };
  return {
    route: {
      subRouteUid: id,
      routeName: { Zh_tw: id },
      direction: 0,
      board,
      alight,
      stops: [board, alight],
    },
    eta: [
      {
        plateNumb: plate,
        boardingAt: start + minutes * 60000,
        alightingAt: start + end * 60000,
      },
    ],
  };
}
let first = [live("14", 2, 10), live("105", 3, 12)];
let second = [live("201", 15, 20), live("202", 21, 30)];
async function plan(two = false, mode: "normal" | "wheelchair" = "normal") {
  const leg = (suffix: string): BusLeg => ({
    type: "BUS",
    routeName: "14",
    subRouteUid: "14",
    subRouteName: "14",
    departureStop: "A",
    arrivalStop: "B",
    departureStopId: "14A",
    arrivalStopId: "14B",
    direction: 0,
    _canonicalDepartureStopId: `A${suffix}`,
    _canonicalArrivalStopId: `B${suffix}`,
    tdxCity: "Taipei",
    polyline: [
      [121, 25],
      [121.1, 25.1],
    ],
    waitInfo: { time: null, source: "unavailable" },
    departureStopA11y: [],
    arrivalStopA11y: [],
  });
  const route: AccessibleRoute = {
    routeId: "route",
    routeName: "route",
    totalMinutes: 20,
    transferCount: two ? 1 : 0,
    accessibilityHighlights: [],
    legs: two ? [leg("first"), leg("second")] : [leg("first")],
  };
  const budget = createCandidateRequestBudget();
  try {
    const routes = await resolveCandidateGroup({
      members: [route],
      mode,
      planningNow: start,
      budget,
      memo: new Map(),
    });
    return (await attachRouteTokens(routes, { ...canonical, mode }))[0];
  } finally {
    budget.close();
  }
}
const candidate = (route: AccessibleRoute, index: number, name: string) =>
  (route.legs[index] as BusLeg).departureCandidates!.find(
    (c) => c.routeName === name,
  )!;
const select = (route: AccessibleRoute, index: number, name: string) =>
  selectBusDeparture({
    routeToken: route.routeToken!,
    legIndex: index,
    candidateId: candidate(route, index, name).candidateId,
  });
beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(start);
  storage.clear();
  first = [live("14", 2, 10), live("105", 3, 12)];
  second = [live("201", 15, 20), live("202", 21, 30)];
  redisGet.mockImplementation(async (key: string) => storage.get(key) ?? null);
  redisSet.mockImplementation(async (key: string, value: string) => {
    storage.set(key, value);
  });
  readNavigationTokenStrict.mockImplementation(async (token: string) => {
    const raw = storage.get(`voice-nav:route:${token}`);
    return raw
      ? { status: "ok", value: JSON.parse(raw) }
      : { status: "missing" };
  });
  storeInitialNavigationEnvelope.mockImplementation(
    async (token: string, envelope: unknown) => {
      storage.set(`voice-nav:route:${token}`, JSON.stringify(envelope));
      return true;
    },
  );
  getCanonicalBusPair.mockImplementation(
    async (input: { canonicalBoardStopId: string }) => ({
      complete: true,
      vehicles: [],
      routes: input.canonicalBoardStopId.endsWith("second") ? second : first,
    }),
  );
  getSelectedBusGeometry.mockResolvedValue([
    [121, 25],
    [121, 25.05],
    [121.1, 25.05],
    [121.1, 25.1],
  ]);
  isBusSelectionAccessible.mockResolvedValue(true);
});
afterEach(() => vi.useRealTimers());

describe("bus departure adoption", () => {
  it("materializes the requested alternative and creates a new durable capability without changing the old one", async () => {
    const old = await plan();
    const original = storage.get(`voice-nav:route:${old.routeToken}`);
    const result = await select(old, 0, "105");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.route.routeToken).not.toBe(old.routeToken);
    expect(result.route.navigationId).not.toBe(old.navigationId);
    expect(result.route.routeVersion).toBe(1);
    expect(result.route.legs[0]).toMatchObject({
      routeName: "105",
      plateNumb: "105",
      geometrySource: "route_shape",
      selectedDeparture: { routeName: "105", selected: true },
    });
    expect(result.route.arrivalTime).toBe("2030-01-01T10:07:00.000+08:00");
    expect(storage.get(`voice-nav:route:${old.routeToken}`)).toBe(original);
    expect(
      JSON.parse(storage.get(`bus-plan:${result.route.routeToken}`)!).legs[0]
        .lockedCandidate.plateNumb,
    ).toBe("105");
    expect(isBusSelectionAccessible).toHaveBeenCalledOnce();
  });
  it("preserves every ordered intermediate stop through adoption, shape enrichment, and persistence", async () => {
    const route = first[1].route;
    route.alight = { ...route.alight, seq: 4 };
    route.stops = [
      route.board,
      {
        seq: 2,
        stopUID: "105M1",
        lat: 25.03,
        lng: 121.03,
        stopName: { Zh_tw: "中途一" },
      },
      {
        seq: 3,
        stopUID: "105M2",
        lat: 25.07,
        lng: 121.07,
        stopName: { Zh_tw: "中途二" },
      },
      route.alight,
    ];
    const initial = await plan();
    const result = await select(initial, 0, "105");
    if (!result.ok) throw new Error(result.error);
    const intermediateStops = [
      { name: "中途一", stationUid: "105M1", location: [121.03, 25.03] },
      { name: "中途二", stationUid: "105M2", location: [121.07, 25.07] },
    ];
    expect(result.route.legs[0]).toMatchObject({
      geometrySource: "route_shape",
      intermediateStops,
    });
    expect(
      JSON.parse(storage.get(`bus-plan:${result.route.routeToken}`)!).legs[0]
        .leg.intermediateStops,
    ).toEqual(intermediateStops);
  });
  it("accepts a stale ETA identifier only for the unique same vehicle and service day", async () => {
    const old = await plan();
    first = [live("14", 2, 10), live("105", 4, 13)];
    const result = await select(old, 0, "105");
    expect(result).toMatchObject({
      ok: true,
      route: {
        legs: [
          {
            selectedDeparture: {
              boardingTime: "2030-01-01T09:59:00.000+08:00",
            },
          },
        ],
      },
    });
  });
  it("adopts a refreshed offer after its ETA changes again, without relying on the original candidate id", async () => {
    const initial = await plan();
    const offered = {
      ...candidate(initial, 0, "105"),
      candidateId: `105|0|105|${start + 4 * 60000}`,
      boardingTime: "2030-01-01T09:59:00+08:00",
    };
    await storeOfferedBusCandidates(initial.routeToken!, 0, [offered]);
    first = [live("105", 5, 14)];
    expect(
      await selectBusDeparture({
        routeToken: initial.routeToken!,
        legIndex: 0,
        candidateId: offered.candidateId,
      }),
    ).toMatchObject({
      ok: true,
      route: {
        legs: [
          {
            selectedDeparture: {
              plateNumb: "105",
              boardingTime: "2030-01-01T10:00:00.000+08:00",
            },
          },
        ],
      },
    });
  });
  it("retains the first lock when adopting the second bus", async () => {
    const initial = await plan(true);
    const firstResult = await select(initial, 0, "105");
    if (!firstResult.ok) throw new Error(firstResult.error);
    const result = await select(firstResult.route, 1, "202");
    expect(result).toMatchObject({
      ok: true,
      route: {
        legs: [
          { selectedDeparture: { routeName: "105", plateNumb: "105" } },
          { selectedDeparture: { routeName: "202", plateNumb: "202" } },
        ],
      },
    });
  });
  it("keeps a known trip identity and timetable when a later live refresh only names the plate", async () => {
    const initial = await plan(true);
    const firstResult = await select(initial, 0, "105");
    if (!firstResult.ok) throw new Error(firstResult.error);
    const key = `bus-plan:${firstResult.route.routeToken}`;
    const saved = JSON.parse(storage.get(key)!);
    saved.legs[0].lockedCandidate.tripId = "run-A";
    saved.legs[0].leg.scheduledTrip = {
      tripId: "run-A",
      boardingReadyAt: start,
      stops: [
        { stopUid: "105A", name: "A", departureAt: start + 3 * 60000 },
        { stopUid: "105B", name: "B", arrivalAt: start + 12 * 60000 },
      ],
    };
    storage.set(key, JSON.stringify(saved));
    expect(await select(firstResult.route, 1, "202")).toMatchObject({
      ok: true,
      route: {
        legs: [
          {
            selectedDeparture: { tripId: "run-A", plateNumb: "105" },
            scheduledTrip: { tripId: "run-A" },
          },
          { selectedDeparture: { plateNumb: "202" } },
        ],
      },
    });
  });
  it("rejects a chosen bus when it cannot reach an already selected transfer", async () => {
    const initial = await plan(true);
    const downstream = await select(initial, 1, "201");
    if (!downstream.ok) throw new Error(downstream.error);
    first = [live("14", 2, 10), live("105", 3, 18)];
    expect(await select(downstream.route, 0, "105")).toMatchObject({
      ok: false,
      status: 409,
    });
  });
  it.each(["missing", "ambiguous", "unknown", "different-day", "high-floor"])(
    "fails closed for %s candidate identity or eligibility",
    async (kind) => {
      const initial = await plan(
        false,
        kind === "high-floor" ? "wheelchair" : "normal",
      );
      if (kind === "missing") first = [live("14", 2, 10)];
      if (kind === "ambiguous")
        first = [live("105", 4, 13), live("105", 5, 14)];
      if (kind === "unknown") first = [live("105", 4, 13, undefined as never)];
      if (kind === "unknown") first[0].eta[0].plateNumb = undefined as never;
      if (kind === "different-day") first = [live("105", 1443, 1452)];
      if (kind === "high-floor")
        getCanonicalBusPair.mockResolvedValue({
          complete: true,
          routes: first,
          vehicles: [
            { plateNumb: "105", isLowFloor: false, hasLiftOrRamp: false },
          ],
        });
      expect(await select(initial, 0, "105")).toMatchObject({
        ok: false,
        status: 409,
      });
    },
  );
  it("keeps the explicit stop geometry fallback if shape attribution fails", async () => {
    const initial = await plan();
    getSelectedBusGeometry.mockResolvedValue(null);
    expect(await select(initial, 0, "105")).toMatchObject({
      ok: true,
      route: { legs: [{ geometrySource: "route_stops" }] },
    });
  });
  it("rejects the candidate when accessibility validation rejects its replacement", async () => {
    const initial = await plan();
    isBusSelectionAccessible.mockResolvedValue(false);
    expect(await select(initial, 0, "105")).toMatchObject({
      ok: false,
      status: 409,
    });
  });
  it("distinguishes expired capability and unavailable state", async () => {
    expect(
      await selectBusDeparture({
        routeToken: "expired",
        legIndex: 0,
        candidateId: "x",
      }),
    ).toMatchObject({ ok: false, status: 410 });
    readNavigationTokenStrict.mockResolvedValue({ status: "unavailable" });
    expect(
      await selectBusDeparture({
        routeToken: "expired",
        legIndex: 0,
        candidateId: "x",
      }),
    ).toMatchObject({ ok: false, status: 503 });
  });
  it.each(["envelope", "bus-plan"])(
    "does not return success when persisting %s fails",
    async (kind) => {
      const initial = await plan();
      if (kind === "envelope")
        storeInitialNavigationEnvelope.mockResolvedValue(false);
      else redisSet.mockResolvedValue(undefined);
      expect(await select(initial, 0, "105")).toMatchObject({
        ok: false,
        status: 503,
      });
    },
  );
});

it("rejects conflicting timetable trips even when the vehicle plate agrees", () => {
  const identity = {
    candidateId: "a",
    routeName: "307",
    subRouteUid: "307",
    direction: 0 as const,
    departureStopId: "A",
    arrivalStopId: "C",
    plateNumb: "SAME",
    tripId: "run-A",
    boardingTime: "2030-01-01T10:00:00+08:00",
    alightingTime: "2030-01-01T10:20:00+08:00",
    boardingTimeSource: "schedule" as const,
    alightingTimeSource: "schedule" as const,
    estimatedWaitMinutes: 5,
    vehicleAccessibility: "unknown" as const,
    hasLiftOrRamp: null,
    selected: true,
  };
  expect(sameBusDeparture(identity, { ...identity, tripId: "run-B" })).toBe(
    false,
  );
  expect(
    sameBusDeparture(identity, { ...identity, plateNumb: "DIFFERENT" }),
  ).toBe(false);
});
