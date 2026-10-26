import { beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("../../config/redis", () => ({
  redisGet: vi.fn(),
  redisSet: vi.fn(),
  redisEval: vi.fn(),
}));
import { redisGet } from "../../config/redis";
import { getRouteByToken } from "./route-token.service";
import { sealNavigationEnvelope } from "./navigation-state.repository";
vi.mock("./planners/pedestrian-a11y/graph-runtime", () => ({
  getPedGraphRuntime: vi.fn(),
  getPedGraphClient: vi.fn(),
  isPedGraphSnapshotCurrent: vi.fn(),
}));
vi.mock("./planners/pedestrian-a11y/csr-walk-planner", () => ({
  planCsrWalkRoute: vi.fn(),
}));
import {
  getPedGraphClient,
  getPedGraphRuntime,
  isPedGraphSnapshotCurrent,
  type PedGraphSnapshot,
} from "./planners/pedestrian-a11y/graph-runtime";
import { planCsrWalkRoute } from "./planners/pedestrian-a11y/csr-walk-planner";
import { findPedStopNodeId } from "./planners/pedestrian-a11y/ped-graph-geometry.repository";
import type { PedGraph } from "./planners/pedestrian-a11y/graph.types";
import type { CsrWalkPlan } from "./planners/pedestrian-a11y/csr-walk.types";
import type {
  AccessibleRoute,
  WalkLeg,
  WalkingFareAccess,
} from "../../types/route";
import {
  combineWalkingPolicy,
  hasCurrentWalkingPolicy,
  qualifyWalkingCandidates,
  walkLegFromPlan,
} from "./walking-policy.service";

const source = {
  version: "sidewalk-v1" as const,
  schemaVersion: 1 as const,
  sourceVersionId: "9",
  sourceArchiveSha256: "a".repeat(64),
  osmSha256: "b".repeat(64),
  extent: [121, 24, 122, 26] as const,
};
const graph = {
  versionId: 42,
  qualification: source,
  originalNodeId: BigInt64Array.of(10n, 20n),
  nodeStationId: Int32Array.of(0, 1),
  stationIds: ["station-A", "station-B"],
} as unknown as PedGraph;
const context = { graph } as PedGraphSnapshot;
const xy: [number, number] = [121.5, 25];
const point = { lng: xy[0], lat: xy[1] };
const plan: CsrWalkPlan = {
  policy: source,
  graphVersionId: 42,
  stairsFallback: false,
  selectedEdgeIds: ["123"],
  polyline: [xy, xy],
  distanceM: 12,
  durationS: 18,
  approximateIndoorSegmentCount: 2,
  accessibility: {
    maxSlopePercent: null,
    crossings: null,
    crossingsWithCurbRamp: null,
    minPathWidthCm: null,
    surfaceType: "unknown",
  },
  a11ySegments: [],
  a11yPoints: [],
  steps: [],
  sidewalkRampCount: 0,
  diagnostics: {
    expandedNodes: 0,
    reopenedNodes: 0,
    edgeCount: 1,
    totalCostM: 12,
    relaxationLevel: 0,
    originSnapDistanceM: 0,
    destinationSnapDistanceM: 0,
  },
};
const forbid = { mode: "forbid" as const };
const authorized = (...ids: string[]): WalkingFareAccess => ({
  mode: "transit_authorized",
  authorizedStationIds: ids,
});
const walk = (fareAccess?: WalkingFareAccess) =>
  walkLegFromPlan(
    { ...plan, ...(fareAccess ? { fareAccess } : {}) },
    "normal",
    false,
    "from",
    "to",
  );
const rail = (departure = "stop-A", arrival = "stop-B") =>
  ({
    type: "METRO",
    departureStationUid: departure,
    arrivalStationUid: arrival,
    polyline: [xy, xy],
  }) as AccessibleRoute["legs"][number];
const route = (legs: AccessibleRoute["legs"]): AccessibleRoute =>
  ({
    legs,
    walkingPolicy: combineWalkingPolicy(
      legs.filter((l): l is WalkLeg => l.type === "WALK"),
    ),
  }) as AccessibleRoute;
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(isPedGraphSnapshotCurrent).mockResolvedValue(true);
  vi.mocked(getPedGraphRuntime).mockResolvedValue({
    status: "ready",
    snapshot: context,
  });
  vi.mocked(getPedGraphClient).mockResolvedValue({
    query: async <R>(_sql: string, params?: unknown[]) => ({
      rows: (params?.[1] === "gtfs_pathways:stop:stop-A"
        ? [{ node_id: "10" }]
        : params?.[1] === "gtfs_pathways:stop:stop-B"
          ? [{ node_id: "20" }]
          : []) as R[],
    }),
  });
  vi.mocked(planCsrWalkRoute).mockImplementation(async (_points, options) => ({
    status: "ok",
    plans: [{ ...plan, fareAccess: options.fareAccess }],
  }));
});
describe("server-derived adjacent rail fare context", () => {
  it("binds prefix and egress even at coincident XY, pinning context and only adjacent station", async () => {
    const result = await qualifyWalkingCandidates([route([rail()])], {
      origin: point,
      destination: point,
      mode: "normal",
      avoidStairs: false,
      completeTransitEndpoints: true,
      deadlineMs: Date.now() + 10000,
      context,
    });
    expect(result.status).toBe("ok");
    const calls = vi.mocked(planCsrWalkRoute).mock.calls;
    expect(calls).toHaveLength(2);
    expect(calls[0][0]).toEqual([point, { ...point, stopId: "stop-A" }]);
    expect(calls[1][0]).toEqual([{ ...point, stopId: "stop-B" }, point]);
    expect(calls.map((c) => c[1].fareAccess)).toEqual([
      authorized("station-A"),
      authorized("station-B"),
    ]);
    expect(calls.every((c) => c[1].context === context)).toBe(true);
    expect(result.routes[0].walkingPolicy?.fareAccess).toEqual(
      authorized("station-A", "station-B"),
    );
  });
  it("gives transfer WALK only its immediately adjacent alighting and boarding stations", async () => {
    const result = await qualifyWalkingCandidates(
      [route([rail("unknown", "stop-B"), walk(), rail("stop-A", "unknown")])],
      {
        origin: point,
        destination: point,
        mode: "normal",
        avoidStairs: false,
        deadlineMs: Date.now() + 10000,
        context,
      },
    );
    expect(result.status).toBe("ok");
    const [points, options] = vi.mocked(planCsrWalkRoute).mock.calls[0];
    expect(points).toEqual([
      { ...point, stopId: "stop-B" },
      { ...point, stopId: "stop-A" },
    ]);
    expect(options.fareAccess).toEqual(authorized("station-A", "station-B"));
  });
  it("keeps unknown legacy rail identity outdoor-only without a claimed indoor scope", async () => {
    await qualifyWalkingCandidates(
      [route([walk(), rail("legacy", "legacy")])],
      {
        origin: point,
        destination: point,
        mode: "normal",
        avoidStairs: false,
        deadlineMs: Date.now() + 10000,
        context,
      },
    );
    const [points, options] = vi.mocked(planCsrWalkRoute).mock.calls[0];
    expect(points).toEqual([point, point]);
    expect(options.fareAccess).toEqual(forbid);
  });
  it("keeps bus and public pure walking forbidden", async () => {
    const bus = {
      type: "BUS",
      polyline: [xy, xy],
    } as AccessibleRoute["legs"][number];
    await qualifyWalkingCandidates(
      [route([walk(), bus, walk()]), route([walk()])],
      {
        origin: point,
        destination: point,
        mode: "normal",
        avoidStairs: false,
        deadlineMs: Date.now() + 10000,
        context,
      },
    );
    expect(vi.mocked(planCsrWalkRoute).mock.calls).toHaveLength(3);
    expect(
      vi
        .mocked(planCsrWalkRoute)
        .mock.calls.every((c) => c[1].fareAccess?.mode === "forbid"),
    ).toBe(true);
  });
  it("merges fare scope deterministically without losing edges or stairs", () => {
    const a = walk(authorized("station-B")),
      b = walk(authorized("station-A"));
    b.walkingPolicy!.stairsFallback = true;
    b.walkingPolicy!.selectedEdgeIds = ["456"];
    expect(combineWalkingPolicy([a, b])).toMatchObject({
      fareAccess: authorized("station-A", "station-B"),
      stairsFallback: true,
      selectedEdgeIds: ["123", "456"],
    });
    b.walkingPolicy!.graphVersionId = 43;
    expect(combineWalkingPolicy([a, b])).toBeUndefined();
  });
});
function sealedRoute(value: AccessibleRoute): string {
  return JSON.stringify(
    sealNavigationEnvelope({
      schemaVersion: 1,
      navigationId: "nav",
      routeVersion: 1,
      route: { ...value, navigationId: "nav", routeVersion: 1 },
      canonicalRequest: {
        origin: { latitude: 25, longitude: 121.5 },
        destination: { latitude: 25, longitude: 121.5 },
        userLocation: { latitude: 25, longitude: 121.5 },
        travelMode: "transit",
        mode: "normal",
        maxTransfers: 2,
        format: "standard",
        waypoints: [],
        avoidStairs: false,
        requireElevator: false,
        needsAccessibleToilet: false,
        needsHandrail: false,
      },
    }),
  );
}

