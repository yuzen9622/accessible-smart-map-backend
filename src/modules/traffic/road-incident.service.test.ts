import { beforeEach, describe, expect, it, vi } from "vitest";
import { tdxFetch } from "../../config/fetch";
import { fetchTaipeiPermitIndex } from "../../adapters/taipei-construction.adapter";
import {
  applyTaipeiPermits,
  classifyIncident,
  getActiveRoadIncidents,
  getCityRoadIncidents,
  mergeIncidentRows,
} from "./road-incident.service";
import * as cacheRepo from "./traffic-cache.repository";
import * as sectionRepo from "./traffic-section.repository";

vi.mock("../../config/fetch", () => ({
  tdxFetch: vi.fn(),
}));

vi.mock(
  "../../adapters/taipei-construction.adapter",
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import("../../adapters/taipei-construction.adapter")
      >();
    return { ...actual, fetchTaipeiPermitIndex: vi.fn(async () => new Map()) };
  },
);

vi.mock("./traffic-cache.repository", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("./traffic-cache.repository")>();
  return {
    ...actual,
    getLiveEvents: vi.fn(),
    setLiveEvents: vi.fn(),
    setLiveEventsFailure: vi.fn(),
  };
});

vi.mock("./traffic-section.repository", () => ({
  findCitiesIntersecting: vi.fn(),
}));

const mockedFetch = vi.mocked(tdxFetch);
const mockedGetCache = vi.mocked(cacheRepo.getLiveEvents);
const mockedSetCache = vi.mocked(cacheRepo.setLiveEvents);
const mockedSetCacheFailure = vi.mocked(cacheRepo.setLiveEventsFailure);
const mockedFindCities = vi.mocked(sectionRepo.findCitiesIntersecting);

