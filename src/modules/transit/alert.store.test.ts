import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  clearAlertStore,
  getFreshAlertSnapshot,
  onAlertSnapshotUpdate,
  upsertAlertSnapshot,
} from "./alert.store";

beforeEach(() => {
  clearAlertStore();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("alert store", () => {
  it("returns the snapshot it stored", () => {
    upsertAlertSnapshot("metro:TRTC", [{ AlertID: "A1" }], "mqtt");

    const snapshot = getFreshAlertSnapshot("metro:TRTC");

    expect(snapshot?.alerts).toEqual([{ AlertID: "A1" }]);
    expect(snapshot?.source).toBe("mqtt");
    expect(snapshot?.updatedAt).toBeTypeOf("string");
  });

  it("returns null for an unknown key", () => {
    expect(getFreshAlertSnapshot("tra")).toBeNull();
  });

  it("expires a rest snapshot after 60 seconds", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-15T00:00:00.000Z"));
    upsertAlertSnapshot("tra", [{ AlertID: "T1" }], "rest");

    vi.setSystemTime(new Date("2026-08-15T00:00:59.000Z"));
    expect(getFreshAlertSnapshot("tra")?.alerts).toEqual([{ AlertID: "T1" }]);

    vi.setSystemTime(new Date("2026-08-15T00:01:00.000Z"));
    expect(getFreshAlertSnapshot("tra")).toBeNull();
  });

  it("keeps an mqtt snapshot fresh regardless of age", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-15T00:00:00.000Z"));
    upsertAlertSnapshot("bus:city:Taipei", [{ AlertID: "B1" }], "mqtt");

    vi.setSystemTime(new Date("2026-08-15T06:00:00.000Z"));
    expect(getFreshAlertSnapshot("bus:city:Taipei")?.alerts).toEqual([
      { AlertID: "B1" },
    ]);
  });

  it("overwrites an earlier snapshot for the same key", () => {
    upsertAlertSnapshot("thsr", [{ AlertID: "H1" }], "rest");
    upsertAlertSnapshot("thsr", [{ AlertID: "H2" }], "mqtt");

    const snapshot = getFreshAlertSnapshot("thsr");
    expect(snapshot?.alerts).toEqual([{ AlertID: "H2" }]);
    expect(snapshot?.source).toBe("mqtt");
  });

  it("notifies listeners with the updated key until unsubscribed", () => {
    const listener = vi.fn();
    const unsubscribe = onAlertSnapshotUpdate(listener);

    upsertAlertSnapshot("metro:TRTC", [], "mqtt");
    expect(listener).toHaveBeenCalledWith("metro:TRTC");

    unsubscribe();
    upsertAlertSnapshot("metro:KRTC", [], "mqtt");
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("drops every snapshot on clear", () => {
    upsertAlertSnapshot("tra", [{ AlertID: "T1" }], "mqtt");
    clearAlertStore();

    expect(getFreshAlertSnapshot("tra")).toBeNull();
  });
});
