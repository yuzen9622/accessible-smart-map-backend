import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as redisConfig from "../../config/redis";
import { TRAFFIC_REFRESH } from "../../config/traffic";
import type { LiveSection } from "../../types/traffic";
import * as flowService from "./traffic-flow.service";
import {
  refreshAllLiveTraffics,
  scheduleLiveRefresh,
} from "./traffic-live.worker";

vi.mock("../../config/redis", () => ({
  redisSetNx: vi.fn(),
}));

vi.mock("./traffic-flow.service", () => ({
  refreshCityLiveTraffics: vi.fn(),
}));

const mockedRedisSetNx = vi.mocked(redisConfig.redisSetNx);
const mockedRefreshCity = vi.mocked(flowService.refreshCityLiveTraffics);

const ROUND_DEADLINE_MS = TRAFFIC_REFRESH.lockTtlSec * 1000 * 0.9;

interface RoundOutcome {
  result: { refreshed: number; skipped: boolean; skippedTargets: number };
  elapsedMs: number;
}

/**
 * @param run Round starter, defaulting to the statically imported worker.
 * @param advanceByMs Fake time to advance while the round is in flight.
 * @returns The round result plus the fake wall-clock it took, measured when the
 * round actually settled rather than after the timers finished advancing.
 */
async function runRound(
  run: () => Promise<RoundOutcome["result"]> = refreshAllLiveTraffics,
  advanceByMs: number = TRAFFIC_REFRESH.lockTtlSec * 1000,
): Promise<RoundOutcome> {
  const startedAt = Date.now();
  const pending = run().then((result) => ({
    result,
    elapsedMs: Date.now() - startedAt,
  }));
  await vi.advanceTimersByTimeAsync(advanceByMs);
  return pending;
}

