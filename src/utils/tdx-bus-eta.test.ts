import { describe, expect, it } from "vitest";
import {
  busEtaIsFresh,
  busEtaSeconds,
  rememberBusEtaReceipt,
} from "./tdx-bus-eta";
import { BUS_ETA_MAX_AGE_MS } from "../constants/bus";

const now = Date.parse("2026-10-05T12:00:00+08:00");
const ago = (seconds: number) => new Date(now - seconds * 1000).toISOString();

describe("TDX N1 source age and countdown", () => {
  it("subtracts streaming transmission age, rather than the fresh TDX wrapper time", () => {
    expect(
      busEtaSeconds(
        { EstimateTime: 180, SrcTransTime: ago(60), UpdateTime: ago(0) },
        now,
      ),
    ).toBe(120);
  });
  it("uses batch source time and computation time when transmission time is absent", () => {
    expect(
      busEtaSeconds({ EstimateTime: 180, SrcUpdateTime: ago(30) }, now),
    ).toBe(150);
    expect(busEtaSeconds({ EstimateTime: 180, DataTime: ago(45) }, now)).toBe(
      135,
    );
  });
  it("does not turn an elapsed positive prediction into an arriving bus", () => {
    expect(
      busEtaSeconds({ EstimateTime: 30, SrcTransTime: ago(60) }, now),
    ).toBeNull();
  });
  it("preserves a recently published arriving bus but expires an old zero", () => {
    expect(busEtaSeconds({ EstimateTime: 0, SrcTransTime: ago(10) }, now)).toBe(
      0,
    );
    expect(
      busEtaSeconds({ EstimateTime: 0, SrcTransTime: ago(60) }, now),
    ).toBeNull();
  });
  it("rejects retained two-hour records even with a recent UpdateTime", () => {
    const row = {
      EstimateTime: 9000,
      SrcTransTime: ago(7200),
      UpdateTime: ago(0),
    };
    expect(busEtaIsFresh(row, now)).toBe(false);
    expect(busEtaSeconds(row, now)).toBeNull();
  });
  it("rejects corrupt or far-future source timestamps instead of masking them", () => {
    for (const SrcTransTime of ["invalid", ago(-60)]) {
      expect(
        busEtaSeconds(
          { EstimateTime: 180, SrcTransTime, UpdateTime: ago(0) },
          now,
        ),
      ).toBeNull();
    }
  });
  it("tolerates small source clock skew without increasing the estimate", () => {
    expect(
      busEtaSeconds({ EstimateTime: 180, SrcTransTime: ago(-10) }, now),
    ).toBe(180);
  });
  it("ages cached records even when the source omits its timestamps", () => {
    const row = { EstimateTime: 180 };
    rememberBusEtaReceipt([row], now);
    expect(busEtaSeconds(row, now + 60000)).toBe(120);
    expect(busEtaIsFresh(row, now + BUS_ETA_MAX_AGE_MS + 1)).toBe(false);
    expect(row).toEqual({ EstimateTime: 180 });
  });
  it.each([2, 3, 4])(
    "does not predict a bus with StopStatus %i",
    (StopStatus) => {
      expect(busEtaSeconds({ EstimateTime: 60, StopStatus }, now)).toBeNull();
    },
  );
  it("allows a scheduled not-yet-departed estimate but rejects a passed vehicle", () => {
    expect(busEtaSeconds({ EstimateTime: 60, StopStatus: 1 }, now)).toBe(60);
    expect(
      busEtaSeconds({ EstimateTime: 60, PlateNumb: "-1" }, now),
    ).toBeNull();
  });
  it.each([NaN, Infinity, -1, null, undefined])(
    "rejects invalid estimate %s",
    (EstimateTime) => {
      expect(busEtaSeconds({ EstimateTime }, now)).toBeNull();
    },
  );
});
