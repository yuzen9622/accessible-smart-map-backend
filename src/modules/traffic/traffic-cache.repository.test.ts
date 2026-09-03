import { beforeEach, describe, expect, it, vi } from "vitest";
import type { LiveSection } from "../../types/traffic";
import {
  CACHE_FAILED,
  getLiveEvents,
  getLiveTraffics,
  getLiveTrafficsSwr,
  setLiveEventsFailure,
  setLiveTraffics,
  setLiveTrafficsFailure,
  SingleFlight,
} from "./traffic-cache.repository";

vi.mock("../../config/redis", () => {
  const store = new Map<string, string>();
  return {
    redisReady: vi.fn().mockResolvedValue(undefined),
    redisClient: {
      status: "ready",
      get: vi.fn(async (key: string) => store.get(key) ?? null),
      set: vi.fn(async (key: string, val: string) => {
        store.set(key, val);
        return "OK";
      }),
      del: vi.fn(async (key: string) => {
        store.delete(key);
        return 1;
      }),
      _clear: () => store.clear(),
    },
  };
});

describe("traffic-cache.repository", () => {
  beforeEach(async () => {
    const { redisClient } = await import("../../config/redis");
    (redisClient as unknown as { _clear: () => void })._clear();
  });

  describe("negative cache sentinel distinction", () => {
    it("returns null on cache miss", async () => {
      const result = await getLiveTraffics("Taipei");
      expect(result).toBeNull();
    });

    it("returns CACHE_FAILED sentinel on failed cache hit without returning null", async () => {
      await setLiveTrafficsFailure("Taipei");
      const result = await getLiveTraffics("Taipei");
      expect(result).toBe(CACHE_FAILED);
    });

    it("returns CACHE_FAILED sentinel for events failure cache", async () => {
      await setLiveEventsFailure("Taipei");
      const result = await getLiveEvents("Taipei");
      expect(result).toBe(CACHE_FAILED);
    });
  });

  describe("SingleFlight", () => {
    it("deduplicates concurrent executions for the same key", async () => {
      const flight = new SingleFlight<string>();
      let callCount = 0;

      const worker = async () => {
        callCount++;
        await new Promise((resolve) => setTimeout(resolve, 30));
        return "done";
      };

      const [r1, r2, r3] = await Promise.all([
        flight.do("city:Taipei", worker),
        flight.do("city:Taipei", worker),
        flight.do("city:Taipei", worker),
      ]);

      expect(callCount).toBe(1);
      expect(r1).toBe("done");
      expect(r2).toBe("done");
      expect(r3).toBe("done");
    });

    it("executes independently for different keys", async () => {
      const flight = new SingleFlight<string>();
      let callCount = 0;

      const worker = async (name: string) => {
        callCount++;
        await new Promise((resolve) => setTimeout(resolve, 20));
        return `done-${name}`;
      };

      const [r1, r2] = await Promise.all([
        flight.do("city:Taipei", () => worker("Taipei")),
        flight.do("city:NewTaipei", () => worker("NewTaipei")),
      ]);

      expect(callCount).toBe(2);
      expect(r1).toBe("done-Taipei");
      expect(r2).toBe("done-NewTaipei");
    });

    it("cleans up inFlight map even if worker throws", async () => {
      const flight = new SingleFlight<string>();
      const failingWorker = async () => {
        throw new Error("Worker failed");
      };

      await expect(flight.do("fail-key", failingWorker)).rejects.toThrow(
        "Worker failed",
      );

      // Subsequent call should invoke new worker rather than returning rejected cached promise
      let secondCalled = false;
      const successWorker = async () => {
        secondCalled = true;
        return "recovered";
      };

      const res = await flight.do("fail-key", successWorker);
      expect(secondCalled).toBe(true);
      expect(res).toBe("recovered");
    });
  });

  describe("SWR and envelope v1/v2 compatibility", () => {
    it("returns fresh state for v2 envelope when ageMs <= soft TTL", async () => {
      const liveData: LiveSection[] = [
        { sectionId: "sec-1", congestionLevel: 1 },
      ];
      await setLiveTraffics("Taipei", liveData);

      const hit = await getLiveTrafficsSwr("Taipei");
      expect(hit.state).toBe("fresh");
      expect(hit.data).toEqual(liveData);
      expect(hit.ageMs).toBeGreaterThanOrEqual(0);

      // Legacy getter also unpacks v2 envelope
      const unpacked = await getLiveTraffics("Taipei");
      expect(unpacked).toEqual(liveData);
    });

    it("returns stale state for v2 envelope when ageMs > soft TTL", async () => {
      const { redisClient } = await import("../../config/redis");
      const liveData: LiveSection[] = [
        { sectionId: "sec-old", congestionLevel: 2 },
      ];
      // Envelope fetched 100 seconds ago (soft TTL is 90s)
      const oldEnvelope = {
        v: 2,
        fetchedAtMs: Date.now() - 100_000,
        data: liveData,
      };
      await (
        redisClient as unknown as {
          set: (k: string, v: string) => Promise<string>;
        }
      ).set("traffic:flow:live:Taipei", JSON.stringify(oldEnvelope));

      const hit = await getLiveTrafficsSwr("Taipei");
      expect(hit.state).toBe("stale");
      expect(hit.data).toEqual(liveData);
      expect(hit.ageMs).toBeGreaterThanOrEqual(95_000);
    });

    it("treats v1 raw array as stale and parses data correctly (deployment compatibility)", async () => {
      const { redisClient } = await import("../../config/redis");
      const legacyArray: LiveSection[] = [
        { sectionId: "legacy-sec", congestionLevel: 3 },
      ];
      await (
        redisClient as unknown as {
          set: (k: string, v: string) => Promise<string>;
        }
      ).set("traffic:flow:live:NewTaipei", JSON.stringify(legacyArray));

      const hit = await getLiveTrafficsSwr("NewTaipei");
      expect(hit.state).toBe("stale");
      expect(hit.data).toEqual(legacyArray);
      expect(hit.ageMs).toBe(Number.MAX_SAFE_INTEGER);

      const legacyGetter = await getLiveTraffics("NewTaipei");
      expect(legacyGetter).toEqual(legacyArray);
    });

    it("returns failed state on CACHE_FAILED sentinel", async () => {
      await setLiveTrafficsFailure("Keelung");
      const hit = await getLiveTrafficsSwr("Keelung");
      expect(hit.state).toBe("failed");
      expect(hit.data).toEqual([]);
    });

    it("returns miss when redis throws or key does not exist", async () => {
      const hit = await getLiveTrafficsSwr("NonExistent");
      expect(hit.state).toBe("miss");
      expect(hit.data).toEqual([]);
    });
  });
});
