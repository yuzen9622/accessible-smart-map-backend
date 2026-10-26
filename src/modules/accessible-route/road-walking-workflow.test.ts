import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  AccessibleRoute,
  DriveLeg,
  WalkAccessRequest,
} from "../../types/route";
import type { PedGraphSnapshot } from "./planners/pedestrian-a11y/graph-runtime";
import type { CsrWalkPlan } from "./planners/pedestrian-a11y/csr-walk.types";
import { getPedGraphRuntime } from "./planners/pedestrian-a11y/graph-runtime";
import { planCsrWalkRoute } from "./planners/pedestrian-a11y/csr-walk-planner";
import {
  hasCurrentWalkingPolicy,
  qualifyWalkingCandidates,
  recomputeRoadClock,
} from "./walking-policy.service";

vi.mock("./planners/pedestrian-a11y/graph-runtime", () => ({
  getPedGraphRuntime: vi.fn(),
  getPedGraphClient: vi.fn(),
}));
vi.mock("./planners/pedestrian-a11y/csr-walk-planner", () => ({
  planCsrWalkRoute: vi.fn(),
}));
const point = (lng: number) => ({ lat: 25, lng });
const xy = (lng: number): [number, number] => [lng, 25];
const source = {
  version: "sidewalk-v1" as const,
  schemaVersion: 1 as const,
  sourceVersionId: "9",
  sourceArchiveSha256: "a".repeat(64),
  osmSha256: "b".repeat(64),
  extent: [121, 24, 122, 26] as const,
};
const context = {
  graph: { versionId: 42, qualification: source },
} as PedGraphSnapshot;
const plan: CsrWalkPlan = {
  policy: source,
  graphVersionId: 42,
  stairsFallback: false,
  selectedEdgeIds: ["123"],
  polyline: [xy(121.5), xy(121.501)],
  distanceM: 137,
  durationS: 18.5,
  approximateIndoorSegmentCount: 0,
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
    totalCostM: 137,
    relaxationLevel: 0,
    originSnapDistanceM: 0,
    destinationSnapDistanceM: 0,
  },
};
const drive = (from: number, to: number): DriveLeg => ({
  type: "DRIVE",
  from: point(from),
  to: point(to),
  distanceM: 100,
  durationMin: 2,
  polyline: [xy(from), xy(to)],
});
const request = (
  beforeLegIndex: number,
  from: number,
  to: number,
  role: WalkAccessRequest["role"],
): WalkAccessRequest => ({
  beforeLegIndex,
  fromAnchor: point(from),
  toAnchor: point(to),
  from: "from",
  to: "to",
  role,
  ...(role === "waypoint" ? { waypointIndex: 1 } : {}),
});
const route = (
  legs: DriveLeg[],
  requests?: WalkAccessRequest[],
): AccessibleRoute => ({
  routeId: "road",
  routeName: "road",
  totalMinutes: 4,
  transferCount: 0,
  totalWalkDistanceM: 0,
  accessibilityHighlights: [],
  legs,
  ...(requests ? { _walkAccessRequests: requests } : {}),
});
const options = () => ({
  origin: point(121.5),
  destination: point(121.505),
  mode: "wheelchair" as const,
  avoidStairs: true,
  deadlineMs: Date.now() + 10000,
  departureTimeMs: Date.parse("2035-01-01T10:00:00+08:00"),
});
beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(getPedGraphRuntime).mockResolvedValue({
    status: "ready",
    snapshot: context,
  });
  vi.mocked(planCsrWalkRoute).mockImplementation(async (points, opts) => ({
    status: "ok",
    plans: [
      {
        ...plan,
        polyline: points.map((p) => [p.lng, p.lat]),
        fareAccess: opts.fareAccess,
      },
    ],
  }));
});