describe("road-incident.service", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  describe("classifyIncident", () => {
    it("classifies closure keywords as 'closure'", () => {
      expect(
        classifyIncident({
          title: "和平東路封閉",
          description: "道路禁止通行",
        }),
      ).toBe("closure");
      expect(classifyIncident({ title: "道路中斷" })).toBe("closure");
    });

    it("classifies standard events as 'advisory'", () => {
      expect(classifyIncident({ title: "車輛故障佔用車道" })).toBe("advisory");
      expect(classifyIncident({ title: "施工慢行" })).toBe("advisory");
    });
  });

  describe("getCityRoadIncidents", () => {
    it("returns cached raw incidents on cache hit", async () => {
      mockedGetCache.mockResolvedValueOnce([
        {
          incidentId: "ev-1",
          title: "事故",
          location: { lat: 25.04, lng: 121.52 },
        },
      ]);

      const res = await getCityRoadIncidents("Taipei");
      expect(res.length).toBe(1);
      expect(res[0].incidentId).toBe("ev-1");
      expect(mockedFetch).not.toHaveBeenCalled();
    });

    it("parses WKT Positions and sets cache on miss", async () => {
      mockedGetCache.mockResolvedValueOnce(null);
      mockedFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          LiveEvents: [
            {
              EventID: "ev-wkt",
              EventTitle: "施工中斷",
              Positions: "POINT(121.53 25.045)",
              EffectiveTime: "2026-09-01T00:00:00Z",
              ExpireTime: "2026-09-30T00:00:00Z",
            },
          ],
        }),
      } as Response);

      const res = await getCityRoadIncidents("Taipei");
      expect(res.length).toBe(1);
      expect(res[0].incidentId).toBe("ev-wkt");
      expect(res[0].location).toEqual({ lat: 25.045, lng: 121.53 });
      expect(mockedSetCache).toHaveBeenCalledWith("Taipei", res);
    });

    it("writes failure cache and returns empty array on upstream error", async () => {
      mockedGetCache.mockResolvedValueOnce(null);
      mockedFetch.mockResolvedValueOnce({
        ok: false,
        status: 500,
      } as Response);

      const res = await getCityRoadIncidents("Taipei");
      expect(res).toEqual([]);
      expect(mockedSetCacheFailure).toHaveBeenCalledWith("Taipei");
    });

    it("returns empty array and does NOT call tdxFetch when cache hits failure sentinel", async () => {
      mockedGetCache.mockResolvedValueOnce(cacheRepo.CACHE_FAILED);

      const res = await getCityRoadIncidents("Taipei");
      expect(res).toEqual([]);
      expect(mockedFetch).not.toHaveBeenCalled();
    });

    it("deduplicates concurrent fetches for the same city via single-flight", async () => {
      mockedGetCache.mockResolvedValue(null);

      let resolveFetch!: (value: Response) => void;
      const fetchPromise = new Promise<Response>((resolve) => {
        resolveFetch = resolve;
      });

      mockedFetch.mockReturnValueOnce(fetchPromise);

      const p1 = getCityRoadIncidents("Taipei");
      const p2 = getCityRoadIncidents("Taipei");
      const p3 = getCityRoadIncidents("Taipei");

      resolveFetch({
        ok: true,
        status: 200,
        json: async () => ({
          LiveEvents: [
            {
              EventID: "ev-single-flight",
              EventTitle: "並發事件",
              Positions: "POINT(121.5 25.0)",
            },
          ],
        }),
      } as Response);

      const [res1, res2, res3] = await Promise.all([p1, p2, p3]);

      expect(mockedFetch).toHaveBeenCalledTimes(1);
      expect(res1).toEqual(res2);
      expect(res2).toEqual(res3);
      expect(res1[0].incidentId).toBe("ev-single-flight");
    });
  });

  describe("getActiveRoadIncidents", () => {
    it("filters out expired events and events outside bbox", async () => {
      mockedFindCities.mockResolvedValueOnce(["Taipei"]);
      const now = new Date();
      const past = new Date(now.getTime() - 3600_000).toISOString();
      const future = new Date(now.getTime() + 3600_000).toISOString();

      mockedGetCache.mockResolvedValueOnce([
        {
          incidentId: "ev-expired",
          title: "已過期事件",
          location: { lat: 25.04, lng: 121.52 },
          endTime: past,
        },
        {
          incidentId: "ev-future-start",
          title: "未來事件",
          location: { lat: 25.04, lng: 121.52 },
          startTime: future,
        },
        {
          incidentId: "ev-outside-bbox",
          title: "外圍事件",
          location: { lat: 25.99, lng: 121.99 },
          endTime: future,
        },
        {
          incidentId: "ev-valid",
          title: "有效封路",
          description: "禁止通行",
          location: { lat: 25.042, lng: 121.525 },
          endTime: future,
        },
        {
          incidentId: "ev-no-endtime",
          title: "無結束時間有效事件",
          location: { lat: 25.043, lng: 121.526 },
        },
      ]);

      const active = await getActiveRoadIncidents({
        bbox: [121.5, 25.0, 121.6, 25.1],
      });

      expect(active.length).toBe(2);
      expect(active.map((a) => a.incidentId)).toEqual([
        "ev-valid",
        "ev-no-endtime",
      ]);
      expect(active.find((a) => a.incidentId === "ev-valid")?.severity).toBe(
        "closure",
      );
      expect(
        active.find((a) => a.incidentId === "ev-no-endtime")?.severity,
      ).toBe("advisory");
    });
  });
});

describe("mergeIncidentRows", () => {
  const row = (incidentId: string, lat: number, lng = 121.5) => ({
    incidentId,
    title: "道路施工",
    description: "道路維護",
    location: { lat, lng },
  });

  it("merges rows sharing an EventID and keeps every point", () => {
    const merged = mergeIncidentRows([
      row("A", 25.01),
      row("B", 25.5),
      row("A", 25.02),
      row("A", 25.03),
    ]);

    expect(merged.map((m) => m.incidentId)).toEqual(["A", "B"]);
    expect(merged[0].location).toEqual({ lat: 25.01, lng: 121.5 });
    expect(merged[0].points?.map((p) => p.lat)).toEqual([25.01, 25.02, 25.03]);
    expect(merged[1].points).toBeUndefined();
  });

  it("drops an exact duplicate point instead of repeating it", () => {
    const [merged] = mergeIncidentRows([row("A", 25.01), row("A", 25.01)]);
    expect(merged.points).toBeUndefined();
  });
});

