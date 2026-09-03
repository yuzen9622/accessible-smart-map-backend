import { beforeEach, describe, expect, it, vi } from "vitest";
import { tdxFetch } from "../../config/fetch";
import * as cacheRepo from "./traffic-cache.repository";
import {
  getCityLiveTraffics,
  getLiveSectionsForBbox,
  getTrafficFlowCollection,
  refreshCityLiveTraffics,
  TrafficSectionUnavailableError,
} from "./traffic-flow.service";
import * as liveWorker from "./traffic-live.worker";
import * as sectionRepo from "./traffic-section.repository";

vi.mock("../../config/fetch", () => ({
  tdxFetch: vi.fn(),
}));

vi.mock("./traffic-cache.repository", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("./traffic-cache.repository")>();
  return {
    ...actual,
    getLiveTrafficsSwr: vi.fn(),
    setLiveTraffics: vi.fn(),
    setLiveTrafficsFailure: vi.fn(),
  };
});

vi.mock("./traffic-live.worker", () => ({
  scheduleLiveRefresh: vi.fn(),
}));

vi.mock("./traffic-section.repository", () => ({
  findSectionsInBbox: vi.fn(),
  findByCity: vi.fn(),
  latestImportedAt: vi.fn(),
}));

const mockedFetch = vi.mocked(tdxFetch);
const mockedGetCacheSwr = vi.mocked(cacheRepo.getLiveTrafficsSwr);
const mockedSetCache = vi.mocked(cacheRepo.setLiveTraffics);
const mockedSetCacheFailure = vi.mocked(cacheRepo.setLiveTrafficsFailure);
const mockedScheduleRefresh = vi.mocked(liveWorker.scheduleLiveRefresh);
const mockedFindSections = vi.mocked(sectionRepo.findSectionsInBbox);
const mockedLatestImported = vi.mocked(sectionRepo.latestImportedAt);

