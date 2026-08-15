import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../adapters/rail.adapter", () => ({
  fetchRailStationIndex: vi.fn(),
  fetchRailOdTimetable: vi.fn(),
  fetchRailStationTimetable: vi.fn(),
}));

import {
  fetchRailStationIndex,
  fetchRailOdTimetable,
  fetchRailStationTimetable,
} from "../../adapters/rail.adapter";
import { getTrainTimetable, getStationTimetable } from "./train.service";
import type { NormalizedTrain, NormalizedStationTrain } from "../../types/rail";

const idx = fetchRailStationIndex as unknown as ReturnType<typeof vi.fn>;
const odFetch = fetchRailOdTimetable as unknown as ReturnType<typeof vi.fn>;
const stFetch = fetchRailStationTimetable as unknown as ReturnType<
  typeof vi.fn
>;

// 2026-07-13T01:00:00Z → Asia/Taipei 2026-07-13 09:00
const NOW = new Date("2026-07-13T01:00:00Z");

const STATIONS = new Map<string, string>([
  ["臺北", "1000"],
  ["臺中", "3300"],
  ["左營", "6000"],
]);

function odItem(trainNo: string, dep: string, arr: string): NormalizedTrain {
  const toMin = (s: string) =>
    Number(s.slice(0, 2)) * 60 + Number(s.slice(3, 5));
  const depMin = toMin(dep);
  let arrMin = toMin(arr);
  const nextDay = arrMin < depMin;
  if (nextDay) arrMin += 1440;
  const t: NormalizedTrain = {
    trainNo,
    departureTime: dep,
    arrivalTime: arr,
    departureMinutes: depMin,
    arrivalMinutes: arrMin,
    durationMinutes: arrMin - depMin,
  };
  if (nextDay) t.arrivesNextDay = true;
  return t;
}

function stItem(trainNo: string, dep: string): NormalizedStationTrain {
  return {
    trainNo,
    departureTime: dep,
    departureMinutes: Number(dep.slice(0, 2)) * 60 + Number(dep.slice(3, 5)),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  idx.mockResolvedValue({ ok: true, index: STATIONS });
});

describe("getTrainTimetable station resolution (case 1/6/8)", () => {
  it("resolves normalized station names and returns an error naming an unknown station", async () => {
    odFetch.mockResolvedValue({
      ok: true,
      items: [odItem("1", "09:30", "11:00")],
    });
    const ok = await getTrainTimetable(
      { originStation: "台北車站", destinationStation: "台中" },
      NOW,
    );
    expect(ok.ok).toBe(true);

    const bad = await getTrainTimetable(
      { originStation: "台北", destinationStation: "不存在站" },
      NOW,
    );
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.error).toContain("不存在站");
  });

  it("does not treat an index upstream failure as an unknown station (F6)", async () => {
    idx.mockResolvedValue({ ok: false, errorCode: "HTTP_ERROR" });
    const out = await getTrainTimetable(
      { originStation: "台北", destinationStation: "台中" },
      NOW,
    );
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.error).not.toContain("找不到");
      expect(out.error).toContain("暫時失敗");
    }
  });

  it("rejects identical origin and destination", async () => {
    const out = await getTrainTimetable(
      { originStation: "台北", destinationStation: "臺北" },
      NOW,
    );
    expect(out).toEqual({ ok: false, error: "起訖站相同" });
    expect(odFetch).not.toHaveBeenCalled();
  });
});

