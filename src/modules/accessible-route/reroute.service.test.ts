import { beforeEach, describe, expect, it, vi } from "vitest";
import { sealNavigationEnvelope } from "./navigation-state.repository";
import { ResponseCode } from "../../types/code";
import type { AccessibleRoute, BusLeg } from "../../types/route";

const {
  readNavigationTokenStrict,
  beginReroute,
  finalizeReroute,
  releaseReroute,
  planAccessibleRouteFromRequest,
} = vi.hoisted(() => ({
  readNavigationTokenStrict: vi.fn(),
  beginReroute: vi.fn(),
  finalizeReroute: vi.fn(),
  releaseReroute: vi.fn(),
  planAccessibleRouteFromRequest: vi.fn(),
}));

vi.mock("./navigation-state.repository", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./navigation-state.repository")>()),
  readNavigationTokenStrict,
  beginReroute,
  finalizeReroute,
  releaseReroute,
}));
vi.mock("./accessible-route.service", () => ({
  planAccessibleRouteFromRequest,
}));

vi.mock("./walking-policy.service", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./walking-policy.service")>()),
  hasCurrentWalkingPolicy: vi.fn(async () => true),
}));

import { hasCurrentWalkingPolicy } from "./walking-policy.service";
import { rerouteAccessibleRoute } from "./reroute.service";

const route = (routeId: string): AccessibleRoute => ({
  routeId,
  routeName: routeId,
  totalMinutes: 2,
  transferCount: 0,
  accessibilityHighlights: [],
  legs: [
    {
      type: "WALK",
      from: "起點",
      to: "終點",
      distanceM: 10,
      minutesEst: 1,
      a11yFacilities: [],
      maxSlopePercent: null,
      crossings: null,
      crossingsWithCurbRamp: null,
      minPathWidthCm: null,
      surfaceType: "unknown",
      restPoints: [],
      exitInfo: null,
      polyline: [
        [121, 25],
        [121.001, 25],
      ],
    },
  ],
});

const selectedBus: BusLeg = {
  type: "BUS",
  routeName: "bus",
  subRouteUid: "bus-1",
  subRouteName: "bus",
  departureStop: "origin",
  arrivalStop: "destination",
  direction: 0,
  waitInfo: { time: 0, source: "unavailable" },
  polyline: [],
  departureStopA11y: [],
  arrivalStopA11y: [],
  selectedDeparture: {
    candidateId: "chosen",
    routeName: "bus",
    subRouteUid: "bus-1",
    direction: 0,
    departureStopId: "from",
    arrivalStopId: "to",
    estimatedWaitMinutes: null,
    boardingTime: null,
    alightingTime: null,
    boardingTimeSource: "unknown",
    alightingTimeSource: "unknown",
    vehicleAccessibility: "unknown",
    hasLiftOrRamp: null,
    selected: true,
  },
};

const canonicalRequest = {
  origin: { latitude: 25, longitude: 121 },
  destination: { latitude: 25.1, longitude: 121.1 },
  userLocation: { latitude: 25, longitude: 121 },
  travelMode: "walk" as const,
  mode: "normal" as const,
  maxTransfers: 2,
  format: "standard" as const,
  waypoints: [],
  avoidStairs: false,
  requireElevator: false,
  needsAccessibleToilet: false,
  needsHandrail: false,
};

const envelope = sealNavigationEnvelope({
  schemaVersion: 1 as const,
  route: { ...route("old"), navigationId: "nav-1", routeVersion: 1 },
  navigationId: "nav-1",
  routeVersion: 1,
  canonicalRequest,
});

const request = {
  routeToken: "old-token",
  currentPosition: { latitude: 25.02, longitude: 121.02, accuracy: 8 },
  previousRouteVersion: 1,
  reason: "OFF_ROUTE" as const,
  clientRequestId: "11111111-1111-4111-8111-111111111111",
};

