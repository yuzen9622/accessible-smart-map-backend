import { BUS_ETA_CLOCK_SKEW_MS, BUS_ETA_MAX_AGE_MS } from "../constants/bus";
import type { BusEtaTiming } from "../types/transit";

// Receipt time is internal metadata; never add it to public TDX response rows.
const receivedAt = new WeakMap<object, number>();

export function rememberBusEtaReceipt(
  rows: object[],
  nowMs = Date.now(),
): void {
  for (const row of rows) {
    if (row && typeof row === "object") receivedAt.set(row, nowMs);
  }
}

function sourceAgeMs(row: BusEtaTiming, nowMs: number): number | null {
  // SrcTransTime is the official streaming countdown reference. Batch feeds
  // instead publish SrcUpdateTime. TDX UpdateTime must not mask an old source.
  const time =
    row.SrcTransTime ?? row.SrcUpdateTime ?? row.DataTime ?? row.UpdateTime;
  const timestamp =
    time === undefined ? (receivedAt.get(row) ?? nowMs) : Date.parse(time);
  if (!Number.isFinite(timestamp)) return null;
  const age = nowMs - timestamp;
  if (age < -BUS_ETA_CLOCK_SKEW_MS || age > BUS_ETA_MAX_AGE_MS) return null;
  return Math.max(0, age);
}

export function busEtaIsFresh(row: BusEtaTiming, nowMs = Date.now()): boolean {
  return sourceAgeMs(row, nowMs) !== null;
}

/** Correct the N1 countdown; an elapsed positive prediction is unavailable, not arriving. */
export function busEtaSeconds(
  row: BusEtaTiming,
  nowMs = Date.now(),
): number | null {
  const age = sourceAgeMs(row, nowMs);
  if (
    age === null ||
    row.PlateNumb === "-1" ||
    (row.StopStatus !== undefined && row.StopStatus >= 2)
  )
    return null;
  const estimate = row.EstimateTime;
  if (
    typeof estimate !== "number" ||
    !Number.isFinite(estimate) ||
    estimate < 0
  )
    return null;
  if (estimate === 0) return age <= BUS_ETA_CLOCK_SKEW_MS ? 0 : null;
  const seconds = estimate - age / 1000;
  if (seconds < 0) return null;
  return seconds;
}