describe("mandatory road walking obligations", () => {
  it("does not load a national snapshot for a pure vehicle candidate", async () => {
    const getSnapshot = vi.fn();
    expect(
      (
        await qualifyWalkingCandidates([route([drive(121.5, 121.505)])], {
          ...options(),
          getSnapshot,
        })
      ).status,
    ).toBe("ok");
    expect(getSnapshot).not.toHaveBeenCalled();
    expect(getPedGraphRuntime).not.toHaveBeenCalled();
  });
  it("requires graph readiness for all-vehicle legs with pending access", async () => {
    const candidate = route(
      [drive(121.501, 121.505)],
      [request(0, 121.5, 121.501, "origin")],
    );
    const getSnapshot = vi.fn(async () => undefined);
    expect(
      await qualifyWalkingCandidates([candidate], {
        ...options(),
        getSnapshot,
      }),
    ).toEqual({ status: "unavailable", routes: [] });
    expect(getSnapshot).toHaveBeenCalledTimes(1);
    expect(planCsrWalkRoute).not.toHaveBeenCalled();
    expect(getPedGraphRuntime).not.toHaveBeenCalled();
  });
  it("fulfills every seam in order with forbidden fare and one captured context/deadline", async () => {
    const candidate = route(
      [drive(121.501, 121.502), drive(121.504, 121.5045)],
      [
        request(0, 121.5, 121.501, "origin"),
        request(1, 121.502, 121.503, "waypoint"),
        request(1, 121.503, 121.504, "waypoint"),
        request(2, 121.5045, 121.505, "destination"),
      ],
    );
    const getSnapshot = vi.fn(async () => context);
    const opts = { ...options(), getSnapshot };
    const result = await qualifyWalkingCandidates([candidate, candidate], opts);
    expect(result.status).toBe("ok");
    expect(getSnapshot).toHaveBeenCalledTimes(1);
    const calls = vi.mocked(planCsrWalkRoute).mock.calls;
    expect(calls).toHaveLength(8);
    expect(calls.slice(0, 4).map(([points]) => points)).toEqual(
      candidate._walkAccessRequests?.map((r) => [r.fromAnchor, r.toAnchor]),
    );
    expect(
      calls.every(
        ([, o]) =>
          o.context === context &&
          o.deadlineMs === opts.deadlineMs &&
          o.mode === "wheelchair" &&
          o.avoidStairs &&
          o.fareAccess?.mode === "forbid",
      ),
    ).toBe(true);
    const selected = result.routes[0];
    expect(selected.legs.map((l) => l.type)).toEqual([
      "WALK",
      "DRIVE",
      "WALK",
      "WALK",
      "DRIVE",
      "WALK",
    ]);
    expect(selected).not.toHaveProperty("_walkAccessRequests");
    expect(JSON.stringify(selected)).not.toContain("_walkAccessRequests");
    expect(candidate._walkAccessRequests).toHaveLength(4);
    expect(selected.totalWalkDistanceM).toBe(548);
    expect(
      selected._accessibilityHighlightMessages?.map((m) => [
        m.code,
        m.params?.distanceM,
      ]),
    ).toEqual([
      ["ROUTE_WALK_FROM_ORIGIN", 137],
      ["ROUTE_WALK_WAYPOINT_PARKING", 274],
      ["ROUTE_WALK_TO_DESTINATION", 137],
    ]);
    expect(Date.parse(selected.arrivalTime!) - opts.departureTimeMs).toBe(
      (4 * 18.5 + 4 * 60) * 1000,
    );
    (selected.legs[1] as DriveLeg).durationInTrafficMin = 3;
    recomputeRoadClock(selected);
    expect(Date.parse(selected.arrivalTime!) - opts.departureTimeMs).toBe(
      (4 * 18.5 + 5 * 60) * 1000,
    );
    expect(selected.totalMinutes).toBe(6);
  });
  it.each(["no_route", "unavailable", "budget_exhausted"] as const)(
    "discards the whole candidate if a required waypoint departure is %s",
    async (status) => {
      const candidate = route(
        [drive(121.5, 121.502), drive(121.504, 121.505)],
        [
          request(1, 121.502, 121.503, "waypoint"),
          request(1, 121.503, 121.504, "waypoint"),
        ],
      );
      vi.mocked(planCsrWalkRoute)
        .mockResolvedValueOnce({ status: "ok", plans: [plan] })
        .mockResolvedValueOnce(
          status === "unavailable"
            ? { status, reason: "test" }
            : status === "no_route"
              ? { status: "topology_disconnected" }
              : { status },
        );
      expect(
        await qualifyWalkingCandidates([candidate], { ...options(), context }),
      ).toEqual({ status, routes: [] });
    },
  );
  it("preserves proven no_route when later mandatory requests were never attempted", async () => {
    const candidate = route(
      [drive(121.501, 121.504)],
      [
        request(0, 121.5, 121.501, "origin"),
        request(1, 121.504, 121.505, "destination"),
      ],
    );
    vi.mocked(planCsrWalkRoute).mockResolvedValueOnce({
      status: "topology_disconnected",
    });
    expect(
      await qualifyWalkingCandidates([candidate], { ...options(), context }),
    ).toEqual({ status: "no_route", routes: [] });
    expect(planCsrWalkRoute).toHaveBeenCalledTimes(1);
  });
  it("strips even an empty private sidecar without loading a graph", async () => {
    const candidate = route([drive(121.5, 121.505)], []);
    const result = await qualifyWalkingCandidates([candidate], options());
    expect(result.routes[0]).not.toHaveProperty("_walkAccessRequests");
    expect(candidate).toHaveProperty("_walkAccessRequests");
    expect(getPedGraphRuntime).not.toHaveBeenCalled();
  });
  it("rejects an incoherent request anchor without connecting an arbitrary chord", async () => {
    const candidate = route(
      [drive(121.501, 121.505)],
      [request(0, 121.499, 121.501, "origin")],
    );
    expect(
      await qualifyWalkingCandidates([candidate], { ...options(), context }),
    ).toEqual({ status: "unavailable", routes: [] });
    expect(planCsrWalkRoute).not.toHaveBeenCalled();
  });
  it("rejects a fulfilled request ending away from the following drive seam", async () => {
    const candidate = route(
      [drive(121.502, 121.505)],
      [request(0, 121.5, 121.501, "origin")],
    );
    expect(
      await qualifyWalkingCandidates([candidate], { ...options(), context }),
    ).toEqual({ status: "unavailable", routes: [] });
  });
  it("fails closed on cached pending obligations, without even loading the graph", async () => {
    const candidate = route(
      [drive(121.501, 121.505)],
      [request(0, 121.5, 121.501, "origin")],
    );
    expect(await hasCurrentWalkingPolicy(candidate)).toBe(false);
    expect(getPedGraphRuntime).not.toHaveBeenCalled();
  });
  it("does not refresh an expired request budget", async () => {
    const candidate = route(
      [drive(121.501, 121.505)],
      [request(0, 121.5, 121.501, "origin")],
    );
    const getSnapshot = vi.fn(async () => context);
    expect(
      await qualifyWalkingCandidates([candidate], {
        ...options(),
        deadlineMs: Date.now() - 1,
        getSnapshot,
      }),
    ).toEqual({ status: "budget_exhausted", routes: [] });
    expect(getSnapshot).not.toHaveBeenCalled();
  });
});
