import { describe, expect, it } from "vitest";
import { nextTaipeiClock } from "./taipei-time";

describe("nextTaipeiClock", () => {
  const now = new Date("2026-10-01T12:17:30Z"); // 20:17:30 Taipei

  it.each([
    ["23:59", "2026-10-01T15:59:00.000Z"],
    ["20:17", "2026-10-01T12:17:00.000Z"],
    ["20:16", "2026-10-02T12:16:00.000Z"],
    ["07:30", "2026-10-01T23:30:00.000Z"],
  ])("resolves %s to %s", (hhmm, expected) => {
    expect(nextTaipeiClock(hhmm, now)?.toISOString()).toBe(expected);
  });

  it.each(["24:00", "7:30", "2026-10-01T20:30", ""])("ignores %j", (value) => {
    expect(nextTaipeiClock(value, now)).toBeUndefined();
  });
});