describe("traffic-live.worker", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  describe("refreshAllLiveTraffics", () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it("skips refresh when redis lock cannot be acquired", async () => {
      mockedRedisSetNx.mockResolvedValueOnce(false);

      const result = await refreshAllLiveTraffics();
      expect(result).toEqual({
        refreshed: 0,
        skipped: true,
        skippedTargets: 0,
      });
      expect(mockedRefreshCity).not.toHaveBeenCalled();
    });

    it("refreshes live-supported targets and never calls the live endpoint for NewTaipei", async () => {
      mockedRedisSetNx.mockResolvedValueOnce(true);
      mockedRefreshCity.mockResolvedValue([
        { sectionId: "sec-1", congestionLevel: 1 },
      ]);

      const { result } = await runRound();
      expect(result.skipped).toBe(false);
      expect(mockedRefreshCity).toHaveBeenCalledWith("Taipei");
      expect(mockedRefreshCity).toHaveBeenCalledWith("Taichung");
      expect(mockedRefreshCity).toHaveBeenCalledWith("Freeway");
      expect(mockedRefreshCity).toHaveBeenCalledWith("Highway");
      expect(mockedRefreshCity).not.toHaveBeenCalledWith("NewTaipei");
    });

    it("covers every target when there are more targets than one batch holds", async () => {
      mockedRedisSetNx.mockResolvedValueOnce(true);
      mockedRefreshCity.mockResolvedValue([]);

      const { result } = await runRound();
      const calledTargets = new Set(
        mockedRefreshCity.mock.calls.map(([target]) => target),
      );
      expect(calledTargets.size).toBeGreaterThan(
        TRAFFIC_REFRESH.liveRefreshBatchSize,
      );
      expect(result.refreshed).toBe(calledTargets.size);
      expect(result.skippedTargets).toBe(0);
    });

    it("continues refreshing when a single target fails (allSettled isolation)", async () => {
      mockedRedisSetNx.mockResolvedValueOnce(true);
      mockedRefreshCity.mockImplementation(async (target) => {
        if (target === "Taipei") {
          throw new Error("TDX 500 error");
        }
        return [{ sectionId: `${target}-1`, congestionLevel: 1 }];
      });

      const { result } = await runRound();
      expect(result.skipped).toBe(false);
      expect(result.refreshed).toBeGreaterThan(0);
      expect(mockedRefreshCity).toHaveBeenCalledWith("Highway");
    });

    it("finishes within the round deadline when a target never resolves", async () => {
      mockedRedisSetNx.mockResolvedValueOnce(true);
      mockedRefreshCity.mockImplementation((target) => {
        if (target === "Taichung") {
          return new Promise<LiveSection[]>(() => {});
        }
        return Promise.resolve([
          { sectionId: `${target}-1`, congestionLevel: 1 },
        ]);
      });

      const { result, elapsedMs } = await runRound();

      expect(elapsedMs).toBeLessThanOrEqual(ROUND_DEADLINE_MS);
      const calledTargets = new Set(
        mockedRefreshCity.mock.calls.map(([target]) => target),
      );
      expect(calledTargets).toContain("Highway");
      expect(result.refreshed).toBe(calledTargets.size - 1);
    });

    it("always runs the first batch and reports the remaining targets as skipped", async () => {
      vi.stubEnv(
        "TRAFFIC_LIVE_REFRESH_TARGET_TIMEOUT_MS",
        String(TRAFFIC_REFRESH.lockTtlSec * 1000 * 10),
      );
      vi.resetModules();
      try {
        const redis = await import("../../config/redis");
        const flow = await import("./traffic-flow.service");
        const worker = await import("./traffic-live.worker");
        vi.mocked(redis.redisSetNx).mockResolvedValueOnce(true);
        vi.mocked(flow.refreshCityLiveTraffics).mockResolvedValue([]);

        const { result } = await runRound(worker.refreshAllLiveTraffics);

        expect(result.refreshed).toBe(TRAFFIC_REFRESH.liveRefreshBatchSize);
        expect(result.skippedTargets).toBeGreaterThan(0);
      } finally {
        vi.unstubAllEnvs();
      }
    });

    it("stays within the round deadline when the batch gap exceeds it", async () => {
      vi.stubEnv(
        "TRAFFIC_LIVE_REFRESH_BATCH_GAP_MS",
        String(ROUND_DEADLINE_MS * 10),
      );
      vi.resetModules();
      try {
        const redis = await import("../../config/redis");
        const flow = await import("./traffic-flow.service");
        const worker = await import("./traffic-live.worker");
        vi.mocked(redis.redisSetNx).mockResolvedValueOnce(true);
        vi.mocked(flow.refreshCityLiveTraffics).mockResolvedValue([]);

        const { result, elapsedMs } = await runRound(
          worker.refreshAllLiveTraffics,
          ROUND_DEADLINE_MS * 20,
        );

        expect(elapsedMs).toBeLessThanOrEqual(ROUND_DEADLINE_MS);
        expect(result.skippedTargets).toBeGreaterThan(0);
      } finally {
        vi.unstubAllEnvs();
      }
    });
  });

  describe("scheduleLiveRefresh", () => {
    it("deduplicates concurrent refresh triggers for the same target", async () => {
      let resolveRefresh: (v: LiveSection[]) => void = () => {};
      const pendingPromise = new Promise<LiveSection[]>((resolve) => {
        resolveRefresh = resolve;
      });
      mockedRefreshCity.mockReturnValue(pendingPromise);

      // Call 3 times consecutively for the same target
      scheduleLiveRefresh("Taipei");
      scheduleLiveRefresh("Taipei");
      scheduleLiveRefresh("Taipei");

      expect(mockedRefreshCity).toHaveBeenCalledTimes(1);
      expect(mockedRefreshCity).toHaveBeenCalledWith("Taipei");

      // Once resolved, a subsequent call can trigger a new refresh
      resolveRefresh([]);
      await pendingPromise;

      // Small tick for finally callback to run
      await new Promise((resolve) => setTimeout(resolve, 0));

      scheduleLiveRefresh("Taipei");
      expect(mockedRefreshCity).toHaveBeenCalledTimes(2);
    });
  });
});