describe("rerouteAccessibleRoute", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(hasCurrentWalkingPolicy).mockResolvedValue(true);
    readNavigationTokenStrict.mockResolvedValue({
      status: "ok",
      value: envelope,
    });
    beginReroute.mockResolvedValue({ status: "acquired" });
    finalizeReroute.mockResolvedValue("ok");
    releaseReroute.mockResolvedValue(undefined);
    planAccessibleRouteFromRequest.mockResolvedValue({
      ok: true,
      data: { routes: [route("top-ranked"), route("second")] },
    });
  });

  it("rejects a withdrawn walking qualification before acquiring or replanning", async () => {
    vi.mocked(hasCurrentWalkingPolicy).mockResolvedValue(false);
    expect(await rerouteAccessibleRoute(request)).toMatchObject({
      ok: false,
      status: ResponseCode.GONE,
      data: { reason: "ROUTE_TOKEN_EXPIRED_OR_UNSUPPORTED" },
    });
    expect(beginReroute).not.toHaveBeenCalled();
    expect(planAccessibleRouteFromRequest).not.toHaveBeenCalled();
    expect(finalizeReroute).not.toHaveBeenCalled();
  });

  it("reroutes a completed bus journey's remaining walk without introducing another bus", async () => {
    readNavigationTokenStrict.mockResolvedValue({
      status: "ok",
      value: sealNavigationEnvelope({
        ...envelope,
        canonicalRequest: { ...canonicalRequest, travelMode: "transit" },
        route: {
          ...envelope.route,
          legs: [selectedBus, ...route("tail").legs],
        },
      }),
    });
    const result = await rerouteAccessibleRoute({
      ...request,
      completedLegIndex: 0,
    });
    expect(result.ok).toBe(true);
    expect(planAccessibleRouteFromRequest).toHaveBeenCalledWith(
      expect.objectContaining({ travelMode: "walk", maxTransfers: 0 }),
    );
    expect(finalizeReroute.mock.calls[0][3]).toMatchObject({
      canonicalRequest: { travelMode: "walk", maxTransfers: 0 },
    });
  });
  it("rejects an unexpected transit result when rerouting the walking tail", async () => {
    readNavigationTokenStrict.mockResolvedValue({
      status: "ok",
      value: sealNavigationEnvelope({
        ...envelope,
        route: {
          ...envelope.route,
          legs: [selectedBus, ...route("tail").legs],
        },
      }),
    });
    planAccessibleRouteFromRequest.mockResolvedValue({
      ok: true,
      data: { routes: [{ ...route("wrong"), legs: [{ type: "BUS" }] }] },
    });
    expect(
      await rerouteAccessibleRoute({ ...request, completedLegIndex: 0 }),
    ).toMatchObject({ ok: false, status: 422 });
    expect(finalizeReroute).not.toHaveBeenCalled();
  });
  it("does not unlock a future selected bus using completion of an earlier walking leg", async () => {
    readNavigationTokenStrict.mockResolvedValue({
      status: "ok",
      value: sealNavigationEnvelope({
        ...envelope,
        route: {
          ...envelope.route,
          legs: [...route("head").legs, selectedBus, ...route("tail").legs],
        },
      }),
    });
    expect(
      await rerouteAccessibleRoute({ ...request, completedLegIndex: 0 }),
    ).toMatchObject({
      ok: false,
      status: 409,
      data: { reason: "BUS_SELECTION_REQUIRES_REPLAN" },
    });
    expect(planAccessibleRouteFromRequest).not.toHaveBeenCalled();
  });
  it.each([-1, 0.5, 99])(
    "rejects invalid completed leg progress %s",
    async (completedLegIndex) => {
      expect(
        await rerouteAccessibleRoute({ ...request, completedLegIndex }),
      ).toMatchObject({
        ok: false,
        status: 400,
        data: { reason: "NAVIGATION_PROGRESS_INVALID" },
      });
      expect(planAccessibleRouteFromRequest).not.toHaveBeenCalled();
    },
  );
  it.each(["en", "zh-TW", undefined] as const)(
    "provides a stable reason if finalization is unavailable (%s)",
    async (language) => {
      finalizeReroute.mockResolvedValue("unavailable");
      const result = await rerouteAccessibleRoute({ ...request, language });
      expect(result).toMatchObject({
        ok: false,
        status: 503,
        data: { reason: "NAVIGATION_STATE_UNAVAILABLE" },
      });
      expect(planAccessibleRouteFromRequest).toHaveBeenCalledTimes(1);
      expect(finalizeReroute).toHaveBeenCalledTimes(1);
    },
  );

  it("uses the canonical intent, replaces only origin/userLocation, selects the top route, and increments version", async () => {
    const result = await rerouteAccessibleRoute(request);
    expect(result.ok).toBe(true);
    expect(planAccessibleRouteFromRequest).toHaveBeenCalledWith({
      ...canonicalRequest,
      language: "zh-TW",
      origin: { latitude: 25.02, longitude: 121.02 },
      userLocation: { latitude: 25.02, longitude: 121.02 },
    });
    expect(result).toMatchObject({
      data: {
        navigationId: "nav-1",
        previousRouteVersion: 1,
        routeVersion: 2,
        route: {
          routeId: "top-ranked",
          navigationId: "nav-1",
          routeVersion: 2,
        },
        currentStepIndex: 0,
        replayed: false,
      },
    });
  });

  it("generates both instruction arrays in English without changing canonical planning intent", async () => {
    const result = await rerouteAccessibleRoute({ ...request, language: "en" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.instructions[0].text).toBe(
      "Head east toward your destination",
    );
    expect(result.data.steps.map((step) => step.instruction)).toEqual(
      result.data.instructions.map((step) => step.text),
    );
    expect(result.data.instructions.at(-1)?.text).toBe(
      "You have arrived at your destination",
    );
    expect(planAccessibleRouteFromRequest).toHaveBeenCalledWith({
      ...canonicalRequest,
      language: "en",
      origin: { latitude: 25.02, longitude: 121.02 },
      userLocation: { latitude: 25.02, longitude: 121.02 },
    });
  });

  it("localizes English reroute errors", async () => {
    readNavigationTokenStrict.mockResolvedValue({ status: "missing" });
    await expect(
      rerouteAccessibleRoute({ ...request, language: "en" }),
    ).resolves.toMatchObject({
      ok: false,
      status: 410,
      error: "The route token has expired or does not support rerouting",
    });
  });

  it("replays a completed request without calling the planner", async () => {
    beginReroute.mockResolvedValue({
      status: "replay",
      data: { routeToken: "same", routeVersion: 2, replayed: true },
    });
    const result = await rerouteAccessibleRoute(request);
    expect(result).toMatchObject({
      ok: true,
      data: { routeToken: "same", replayed: true },
    });
    expect(planAccessibleRouteFromRequest).not.toHaveBeenCalled();
  });

  it("replays the first source-backed result unchanged even if retry switches language", async () => {
    const planned = route("source-result");
    Object.assign(planned.legs[0], {
      toNameEn: "Source Destination",
      toDisplayName: "Source Destination",
    });
    planAccessibleRouteFromRequest.mockResolvedValue({
      ok: true,
      data: { routes: [planned] },
    });
    const first = await rerouteAccessibleRoute({ ...request, language: "en" });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.data.instructions[0].text).toContain("Source Destination");
    const stored = JSON.parse(JSON.stringify(first.data));
    beginReroute.mockResolvedValue({
      status: "replay",
      data: { ...stored, replayed: true },
    });
    const replay = await rerouteAccessibleRoute({
      ...request,
      language: "zh-TW",
    });
    expect(replay.ok && replay.data).toEqual({ ...stored, replayed: true });
    expect(planAccessibleRouteFromRequest).toHaveBeenCalledTimes(1);
    expect(finalizeReroute).toHaveBeenCalledTimes(1);
  });

  it("serializes parallel same-id retries: only the acquired request replans and finalizes", async () => {
    beginReroute
      .mockResolvedValueOnce({ status: "acquired" })
      .mockResolvedValueOnce({
        status: "replay",
        data: {
          routeToken: "committed-token",
          routeVersion: 2,
          replayed: true,
        },
      });
    const [first, second] = await Promise.all([
      rerouteAccessibleRoute({ ...request, language: "en" }),
      rerouteAccessibleRoute({ ...request, language: "en" }),
    ]);
    expect(first.ok && second.ok).toBe(true);
    expect(beginReroute).toHaveBeenCalledTimes(2);
    expect(planAccessibleRouteFromRequest).toHaveBeenCalledTimes(1);
    expect(finalizeReroute).toHaveBeenCalledTimes(1);
    expect(
      [first, second].some((result) => result.ok && result.data.replayed),
    ).toBe(true);
  });

  it.each(["stale", "conflict", "reconciling"])(
    "rejects %s same-version concurrency without calling the planner",
    async (status) => {
      beginReroute.mockResolvedValue({ status });
      const result = await rerouteAccessibleRoute(request);
      expect(result).toMatchObject({
        ok: false,
        status: ResponseCode.CONFLICT,
      });
      expect(planAccessibleRouteFromRequest).not.toHaveBeenCalled();
      expect(finalizeReroute).not.toHaveBeenCalled();
    },
  );

  it("releases the reroute lock when resume fencing rejects finalization", async () => {
    finalizeReroute.mockResolvedValue("conflict");
    await expect(rerouteAccessibleRoute(request)).resolves.toMatchObject({
      ok: false,
      status: 409,
      data: { reason: "REROUTE_CONFLICT" },
    });
    expect(releaseReroute).toHaveBeenCalledWith(
      "nav-1",
      1,
      "11111111-1111-4111-8111-111111111111",
    );
  });

  it("fails closed when Redis is unavailable and never calls the planner", async () => {
    readNavigationTokenStrict.mockResolvedValue({ status: "unavailable" });
    const result = await rerouteAccessibleRoute(request);
    expect(result).toMatchObject({
      ok: false,
      status: ResponseCode.SERVICE_UNAVAILABLE,
    });
    expect(beginReroute).not.toHaveBeenCalled();
    expect(planAccessibleRouteFromRequest).not.toHaveBeenCalled();
  });

  it("returns 410 for expired or legacy raw-route tokens", async () => {
    for (const value of [
      { status: "missing" },
      { status: "ok", value: route("legacy") },
    ]) {
      readNavigationTokenStrict.mockResolvedValueOnce(value);
      await expect(rerouteAccessibleRoute(request)).resolves.toMatchObject({
        ok: false,
        status: ResponseCode.GONE,
      });
    }
    expect(planAccessibleRouteFromRequest).not.toHaveBeenCalled();
  });

  it("releases the lock and preserves the planner's 422 no-route semantics", async () => {
    planAccessibleRouteFromRequest.mockResolvedValue({
      ok: false,
      status: ResponseCode.UNPROCESSABLE_ENTITY,
      error: "找不到可行路線",
    });
    const result = await rerouteAccessibleRoute(request);
    expect(result).toMatchObject({
      ok: false,
      status: ResponseCode.UNPROCESSABLE_ENTITY,
    });
    expect(releaseReroute).toHaveBeenCalledWith(
      "nav-1",
      1,
      request.clientRequestId,
    );
    expect(finalizeReroute).not.toHaveBeenCalled();
  });
});

