import { describe, it, expect } from "vitest";
import { extractCalls, gradeArgs } from "./eval-grade";

const raw = (calls: any[]) =>
  ({
    steps: calls.map((c) => ({
      type: "function_call",
      name: c.name,
      arguments: c.args,
    })),
  }) as any;

describe("extractCalls", () => {
  it("returns [] when there are no function calls", () => {
    expect(extractCalls(undefined)).toEqual([]);
    expect(extractCalls(raw([]))).toEqual([]);
  });

  it("defaults missing args to {} and ignores nameless calls", () => {
    const out = extractCalls(
      raw([{ name: "a", args: { x: 1 } }, { name: "b" }, { args: {} }]),
    );
    expect(out).toEqual([
      { name: "a", args: { x: 1 } },
      { name: "b", args: {} },
    ]);
  });
});

describe("gradeArgs", () => {
  const ctx = { today: "2026-07-13" };

  it("passes when the expected tool's args satisfy the predicate", () => {
    const calls = [
      { name: "getTrainTimetable", args: { departAfter: "09:00" } },
    ];
    const r = gradeArgs(
      calls,
      {
        expectTool: "getTrainTimetable",
        expectArgs: (a) => (a.departAfter === "09:00" ? null : "bad"),
      },
      ctx,
    );
    expect(r.pass).toBe(true);
  });

  it("fails with a reason when the predicate rejects", () => {
    const calls = [
      { name: "getTrainTimetable", args: { departAfter: "10:00" } },
    ];
    const r = gradeArgs(
      calls,
      {
        expectTool: "getTrainTimetable",
        expectArgs: (a) =>
          a.departAfter === "09:00" ? null : `departAfter=${a.departAfter}`,
      },
      ctx,
    );
    expect(r).toEqual({ pass: false, reason: "departAfter=10:00" });
  });

  it("grades the expected tool among several calls", () => {
    const calls = [
      { name: "other", args: {} },
      { name: "getStationTimetable", args: { railSystem: "THSR" } },
    ];
    const r = gradeArgs(
      calls,
      {
        expectTool: "getStationTimetable",
        expectArgs: (a) => (a.railSystem === "THSR" ? null : "wrong system"),
      },
      ctx,
    );
    expect(r.pass).toBe(true);
  });

  it("passes when the expected tool did not fire (name grading owns that)", () => {
    const r = gradeArgs(
      [{ name: "other", args: {} }],
      {
        expectTool: "getTrainTimetable",
        expectArgs: () => "should not run",
      },
      ctx,
    );
    expect(r.pass).toBe(true);
  });

  it("passes __none__ and cases without expectArgs", () => {
    expect(gradeArgs([], { expectTool: "__none__" }, ctx).pass).toBe(true);
    expect(
      gradeArgs([{ name: "x", args: {} }], { expectTool: "x" }, ctx).pass,
    ).toBe(true);
  });
});
