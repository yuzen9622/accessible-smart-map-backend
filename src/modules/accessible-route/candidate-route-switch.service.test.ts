import {
  attachRoadMatchingData,
  getRoadMatchingData,
  geometrySha256,
} from "../../utils/road-matching-data";
import type { AccessibleRoute } from "../../types/route";
import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  read: vi.fn(),
  begin: vi.fn(),
  finalize: vi.fn(),
  release: vi.fn(),
  resolve: vi.fn(),
  recover: vi.fn(),
  instructions: vi.fn(),
  steps: vi.fn(),
}));
vi.mock("./navigation-state.repository", () => ({
  readNavigationTokenStrict: mocks.read,
  beginReroute: mocks.begin,
  finalizeReroute: mocks.finalize,
  releaseReroute: mocks.release,
  resolveCandidateDecision: mocks.resolve,
  recoverCandidateDecision: mocks.recover,
}));
vi.mock("./bus-plan.repository", () => ({ storeBusPlan: vi.fn() }));
vi.mock("../../utils/nav-instructions-engine", () => ({
  generateNavInstructions: mocks.instructions,
  generateNavStepsWithLegIndex: mocks.steps,
}));
import { switchNavigationCandidate } from "./candidate-route-switch.service";
const route = {
  routeId: "r",
  navigationId: "n",
  routeVersion: 1,
  routeName: "walk",
  totalMinutes: 2,
  transferCount: 0,
  legs: [],
  accessibilityHighlights: [],
};
const envelope = {
  schemaVersion: 1,
  navigationId: "n",
  routeVersion: 1,
  route,
  canonicalRequest: { requireElevator: true },
};
const snapshot = {
  navigationId: "n",
  routeToken: "old",
  routeVersion: 1,
  userId: "u",
  currentStepIndex: 0,
  onVehicle: false,
  latestPosition: null,
  updatedAt: 1,
};