it.each(["rail", "metro"] as const)(
  "keeps %s transit preference when replanning from the current location",
  async (transitPreference) => {
    readNavigationTokenStrict.mockResolvedValue({
      status: "ok",
      value: sealNavigationEnvelope({
        ...envelope,
        canonicalRequest: {
          ...canonicalRequest,
          travelMode: "transit",
          transitPreference,
        },
      }),
    });
    beginReroute.mockResolvedValue({ status: "acquired" });
    planAccessibleRouteFromRequest.mockResolvedValue({
      ok: false,
      status: 503,
      error: "fixture unavailable",
    });
    await rerouteAccessibleRoute(request);
    expect(planAccessibleRouteFromRequest).toHaveBeenLastCalledWith(
      expect.objectContaining({
        travelMode: "transit",
        transitPreference,
        origin: { latitude: 25.02, longitude: 121.02 },
      }),
    );
  },
);

it("never drops an adopted bus identity by replanning the canonical request", async () => {
  vi.clearAllMocks();
  readNavigationTokenStrict.mockResolvedValue({
    status: "ok",
    value: sealNavigationEnvelope({
      ...envelope,
      route: {
        ...envelope.route,
        legs: [selectedBus],
      },
    }),
  });
  expect(await rerouteAccessibleRoute(request)).toMatchObject({
    ok: false,
    status: 409,
    data: { reason: "BUS_SELECTION_REQUIRES_REPLAN" },
  });
  expect(beginReroute).not.toHaveBeenCalled();
  expect(planAccessibleRouteFromRequest).not.toHaveBeenCalled();
});