describe("cached/token walking proof currentness", () => {
  it("accepts genuine no-WALK transit but rejects orphaned walking evidence", async () => {
    const transit = route([rail()]);
    expect(await hasCurrentWalkingPolicy(transit)).toBe(true);
    transit.walkingPolicy = combineWalkingPolicy([walk()]);
    expect(await hasCurrentWalkingPolicy(transit)).toBe(false);
    expect(getPedGraphRuntime).not.toHaveBeenCalled();
  });
  it("rejects currentness failures even when runtime still returns a ready snapshot", async () => {
    vi.mocked(isPedGraphSnapshotCurrent).mockResolvedValue(false);
    expect(await hasCurrentWalkingPolicy(route([walk()]))).toBe(false);
    expect(isPedGraphSnapshotCurrent).toHaveBeenCalledWith(context);
  });
  it("actual token resolution rejects changed rail, unrelated and diagnostic authority", async () => {
    const valid = route([walk(authorized("station-A")), rail()]);
    vi.mocked(redisGet).mockResolvedValue(sealedRoute(valid));
    expect(await getRouteByToken("fixture-token")).toEqual(
      JSON.parse(sealedRoute(valid)).route,
    );
    const changed = route([walk(authorized("station-A")), rail("stop-B")]);
    vi.mocked(redisGet).mockResolvedValue(sealedRoute(changed));
    expect(await getRouteByToken("fixture-token")).toBeNull();
    const unrelated = route([walk(authorized("unrelated")), rail()]);
    vi.mocked(redisGet).mockResolvedValue(sealedRoute(unrelated));
    expect(await getRouteByToken("fixture-token")).toBeNull();
    const diagnostic = JSON.parse(JSON.stringify(valid));
    diagnostic.walkingPolicy.fareAccess = { mode: "diagnostic_allow_all" };
    vi.mocked(redisGet).mockResolvedValue(sealedRoute(diagnostic));
    expect(await getRouteByToken("fixture-token")).toBeNull();
  });
  it("accepts an actual adjacent known rail scope and matching route union", async () => {
    expect(
      await hasCurrentWalkingPolicy(
        route([
          walk(authorized("station-A")),
          rail(),
          walk(authorized("station-B")),
        ]),
      ),
    ).toBe(true);
  });
  it("does not force GTFS lookups for older fixtures with no fare evidence", async () => {
    expect(await hasCurrentWalkingPolicy(route([walk(), rail(), walk()]))).toBe(
      true,
    );
    expect(getPedGraphClient).not.toHaveBeenCalled();
  });
  it.each([
    { mode: "diagnostic_allow_all" },
    { mode: "transit_authorized", authorizedStationIds: [] },
    { mode: "transit_authorized", authorizedStationIds: [" station-A"] },
    {
      mode: "transit_authorized",
      authorizedStationIds: ["station-A", "station-A"],
    },
    { mode: "transit_authorized", authorizedStationIds: ["unrelated"] },
    { mode: "forbid", authorizedStationIds: ["station-A"] },
  ])("rejects malformed or unrelated cached authorization %j", async (fare) => {
    const cached = route([walk(authorized("station-A")), rail()]);
    (cached.legs[0] as WalkLeg).walkingPolicy!.fareAccess =
      fare as WalkingFareAccess;
    expect(await hasCurrentWalkingPolicy(cached)).toBe(false);
  });
  it("rejects changed rail identity, unrelated route union and unexpected pure walk authorization", async () => {
    expect(
      await hasCurrentWalkingPolicy(
        route([walk(authorized("station-A")), rail("stop-B")]),
      ),
    ).toBe(false);
    expect(
      await hasCurrentWalkingPolicy(route([walk(authorized("station-A"))])),
    ).toBe(false);
    const cached = route([walk(authorized("station-A")), rail()]);
    cached.walkingPolicy!.fareAccess = authorized("station-A", "station-B");
    expect(await hasCurrentWalkingPolicy(cached)).toBe(false);
  });
});
describe("complete alternative search before stairs fallback", () => {
  it.each(["unavailable", "budget_exhausted"] as const)(
    "does not infer no step-free alternative after %s",
    async (status) => {
      vi.mocked(planCsrWalkRoute)
        .mockResolvedValueOnce({
          status: "ok",
          plans: [{ ...plan, stairsFallback: true }],
        })
        .mockResolvedValueOnce(
          status === "unavailable"
            ? { status, reason: "fixture unavailable" }
            : { status },
        );
      const result = await qualifyWalkingCandidates(
        [route([walk()]), route([walk()])],
        {
          origin: point,
          destination: point,
          mode: "wheelchair",
          avoidStairs: true,
          deadlineMs: Date.now() + 10000,
          context,
        },
      );
      expect(result).toEqual({ status, routes: [] });
    },
  );
  it("still serves a proven step-free route when another alternative is unavailable", async () => {
    vi.mocked(planCsrWalkRoute)
      .mockResolvedValueOnce({ status: "ok", plans: [plan] })
      .mockResolvedValueOnce({
        status: "unavailable",
        reason: "fixture unavailable",
      });
    const result = await qualifyWalkingCandidates(
      [route([walk()]), route([walk()])],
      {
        origin: point,
        destination: point,
        mode: "wheelchair",
        avoidStairs: true,
        deadlineMs: Date.now() + 10000,
        context,
      },
    );
    expect(result.status).toBe("ok");
    expect(result.routes).toHaveLength(1);
    expect(result.routes[0].walkingPolicy?.stairsFallback).toBe(false);
  });
  it("marks a reselected WALK-only provider answer as the actual CSR engine", async () => {
    const result = await qualifyWalkingCandidates([route([walk()])], {
      origin: point,
      destination: point,
      mode: "normal",
      avoidStairs: false,
      deadlineMs: Date.now() + 10000,
      context,
    });
    expect(result.status).toBe("ok");
    expect(result.routes[0].engine).toBe("pedestrian-a11y");
  });
});

describe("versioned exact stop lookup", () => {
  it("passes exact source_ref and pinned version, rejects duplicate rows", async () => {
    const query = vi.fn(async () => ({ rows: [{ node_id: "10" }] }));
    await expect(
      findPedStopNodeId({ query } as never, 42, "stop-A"),
    ).resolves.toBe("10");
    expect(query.mock.calls[0]).toEqual([
      expect.stringContaining("version_id=$1 AND source_ref=$2"),
      [42, "gtfs_pathways:stop:stop-A"],
    ]);
    query.mockResolvedValue({ rows: [{ node_id: "10" }, { node_id: "20" }] });
    await expect(
      findPedStopNodeId({ query } as never, 42, "stop-A"),
    ).rejects.toThrow("ambiguous");
  });
});
