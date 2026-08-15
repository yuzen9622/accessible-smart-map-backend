import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../config/fetch", () => ({ tdxFetch: vi.fn() }));

import { tdxFetch } from "../config/fetch";
import {
  fetchRailOdTimetable,
  fetchRailStationTimetable,
  fetchRailStationIndex,
  __resetRailAdapterForTest,
} from "./rail.adapter";

const mockFetch = tdxFetch as unknown as ReturnType<typeof vi.fn>;

function jsonResp(body: unknown, ok = true, status = 200) {
  return { ok, status, json: async () => body };
}

const OD_ROWS = [
  {
    DailyTrainInfo: { TrainNo: "101", TrainTypeName: { Zh_tw: "自強" } },
    OriginStopTime: { DepartureTime: "08:00" },
    DestinationStopTime: { ArrivalTime: "10:00" },
  },
];

beforeEach(() => {
  __resetRailAdapterForTest();
  vi.clearAllMocks();
});

describe("outcome classification (A1)", () => {
  it("maps non-2xx to HTTP_ERROR", async () => {
    mockFetch.mockResolvedValue(jsonResp(null, false, 429));
    const out = await fetchRailOdTimetable("TRA", "1", "2", "2026-07-13");
    expect(out).toEqual({ ok: false, errorCode: "HTTP_ERROR" });
  });

  it("maps a thrown fetch to NETWORK", async () => {
    mockFetch.mockRejectedValue(new Error("boom"));
    const out = await fetchRailOdTimetable("TRA", "1", "2", "2026-07-13");
    expect(out).toEqual({ ok: false, errorCode: "NETWORK" });
  });

  it("maps a malformed 2xx body to BAD_PAYLOAD", async () => {
    mockFetch.mockResolvedValue(jsonResp({ notAnArray: true }));
    const out = await fetchRailOdTimetable("TRA", "1", "2", "2026-07-13");
    expect(out).toEqual({ ok: false, errorCode: "BAD_PAYLOAD" });
  });

  it("maps a valid 2xx body to ok+items", async () => {
    mockFetch.mockResolvedValue(jsonResp(OD_ROWS));
    const out = await fetchRailOdTimetable("TRA", "1", "2", "2026-07-13");
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.items[0].trainNo).toBe("101");
  });
});

