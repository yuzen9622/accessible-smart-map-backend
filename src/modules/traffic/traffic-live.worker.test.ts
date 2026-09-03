import { beforeEach, describe, expect, it, vi } from "vitest";
import * as redisConfig from "../../config/redis";
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

describe("traffic-live.worker", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  describe("refreshAllLiveTraffics", () => {
    it("skips refresh when redis lock cannot be acquired", async () => {
      mockedRedisSetNx.mockResolvedValueOnce(false);

      const result = await refreshAllLiveTraffics();
      expect(result).toEqual({ refreshed: 0, skipped: true });
      expect(mockedRefreshCity).not.toHaveBeenCalled();
    });

    it("refreshes all configured targets when lock is acquired", async () => {
      mockedRedisSetNx.mockResolvedValueOnce(true);
      mockedRefreshCity.mockResolvedValue([
        { sectionId: "sec-1", congestionLevel: 1 },
      ]);

      const result = await refreshAllLiveTraffics();
      expect(result.skipped).toBe(false);
      expect(result.refreshed).toBeGreaterThanOrEqual(3); // Taipei, NewTaipei, Freeway, Highway
      expect(mockedRefreshCity).toHaveBeenCalledWith("Taipei");
      expect(mockedRefreshCity).toHaveBeenCalledWith("NewTaipei");
      expect(mockedRefreshCity).toHaveBeenCalledWith("Freeway");
      expect(mockedRefreshCity).toHaveBeenCalledWith("Highway");
    });

    it("continues refreshing when a single target fails (allSettled isolation)", async () => {
      mockedRedisSetNx.mockResolvedValueOnce(true);
      mockedRefreshCity.mockImplementation(async (target) => {
        if (target === "Taipei") {
          throw new Error("TDX 500 error");
        }
        return [{ sectionId: `${target}-1`, congestionLevel: 1 }];
      });

      const result = await refreshAllLiveTraffics();
      expect(result.skipped).toBe(false);
      // All other targets should still succeed
      expect(result.refreshed).toBeGreaterThan(0);
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