describe("traffic-flow.service", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  describe("getCityLiveTraffics (cache-only)", () => {
    it("reads cache-only via getLiveTrafficsSwr and never calls tdxFetch", async () => {
      mockedGetCacheSwr.mockResolvedValueOnce({
        state: "fresh",
        data: [
          {
            sectionId: "sec-1",
            congestionLevel: 1,
            speedKmh: 40,
          },
        ],
        ageMs: 10_000,
      });

      const res = await getCityLiveTraffics("Taipei");
      expect(res.state).toBe("fresh");
      expect(res.data.length).toBe(1);
      expect(res.data[0].sectionId).toBe("sec-1");
      expect(mockedFetch).not.toHaveBeenCalled();
    });
  });

  describe("getLiveSectionsForBbox (request path)", () => {
    it("returns Map of live sections on cache hit and never calls tdxFetch", async () => {
      mockedGetCacheSwr.mockImplementation(async (target) => {
        if (target === "Taipei") {
          return {
            state: "fresh",
            data: [{ sectionId: "sec-taipei", congestionLevel: 1 }],
            ageMs: 5_000,
          };
        }
        return { state: "fresh", data: [], ageMs: 5_000 };
      });

      const map = await getLiveSectionsForBbox([121.5, 25.0, 121.6, 25.1]);
      expect(map.size).toBe(1);
      expect(map.get("sec-taipei")?.congestionLevel).toBe(1);
      expect(mockedFetch).not.toHaveBeenCalled();
      expect(mockedScheduleRefresh).not.toHaveBeenCalled();
    });

    it("returns stale data (stale-if-error) and triggers background refresh on stale cache", async () => {
      mockedGetCacheSwr.mockImplementation(async (target) => {
        if (target === "Taipei") {
          return {
            state: "stale",
            data: [{ sectionId: "sec-stale", congestionLevel: 2 }],
            ageMs: 120_000,
          };
        }
        return { state: "fresh", data: [], ageMs: 10_000 };
      });

      const map = await getLiveSectionsForBbox([121.5, 25.0, 121.6, 25.1]);
      expect(map.size).toBe(1);
      expect(map.get("sec-stale")?.congestionLevel).toBe(2);
      expect(mockedScheduleRefresh).toHaveBeenCalledWith("Taipei");
      expect(mockedFetch).not.toHaveBeenCalled();
    });

    it("returns empty map on cache miss without throwing and schedules background refresh", async () => {
      mockedGetCacheSwr.mockResolvedValue({
        state: "miss",
        data: [],
        ageMs: 0,
      });

      const map = await getLiveSectionsForBbox([121.5, 25.0, 121.6, 25.1]);
      expect(map.size).toBe(0);
      expect(mockedFetch).not.toHaveBeenCalled();
      expect(mockedScheduleRefresh).toHaveBeenCalled();
    });
  });

  describe("refreshCityLiveTraffics (worker-only TDX caller)", () => {
    it("fetches from TDX, parses rows, and writes to cache on success", async () => {
      mockedFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          LiveTraffics: [
            {
              SectionID: "sec-2",
              CongestionLevel: "3",
              TravelSpeed: 25,
              TravelTime: 60,
              DataCollectTime: "2026-09-03T12:00:00Z",
            },
          ],
        }),
      } as Response);

      const res = await refreshCityLiveTraffics("Taipei");
      expect(res.length).toBe(1);
      expect(res[0].sectionId).toBe("sec-2");
      expect(res[0].congestionLevel).toBe(3);
      expect(res[0].speedKmh).toBe(25);
      expect(mockedSetCache).toHaveBeenCalledWith("Taipei", res, 300);
    });

    it("writes failure cache and returns empty array when TDX upstream fails", async () => {
      mockedFetch.mockResolvedValueOnce({
        ok: false,
        status: 500,
      } as Response);

      const res = await refreshCityLiveTraffics("Taipei");
      expect(res).toEqual([]);
      expect(mockedSetCacheFailure).toHaveBeenCalledWith("Taipei");
    });

    it("deduplicates concurrent fetches for the same city via single-flight", async () => {
      let resolveFetch: (value: Response) => void = () => {};
      const fetchPromise = new Promise<Response>((resolve) => {
        resolveFetch = resolve;
      });

      mockedFetch.mockReturnValueOnce(fetchPromise);

      const p1 = refreshCityLiveTraffics("Taipei");
      const p2 = refreshCityLiveTraffics("Taipei");
      const p3 = refreshCityLiveTraffics("Taipei");

      resolveFetch({
        ok: true,
        status: 200,
        json: async () => ({
          LiveTraffics: [
            {
              SectionID: "sec-concurrent",
              CongestionLevel: "2",
            },
          ],
        }),
      } as Response);

      const [res1, res2, res3] = await Promise.all([p1, p2, p3]);

      expect(mockedFetch).toHaveBeenCalledTimes(1);
      expect(res1).toEqual(res2);
      expect(res2).toEqual(res3);
      expect(res1[0].sectionId).toBe("sec-concurrent");
    });
  });

  describe("getTrafficFlowCollection", () => {
    it("throws TrafficSectionUnavailableError when no geometry exists in bbox", async () => {
      mockedFindSections.mockResolvedValueOnce([]);

      await expect(
        getTrafficFlowCollection({ bbox: [121.5, 25.0, 121.6, 25.1] }),
      ).rejects.toThrow(TrafficSectionUnavailableError);
    });

    it("assembles FeatureCollection with style when geometries and live data match", async () => {
      mockedFindSections.mockResolvedValueOnce([
        {
          sectionId: "sec-1",
          roadName: "忠孝東路",
          roadClass: 1,
          city: "Taipei",
          geometry: {
            type: "LineString",
            coordinates: [
              [121.52, 25.042],
              [121.53, 25.042],
            ],
          },
        },
      ]);
      mockedGetCacheSwr.mockResolvedValueOnce({
        state: "fresh",
        data: [
          {
            sectionId: "sec-1",
            congestionLevel: 1,
            speedKmh: 45,
            updatedAt: "2026-09-03T12:00:00Z",
          },
        ],
        ageMs: 5_000,
      });
      mockedLatestImported.mockResolvedValueOnce(
        new Date("2026-09-01T00:00:00Z"),
      );

      const res = await getTrafficFlowCollection({
        bbox: [121.5, 25.0, 121.6, 25.1],
      });

      expect(res.type).toBe("FeatureCollection");
      expect(res.features.length).toBe(1);
      expect(res.features[0].properties.congestionLevel).toBe(1);
      expect(res.features[0].properties.trafficLevel).toBe("light");
      expect(
        (res.features[0].properties as Record<string, unknown>).color,
      ).toBeUndefined();
      expect(res.meta.count).toBe(1);
      expect(res.meta.liveUpdatedAt).toBe("2026-09-03T12:00:00Z");
      expect(res.meta.geometryImportedAt).toBe("2026-09-01T00:00:00.000Z");
    });

    it("filters out features below minLevel", async () => {
      mockedFindSections.mockResolvedValueOnce([
        {
          sectionId: "sec-free",
          city: "Taipei",
          geometry: {
            type: "LineString",
            coordinates: [
              [121.52, 25.042],
              [121.53, 25.042],
            ],
          },
        },
        {
          sectionId: "sec-jam",
          city: "Taipei",
          geometry: {
            type: "LineString",
            coordinates: [
              [121.54, 25.042],
              [121.55, 25.042],
            ],
          },
        },
      ]);
      mockedGetCacheSwr.mockResolvedValueOnce({
        state: "fresh",
        data: [
          { sectionId: "sec-free", congestionLevel: 1 },
          { sectionId: "sec-jam", congestionLevel: 4 },
        ],
        ageMs: 5_000,
      });
      mockedLatestImported.mockResolvedValueOnce(null);

      const res = await getTrafficFlowCollection({
        bbox: [121.5, 25.0, 121.6, 25.1],
        minLevel: 3,
      });

      expect(res.features.length).toBe(1);
      expect(res.features[0].properties.sectionId).toBe("sec-jam");
    });
  });
});
