import { sealNavigationEnvelope } from "./navigation-state.repository";
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
vi.mock("./navigation-state.repository", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./navigation-state.repository")>()),
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
const envelope = sealNavigationEnvelope({
  schemaVersion: 1,
  navigationId: "n",
  routeVersion: 1,
  route,
  canonicalRequest: {
    origin: { latitude: 25, longitude: 121 },
    destination: { latitude: 25.1, longitude: 121.1 },
    userLocation: { latitude: 25, longitude: 121 },
    travelMode: "walk",
    mode: "normal",
    maxTransfers: 2,
    format: "standard",
    waypoints: [],
    avoidStairs: false,
    requireElevator: true,
    needsAccessibleToilet: false,
    needsHandrail: false,
  },
});
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
      const retryEnvelope = sealNavigationEnvelope({
        ...envelope,
        navigationId: "retry-nav",
        route: { ...route, navigationId: "retry-nav" },
      });
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
      const waiterEnvelope = sealNavigationEnvelope({
        ...envelope,
        navigationId: "waiters-nav",
        route: { ...route, navigationId: "waiters-nav" },
      });
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