describe("cache preserves success/failure distinction (A2/A3)", () => {
  it("caches a success and serves it without a second fetch", async () => {
    mockFetch.mockResolvedValue(jsonResp(OD_ROWS));
    const a = await fetchRailOdTimetable("TRA", "1", "2", "2026-07-13");
    const b = await fetchRailOdTimetable("TRA", "1", "2", "2026-07-13");
    expect(a.ok && b.ok).toBe(true);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("caches an empty timetable as ok (not a failure)", async () => {
    mockFetch.mockResolvedValue(jsonResp([]));
    const a = await fetchRailOdTimetable("TRA", "1", "2", "2026-07-13");
    const b = await fetchRailOdTimetable("TRA", "1", "2", "2026-07-13");
    expect(a).toEqual({ ok: true, items: [] });
    expect(b).toEqual({ ok: true, items: [] });
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("re-reads a cached failure as a failure within TTL", async () => {
    mockFetch.mockResolvedValue(jsonResp(null, false, 500));
    const a = await fetchRailOdTimetable("TRA", "1", "2", "2026-07-13");
    const b = await fetchRailOdTimetable("TRA", "1", "2", "2026-07-13");
    expect(a).toEqual({ ok: false, errorCode: "HTTP_ERROR" });
    expect(b).toEqual({ ok: false, errorCode: "HTTP_ERROR" });
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("evicts an expired failure and re-fetches after TTL", async () => {
    vi.useFakeTimers();
    try {
      mockFetch.mockResolvedValue(jsonResp(null, false, 500));
      await fetchRailOdTimetable("TRA", "1", "2", "2026-07-13");
      expect(mockFetch).toHaveBeenCalledTimes(1);
      vi.advanceTimersByTime(61 * 1000);
      await fetchRailOdTimetable("TRA", "1", "2", "2026-07-13");
      expect(mockFetch).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("in-flight coalescing (A4)", () => {
  it("collapses concurrent same-key requests to one fetch", async () => {
    mockFetch.mockResolvedValue(jsonResp(OD_ROWS));
    const [a, b, c] = await Promise.all([
      fetchRailOdTimetable("TRA", "1", "2", "2026-07-13"),
      fetchRailOdTimetable("TRA", "1", "2", "2026-07-13"),
      fetchRailOdTimetable("TRA", "1", "2", "2026-07-13"),
    ]);
    expect(a).toEqual(b);
    expect(b).toEqual(c);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });
});

describe("concurrency limit and key isolation (A5/A6)", () => {
  it("rejects new keys with BUSY past RAIL_INFLIGHT_MAX without fetching", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    mockFetch.mockImplementation(async () => {
      await gate;
      return jsonResp(OD_ROWS);
    });

    const pending = [1, 2, 3, 4].map((i) =>
      fetchRailOdTimetable("TRA", `${i}`, "x", "2026-07-13"),
    );
    const overflow = await fetchRailOdTimetable("TRA", "5", "x", "2026-07-13");
    expect(overflow).toEqual({ ok: false, errorCode: "BUSY" });
    expect(mockFetch).toHaveBeenCalledTimes(4);

    release();
    await Promise.all(pending);
  });

  it("keeps od / station / index keys isolated", async () => {
    mockFetch.mockImplementation(async (url: string) => {
      if (url.includes("/Station/")) return jsonResp([{ TrainNo: "1", DepartureTime: "08:00" }]);
      if (url.includes("/OD/")) return jsonResp(OD_ROWS);
      return jsonResp([{ StationID: "1000", StationName: { Zh_tw: "臺北" } }]);
    });
    await fetchRailOdTimetable("TRA", "1", "2", "2026-07-13");
    await fetchRailStationTimetable("TRA", "1000", "2026-07-13");
    await fetchRailStationIndex("TRA");
    expect(mockFetch).toHaveBeenCalledTimes(3);
  });
});

describe("LRU capacity eviction (A5)", () => {
  it("evicts the oldest entry past OD_CACHE_MAX", async () => {
    mockFetch.mockResolvedValue(jsonResp(OD_ROWS));
    for (let i = 0; i < 201; i++) {
      await fetchRailOdTimetable("TRA", `${i}`, "x", "2026-07-13");
    }
    expect(mockFetch).toHaveBeenCalledTimes(201);
    await fetchRailOdTimetable("TRA", "0", "x", "2026-07-13");
    expect(mockFetch).toHaveBeenCalledTimes(202);
  });
});

describe("URL and system routing (A7/A8)", () => {
  it("uses the OD, Station and THSR URLs correctly", async () => {
    mockFetch.mockImplementation(async (url: string) => {
      if (url.includes("Station/")) return jsonResp([{ TrainNo: "1", DepartureTime: "08:00" }]);
      return jsonResp(OD_ROWS);
    });
    await fetchRailOdTimetable("TRA", "1000", "3300", "2026-07-13");
    expect(mockFetch.mock.calls[0][0]).toContain("/TRA/DailyTimetable/OD/1000/to/3300/2026-07-13");
    await fetchRailStationTimetable("THSR", "1070", "2026-07-13");
    expect(mockFetch.mock.calls[1][0]).toContain("/THSR/DailyTimetable/Station/1070/2026-07-13");
  });

  it("reports station-index upstream failure without an empty map", async () => {
    mockFetch.mockResolvedValue(jsonResp(null, false, 500));
    const out = await fetchRailStationIndex("TRA");
    expect(out).toEqual({ ok: false, errorCode: "HTTP_ERROR" });
  });
});
