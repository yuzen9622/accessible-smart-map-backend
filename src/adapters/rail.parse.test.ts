import { describe, it, expect } from "vitest";
import {
  parseOdBody,
  parseStationBody,
  parseStationList,
  clockValid,
  hhmmToMinutes,
} from "./rail.parse";
import { normalizeStationName } from "../utils/station-name";
import stationFixture from "./__fixtures__/rail-station-timetables.json";
import odCrossMidnight from "./__fixtures__/od-crossmidnight.synthetic.json";

describe("parseStationBody (M1 real fixture)", () => {
  it("parses the real TRA station fixture into normalized departures", () => {
    const out = parseStationBody((stationFixture as any).tra);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.items.length).toBeGreaterThan(0);
    const first = out.items[0];
    expect(typeof first.trainNo).toBe("string");
    expect(first.trainNo.length).toBeGreaterThan(0);
    expect(first.departureTime).toMatch(/^\d{2}:\d{2}$/);
    expect(typeof first.departureMinutes).toBe("number");
  });

  it("parses the real THSR station fixture", () => {
    const out = parseStationBody((stationFixture as any).thsr);
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.items.length).toBeGreaterThan(0);
  });
});

describe("parseStationBody (M2 wrapper location)", () => {
  const row = {
    TrainNo: "123",
    DepartureTime: "08:00",
    Direction: 0,
    EndingStationName: { Zh_tw: "高雄" },
    TrainTypeName: { Zh_tw: "自強" },
  };

  it("locates a TimeTables-wrapped array", () => {
    const out = parseStationBody({ StationID: "1000", TimeTables: [row] });
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.items[0].trainNo).toBe("123");
  });

  it("locates a StationTimetables-wrapped array", () => {
    const out = parseStationBody({ StationTimetables: [row] });
    expect(out.ok).toBe(true);
  });

  it("flattens an array of station wrappers", () => {
    const out = parseStationBody([{ StationID: "1", TimeTables: [row] }]);
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.items).toHaveLength(1);
  });

  it("reports BAD_PAYLOAD for an object with no known train array key", () => {
    const out = parseStationBody({ foo: 1, bar: 2 });
    expect(out).toEqual({ ok: false, errorCode: "BAD_PAYLOAD" });
  });
});

describe("parseStationBody (M3 row validation)", () => {
  it("drops arrival-only rows and rows without a train number", () => {
    const body = [
      { TrainNo: "1", DepartureTime: "08:00" },
      { TrainNo: "2", ArrivalTime: "09:00" },
      { DepartureTime: "10:00" },
    ];
    const out = parseStationBody(body);
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.items).toHaveLength(1);
      expect(out.items[0].trainNo).toBe("1");
    }
  });

  it("reports BAD_PAYLOAD for a non-empty array with zero valid rows", () => {
    const out = parseStationBody([{ ArrivalTime: "09:00" }, { foo: 1 }]);
    expect(out).toEqual({ ok: false, errorCode: "BAD_PAYLOAD" });
  });

  it("treats an empty array as a successful empty board", () => {
    expect(parseStationBody([])).toEqual({ ok: true, items: [] });
  });
});

describe("parseOdBody (M4)", () => {
  it("marks cross-midnight trains and computes duration (synthetic fixture)", () => {
    const out = parseOdBody(odCrossMidnight as any);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    const cross = out.items.find((t) => t.trainNo === "9001")!;
    expect(cross.arrivesNextDay).toBe(true);
    expect(cross.durationMinutes).toBe(50);
    const sameDay = out.items.find((t) => t.trainNo === "9002")!;
    expect(sameDay.arrivesNextDay).toBeUndefined();
    expect(sameDay.durationMinutes).toBe(55);
  });

  it("drops rows missing departure or arrival times", () => {
    const out = parseOdBody([
      {
        DailyTrainInfo: { TrainNo: "1" },
        OriginStopTime: { DepartureTime: "08:00" },
        DestinationStopTime: {},
      },
      {
        DailyTrainInfo: { TrainNo: "2" },
        OriginStopTime: { DepartureTime: "08:00" },
        DestinationStopTime: { ArrivalTime: "09:00" },
      },
    ]);
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.items).toHaveLength(1);
  });

  it("reports BAD_PAYLOAD for a non-array body and for zero valid rows", () => {
    expect(parseOdBody({})).toEqual({ ok: false, errorCode: "BAD_PAYLOAD" });
    expect(parseOdBody([{ foo: 1 }])).toEqual({
      ok: false,
      errorCode: "BAD_PAYLOAD",
    });
  });

  it("treats an empty array as a successful empty timetable", () => {
    expect(parseOdBody([])).toEqual({ ok: true, items: [] });
  });
});

describe("parseStationList (M5)", () => {
  it("builds a normalized name → StationID index", () => {
    const out = parseStationList([
      { StationID: "1000", StationName: { Zh_tw: "臺北" } },
      { StationID: "3300", StationName: { Zh_tw: "臺中" } },
    ]);
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.index.get("臺北")).toBe("1000");
      expect(out.index.get(normalizeStationName("台中"))).toBe("3300");
    }
  });

  it("reports BAD_PAYLOAD for a non-array or empty list", () => {
    expect(parseStationList({})).toEqual({
      ok: false,
      errorCode: "BAD_PAYLOAD",
    });
    expect(parseStationList([{ foo: 1 }])).toEqual({
      ok: false,
      errorCode: "BAD_PAYLOAD",
    });
  });
});

describe("clock helpers (M6 dual format)", () => {
  it("accepts HH:mm and HH:mm:ss, truncating seconds", () => {
    expect(hhmmToMinutes("9:05")).toBe(545);
    expect(hhmmToMinutes("09:05:30")).toBe(545);
    expect(clockValid("09:00")).toBe(true);
    expect(clockValid("23:59")).toBe(true);
    expect(clockValid("09:05:30")).toBe(true);
  });

  it("rejects invalid clock strings", () => {
    for (const v of ["24:00", "9:60", "-1:30", "09:00x", "09:05:60", 900]) {
      expect(clockValid(v as any)).toBe(false);
      expect(hhmmToMinutes(v as any)).toBeNull();
    }
  });

  it("normalizeStationName strips 台/車站/站 and trims", () => {
    expect(normalizeStationName("台北車站")).toBe("臺北");
    expect(normalizeStationName("新左營站")).toBe("新左營");
    expect(normalizeStationName(" 臺中 ")).toBe("臺中");
  });
});