describe("applyTaipeiPermits", () => {
  const tdxRow = {
    incidentId: "379530000H_001-01-11501977-1",
    title: "道路施工",
    description: "道路維護",
    location: { lat: 25.1, lng: 121.4 },
  };

  it("marks a permit closure and fills the missing end time", () => {
    const [row] = applyTaipeiPermits(
      [tdxRow],
      new Map([["11501977", { roadClosed: true, endDate: "2026-12-31" }]]),
    );
    expect(row).toMatchObject({
      roadClosed: true,
      endTime: "2026-12-31T23:59:59+08:00",
    });
  });

  it("never overrides an end time TDX already published", () => {
    const [row] = applyTaipeiPermits(
      [{ ...tdxRow, endTime: "2026-10-05T18:00:00+08:00" }],
      new Map([["11501977", { roadClosed: false, endDate: "2026-12-31" }]]),
    );
    expect(row.endTime).toBe("2026-10-05T18:00:00+08:00");
    expect(row.roadClosed).toBeUndefined();
  });

  it("adds work-area points when TDX has only one point", () => {
    const points = [
      { lat: 25.1, lng: 121.4 },
      { lat: 25.1002, lng: 121.4 },
    ];
    const [row] = applyTaipeiPermits(
      [tdxRow],
      new Map([["11501977", { roadClosed: false, points }]]),
    );
    expect(row.points).toEqual(points);
  });

  it("leaves unmatched events untouched", () => {
    const [row] = applyTaipeiPermits(
      [tdxRow],
      new Map([["99999999", { roadClosed: true }]]),
    );
    expect(row).toEqual(tdxRow);
  });
});

describe("getActiveRoadIncidents — Taipei permits", () => {
  beforeEach(() => {
    vi.mocked(cacheRepo.getLiveEvents).mockReset();
    vi.mocked(fetchTaipeiPermitIndex).mockReset();
  });

  it("turns a Taipei advisory into a closure when the permit says so", async () => {
    vi.mocked(cacheRepo.getLiveEvents).mockResolvedValue([
      {
        incidentId: "379530000H_001-01-11501977-1",
        title: "道路施工",
        description: "道路維護",
        location: { lat: 25.1, lng: 121.4 },
      },
      {
        incidentId: "379530000H_001-01-11501977-1",
        title: "道路施工",
        description: "道路維護",
        location: { lat: 25.11, lng: 121.41 },
      },
    ]);
    vi.mocked(fetchTaipeiPermitIndex).mockResolvedValue(
      new Map([["11501977", { roadClosed: true }]]),
    );

    const incidents = await getActiveRoadIncidents({ city: "Taipei" });

    expect(incidents).toHaveLength(1);
    expect(incidents[0]).toMatchObject({
      severity: "closure",
      roadClosed: true,
    });
    expect(incidents[0].points).toHaveLength(2);
  });

  it("keeps an event whose later point falls inside the bbox", async () => {
    vi.mocked(cacheRepo.getLiveEvents).mockResolvedValue([
      {
        incidentId: "E1",
        title: "道路施工",
        location: { lat: 24.0, lng: 120.0 },
      },
      {
        incidentId: "E1",
        title: "道路施工",
        location: { lat: 25.05, lng: 121.55 },
      },
    ]);
    vi.mocked(fetchTaipeiPermitIndex).mockResolvedValue(new Map());

    const incidents = await getActiveRoadIncidents({
      city: "Taipei",
      bbox: [121.5, 25.0, 121.6, 25.1],
    });

    expect(incidents.map((i) => i.incidentId)).toEqual(["E1"]);
  });
});
