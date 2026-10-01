import { describe, expect, it } from "vitest";
import {
  indexTodaywork,
  permitCaseKey,
  rocDateToIso,
  todayworkLines,
} from "./taipei-construction.adapter";

describe("rocDateToIso", () => {
  it("converts ROC dates", () => {
    expect(rocDateToIso("115/12/31")).toBe("2026-12-31");
    expect(rocDateToIso("99/1/2")).toBe("2010-01-02");
  });

  it("rejects malformed dates", () => {
    expect(rocDateToIso("2026-12-31")).toBeUndefined();
    expect(rocDateToIso(undefined)).toBeUndefined();
  });
});

describe("permitCaseKey", () => {
  it("drops the sub-case suffix", () => {
    expect(permitCaseKey("11500946-3")).toBe("11500946");
    expect(permitCaseKey("105006940")).toBe("105006940");
  });
});

describe("indexTodaywork", () => {
  it("merges sub-cases: closure if any is, latest end date wins", () => {
    const index = indexTodaywork([
      {
        properties: { Ac_no: "11500946-1", IsBlock: "否", Ce_Da: "115/10/31" },
      },
      {
        properties: { Ac_no: "11500946-3", IsBlock: "是", Ce_Da: "115/12/31" },
      },
      {
        properties: { Ac_no: "11500946-2", IsBlock: "否", Ce_Da: "115/11/30" },
      },
    ]);
    expect(index.get("11500946")).toEqual({
      roadClosed: true,
      endDate: "2026-12-31",
    });
  });

  it("exposes only the closure flag and end date, never contractor contacts", () => {
    const index = indexTodaywork([
      {
        properties: {
          Ac_no: "1",
          IsBlock: "否",
          Ce_Da: "115/12/31",
          Tc_Ma: "王ＯＯ",
          Tc_Tl: "0912000000",
        } as never,
      },
    ]);
    expect(Object.keys(index.get("1") ?? {}).sort()).toEqual([
      "endDate",
      "roadClosed",
    ]);
  });
});

describe("todayworkLines", () => {
  it("reads each line of a MultiLineString", () => {
    expect(
      todayworkLines("MultiLineString", [
        [
          [1, 2],
          [3, 4],
        ],
        [[5, 6]],
      ]),
    ).toEqual([
      [
        [1, 2],
        [3, 4],
      ],
      [[5, 6]],
    ]);
  });

  it("reads every ring of a MultiPolygon", () => {
    const ring = [
      [1, 1],
      [2, 1],
      [2, 2],
      [1, 1],
    ];
    expect(todayworkLines("MultiPolygon", [[ring], [ring]])).toHaveLength(2);
  });

  it("returns nothing for unknown or malformed geometry", () => {
    expect(todayworkLines("Point", [1, 2])).toEqual([]);
    expect(todayworkLines("MultiLineString", [["x"]])).toEqual([]);
    expect(todayworkLines("MultiLineString", null)).toEqual([]);
  });
});

describe("indexTodaywork — work-area points", () => {
  it("samples points across every feature of a case", () => {
    const index = indexTodaywork([
      {
        properties: {
          Ac_no: "7-1",
          IsBlock: "否",
          Positions_type: "MultiLineString",
          Positions: [
            [
              [300000, 2770000],
              [300040, 2770000],
            ],
          ],
        },
      },
      {
        properties: {
          Ac_no: "7-2",
          IsBlock: "否",
          Positions_type: "MultiLineString",
          Positions: [
            [
              [301000, 2770000],
              [301040, 2770000],
            ],
          ],
        },
      },
    ]);
    const points = index.get("7")?.points ?? [];
    expect(points.length).toBe(8);
  });
});