describe("getTrainTimetable filtering (case 2/3/4/5)", () => {
  const many: NormalizedTrain[] = [];
  for (let h = 6; h < 22; h++)
    many.push(
      odItem(
        `${h}`,
        `${String(h).padStart(2, "0")}:00`,
        `${String(h + 1).padStart(2, "0")}:00`,
      ),
    );

  it("departAfter keeps the earliest 12 at/after the time and notes truncation", async () => {
    odFetch.mockResolvedValue({ ok: true, items: many });
    const out = await getTrainTimetable(
      {
        originStation: "台北",
        destinationStation: "台中",
        departAfter: "9:00",
      },
      NOW,
    );
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.trains).toHaveLength(12);
    expect(out.trains[0].departureTime).toBe("09:00");
    expect(out.matchedCount).toBe(13);
    expect(out.note).toContain("僅顯示");
  });

  it("arriveBy keeps trains arriving by the time, latest-departing 12", async () => {
    odFetch.mockResolvedValue({ ok: true, items: many });
    const out = await getTrainTimetable(
      { originStation: "台北", destinationStation: "台中", arriveBy: "12:00" },
      NOW,
    );
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    for (const t of out.trains) expect(t.arrivalTime <= "12:00").toBe(true);
  });

  it("returns ok with empty trains and a note when the timetable is empty", async () => {
    odFetch.mockResolvedValue({ ok: true, items: [] });
    const out = await getTrainTimetable(
      { originStation: "台北", destinationStation: "台中" },
      NOW,
    );
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.trains).toHaveLength(0);
      expect(out.note).toBeTruthy();
    }
  });

  it("maps an adapter failure to a temporary-failure error", async () => {
    odFetch.mockResolvedValue({ ok: false, errorCode: "NETWORK" });
    const out = await getTrainTimetable(
      { originStation: "台北", destinationStation: "台中" },
      NOW,
    );
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.error).toContain("暫時失敗");
  });
});

describe("input validation short-circuits (case 7)", () => {
  const bad: Array<[string, any]> = [
    ["null origin", { originStation: null, destinationStation: "台中" }],
    ["empty origin", { originStation: "  ", destinationStation: "台中" }],
    [
      "suffix-only origin",
      { originStation: "車站", destinationStation: "台中" },
    ],
    ["number origin", { originStation: 123, destinationStation: "台中" }],
    [
      "bad calendar date",
      { originStation: "台北", destinationStation: "台中", date: "2026-02-30" },
    ],
    [
      "past date",
      { originStation: "台北", destinationStation: "台中", date: "2026-07-12" },
    ],
    [
      "out-of-range date",
      { originStation: "台北", destinationStation: "台中", date: "2026-09-30" },
    ],
    [
      "bad time",
      {
        originStation: "台北",
        destinationStation: "台中",
        departAfter: "24:00",
      },
    ],
    [
      "bad railSystem",
      { originStation: "台北", destinationStation: "台中", railSystem: "tra" },
    ],
  ];

  for (const [label, params] of bad) {
    it(`rejects ${label} without calling the timetable adapter`, async () => {
      const out = await getTrainTimetable(params, NOW);
      expect(out.ok).toBe(false);
      expect(odFetch).not.toHaveBeenCalled();
    });
  }

  it("accepts a one-digit-hour time and today/max-range boundary dates", async () => {
    odFetch.mockResolvedValue({
      ok: true,
      items: [odItem("1", "09:30", "11:00")],
    });
    for (const params of [
      { departAfter: "9:05" },
      { date: "2026-07-13" },
      { date: "2026-09-11" },
    ]) {
      const out = await getTrainTimetable(
        { originStation: "台北", destinationStation: "台中", ...params },
        NOW,
      );
      expect(out.ok).toBe(true);
    }
  });
});

describe("getStationTimetable (case 9/10)", () => {
  it("defaults departAfter to now and returns the next departures", async () => {
    stFetch.mockResolvedValue({
      ok: true,
      items: [stItem("A", "07:00"), stItem("B", "09:30"), stItem("C", "10:00")],
    });
    const out = await getStationTimetable({ station: "台中" }, NOW);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.departAfter).toBe("09:00");
    expect(out.trains.map((t) => t.trainNo)).toEqual(["B", "C"]);
    expect(out.firstTrain).toBe("07:00");
    expect(out.lastTrain).toBe("10:00");
  });

  it("notes the last train when the day is already over", async () => {
    stFetch.mockResolvedValue({
      ok: true,
      items: [stItem("A", "06:00"), stItem("B", "07:30")],
    });
    const out = await getStationTimetable({ station: "台中" }, NOW);
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.trains).toHaveLength(0);
      expect(out.note).toContain("07:30");
    }
  });

  it("rejects a blank station without calling the adapter", async () => {
    const out = await getStationTimetable({ station: "  " }, NOW);
    expect(out.ok).toBe(false);
    expect(stFetch).not.toHaveBeenCalled();
  });

  it("routes THSR through the THSR system", async () => {
    stFetch.mockResolvedValue({ ok: true, items: [stItem("A", "10:00")] });
    await getStationTimetable(
      { station: "左營", railSystem: "THSR", departAfter: "08:00" },
      NOW,
    );
    expect(stFetch).toHaveBeenCalledWith("THSR", "6000", "2026-07-13");
  });
});