function metadataRoute(edge: string): AccessibleRoute {
  const route: AccessibleRoute = {
    routeId: "road",
    navigationId: "n",
    routeVersion: 1,
    routeName: "road",
    totalMinutes: 1,
    transferCount: 0,
    accessibilityHighlights: [],
    roadNetwork: {
      tilesetId: "tiles",
      sourcePbfSha256: null,
      provenance: "unverified",
    },
    legs: [
      {
        type: "DRIVE",
        from: { lat: 25, lng: 121 },
        to: { lat: 25, lng: 121.001 },
        distanceM: 100,
        durationMin: 1,
        polyline: [
          [121, 25],
          [121.001, 25],
        ],
        steps: [
          {
            instruction: "出發",
            maneuver: "DEPART",
            distanceM: 100,
            durationMin: 1,
            polyline: [
              [121, 25],
              [121.001, 25],
            ],
          },
        ],
      },
    ],
  };
  attachRoadMatchingData(route, {
    tilesetId: "tiles",
    legs: [
      {
        legIndex: 0,
        geometrySha256: geometrySha256(route.legs[0].polyline),
        spans: [
          {
            fromIndex: 0,
            toIndex: 1,
            directedEdgeId: edge,
            osmWayId: "456",
            osmForward: true,
          },
        ],
      },
    ],
  });
  return route;
}
describe("candidate switch transaction", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.read.mockResolvedValue({ status: "ok", value: envelope });
    mocks.begin.mockResolvedValue({ status: "acquired" });
    mocks.finalize.mockResolvedValue("ok");
    mocks.resolve.mockResolvedValue("ADOPTED");
    mocks.instructions.mockReturnValue({
      ok: true,
      data: { instructions: [], warnings: [] },
    });
    mocks.steps.mockReturnValue({ ok: true, steps: [], warnings: [] });
  });
  const run = (overrides = {}) =>
    switchNavigationCandidate({
      activeToken: "old",
      previousVersion: 1,
      candidateToken: "candidate",
      proposalId: "p",
      snapshot,
      isAuthorized: () => true,
      isNavigationCurrent: () => true,
      prepare: () => true,
      adopt: vi.fn(),
      ...overrides,
    });
  it.each([true, false])(
    "restores only candidate private data from JSON (candidate metadata=%s)",
    async (hasNew) => {
      const oldRoute = metadataRoute("111");
      const fresh = metadataRoute("222");
      mocks.read.mockResolvedValueOnce({
        status: "ok",
        value: {
          ...envelope,
          route: oldRoute,
          roadMatching: getRoadMatchingData(oldRoute),
        },
      });
      mocks.read.mockResolvedValueOnce({
        status: "ok",
        value: JSON.parse(
          JSON.stringify({
            ...envelope,
            route: fresh,
            ...(hasNew ? { roadMatching: getRoadMatchingData(fresh) } : {}),
          }),
        ),
      });
      const prepare = vi.fn(() => true);
      expect((await run({ prepare })).status).toBe("adopted");
      const saved = mocks.finalize.mock.calls[0][3];
      expect(saved.roadMatching).toEqual(
        hasNew ? getRoadMatchingData(fresh) : undefined,
      );
      expect(getRoadMatchingData(saved.route)).toEqual(saved.roadMatching);
      expect(prepare.mock.calls.length).toBe(1);
      expect(JSON.stringify(saved.route)).not.toContain("directedEdgeId");
    },
  );
  it("publishes durable ADOPTED despite a newer utterance", async () => {
    let authorized = true;
    const adopt = vi.fn();
    mocks.resolve.mockImplementation(async () => {
      authorized = false;
      return "ADOPTED";
    });
    expect(
      (
        await run({
          isAuthorized: () => authorized,
          isNavigationCurrent: () => true,
          adopt,
        })
      ).status,
    ).toBe("adopted");
    expect(adopt).toHaveBeenCalledOnce();
  });
  it("durable ADOPTED does not publish over a UI selection or stop", async () => {
    let navigationCurrent = true;
    const adopt = vi.fn();
    mocks.resolve.mockImplementation(async () => {
      navigationCurrent = false;
      return "ADOPTED";
    });
    await run({
      isAuthorized: () => true,
      isNavigationCurrent: () => navigationCurrent,
      adopt,
    });
    expect(adopt).not.toHaveBeenCalled();
  });
  it("exhausted retries release the local gate and a later operation recovers", async () => {
    vi.useFakeTimers();
    try {
      const retryEnvelope = {
        ...envelope,
        navigationId: "retry-nav",
        route: { ...route, navigationId: "retry-nav" },
      };
      mocks.read.mockResolvedValue({ status: "ok", value: retryEnvelope });
      const retrySnapshot = { ...snapshot, navigationId: "retry-nav" };
      mocks.begin.mockResolvedValue({ status: "reconciling" });
      mocks.recover.mockResolvedValue("unavailable");
      const onReconciled = vi.fn();
      expect(
        (await run({ onReconciled, snapshot: retrySnapshot })).status,
      ).toBe("reconciling");
      await vi.advanceTimersByTimeAsync(40_000);
      expect(onReconciled).toHaveBeenCalledWith("retry_exhausted");
      mocks.recover.mockResolvedValue("ROLLED_BACK");
      await run({ onReconciled, snapshot: retrySnapshot });
      await vi.advanceTimersByTimeAsync(250);
      expect(onReconciled).toHaveBeenCalledWith("ROLLED_BACK");
    } finally {
      vi.useRealTimers();
    }
  });
  it("notifies every bridge waiting on the same reconciliation", async () => {
    vi.useFakeTimers();
    try {
      const waiterEnvelope = {
        ...envelope,
        navigationId: "waiters-nav",
        route: { ...route, navigationId: "waiters-nav" },
      };
      const waiterSnapshot = { ...snapshot, navigationId: "waiters-nav" };
      mocks.read.mockResolvedValue({ status: "ok", value: waiterEnvelope });
      mocks.begin.mockResolvedValue({ status: "reconciling" });
      mocks.recover.mockResolvedValue("ROLLED_BACK");
      const first = vi.fn();
      const second = vi.fn();

      await Promise.all([
        run({ onReconciled: first, snapshot: waiterSnapshot }),
        run({ onReconciled: second, snapshot: waiterSnapshot }),
      ]);
      await vi.advanceTimersByTimeAsync(250);

      expect(first).toHaveBeenCalledWith("ROLLED_BACK");
      expect(second).toHaveBeenCalledWith("ROLLED_BACK");
      expect(mocks.recover).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });
  it("strict-read failure never acquires or mutates", async () => {
    mocks.read.mockResolvedValue({ status: "missing" });
    expect((await run()).status).toBe("failed");
    expect(mocks.begin).not.toHaveBeenCalled();
  });
  it("validates independent session before finalizing", async () => {
    expect((await run({ prepare: () => false })).status).toBe("failed");
    expect(mocks.finalize).not.toHaveBeenCalled();
    expect(mocks.release).toHaveBeenCalled();
  });
  it("preserves active identity, next version and candidate canonical constraints", async () => {
    const adopt = vi.fn();
    expect((await run({ adopt })).status).toBe("adopted");
    const [, , , next] = mocks.finalize.mock.calls[0];
    expect(next.navigationId).toBe("n");
    expect(next.routeVersion).toBe(2);
    expect(next.canonicalRequest.requireElevator).toBe(true);
    expect(mocks.resolve).toHaveBeenCalledWith(
      expect.anything(),
      next,
      expect.anything(),
      "adopt",
      expect.objectContaining({ routeVersion: 2 }),
    );
    expect(adopt).toHaveBeenCalledOnce();
  });
  it("carries the candidate's venue legs in the new token, not on its route", async () => {
    const venueLegs = { arrival: { venueId: "nutc-sanmin", steps: [] } };
    mocks.read.mockResolvedValue({
      status: "ok",
      value: { ...envelope, venueLegs },
    });
    const prepare = vi.fn(() => true);
    await run({ prepare });
    const [, , , next] = mocks.finalize.mock.calls[0];
    expect(next.venueLegs).toEqual(venueLegs);
    expect(next.route).not.toHaveProperty("venueLegs");
    expect(prepare).toHaveBeenCalledWith(
      expect.objectContaining({
        route: expect.not.objectContaining({ venueLegs }),
      }),
      expect.objectContaining({ venueLegs }),
    );
  });
  it("stale preparation releases without finalizing", async () => {
    let current = true;
    await run({
      isAuthorized: () => current,
      prepare: () => {
        current = false;
        return true;
      },
    });
    expect(mocks.finalize).not.toHaveBeenCalled();
  });
  it("ambiguous finalize probes before adoption", async () => {
    mocks.finalize.mockResolvedValue("unavailable");
    mocks.resolve
      .mockResolvedValueOnce("PENDING_DECISION")
      .mockResolvedValueOnce("ADOPTED");
    expect((await run()).status).toBe("adopted");
    expect(mocks.resolve.mock.calls.map((c) => c[3])).toEqual([
      "probe",
      "adopt",
    ]);
  });
  it("unavailable probe returns reconciling, never ordinary failure", async () => {
    mocks.finalize.mockResolvedValue("unavailable");
    mocks.resolve.mockResolvedValue("unavailable");
    expect((await run()).status).toBe("reconciling");
    expect(mocks.release).not.toHaveBeenCalled();
  });
  it("lost adoption reply confirmed ADOPTED never rolls back", async () => {
    mocks.resolve
      .mockResolvedValueOnce("unavailable")
      .mockResolvedValueOnce("ADOPTED");
    expect((await run()).status).toBe("adopted");
    expect(mocks.resolve.mock.calls.map((c) => c[3])).toEqual([
      "adopt",
      "probe",
    ]);
  });
});
