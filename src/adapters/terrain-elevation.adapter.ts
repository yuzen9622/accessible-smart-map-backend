import path from "node:path";
import { Worker } from "node:worker_threads";
import { ELEVATION_LIMITS, getElevationDtmPath } from "../config/elevation";
import type { ElevationUnavailableReason } from "../types/elevation";

export type TerrainSampleResult =
  | { ok: true; elevations: (number | null)[] }
  | { ok: false; reason: ElevationUnavailableReason };

let activeWorkers = 0;

export async function sampleTerrain(
  points: readonly [number, number][],
  deadlineMs: number = ELEVATION_LIMITS.deadlineMs,
): Promise<TerrainSampleResult> {
  const filePath = getElevationDtmPath();
  if (!filePath) return { ok: false, reason: "not_configured" };
  if (points.length > ELEVATION_LIMITS.maxBatchPoints)
    return { ok: false, reason: "resource_limit" };
  if (
    !points.every(
      (p) =>
        Array.isArray(p) &&
        p.length === 2 &&
        Number.isFinite(p[0]) &&
        Number.isFinite(p[1]) &&
        Math.abs(p[0]) <= 180 &&
        Math.abs(p[1]) <= 90,
    )
  ) {
    return { ok: false, reason: "invalid_geometry" };
  }
  if (!points.length) return { ok: true, elevations: [] };
  if (activeWorkers >= ELEVATION_LIMITS.maxActiveWorkers)
    return { ok: false, reason: "busy" };
  const budget = Number.isFinite(deadlineMs)
    ? Math.min(ELEVATION_LIMITS.deadlineMs, Math.max(1, deadlineMs))
    : ELEVATION_LIMITS.deadlineMs;
  return new Promise((resolve) => {
    let settled = false;
    let worker: Worker | undefined;
    let outcome: TerrainSampleResult | undefined;
    const finish = (result: TerrainSampleResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => {
      finish({ ok: false, reason: "timeout" });
      void worker?.terminate();
    }, budget);
    try {
      worker = new Worker(path.join(__dirname, "terrain-elevation.worker.js"), {
        execArgv: [],
        resourceLimits: { maxOldGenerationSizeMb: 128, stackSizeMb: 4 },
        workerData: {
          filePath,
          points,
          limits: ELEVATION_LIMITS,
          geotiffPath: require.resolve("geotiff"),
        },
      });
      activeWorkers++;
      worker.once("message", (result: TerrainSampleResult) => {
        if (
          result.ok &&
          (result.elevations.length !== points.length ||
            !result.elevations.every((v) => v === null || Number.isFinite(v)))
        ) {
          outcome = { ok: false, reason: "data_unavailable" };
        } else outcome = result;
      });
      worker.once("error", () => {
        outcome = { ok: false, reason: "data_unavailable" };
        void worker?.terminate();
      });
      worker.once("exit", () => {
        activeWorkers--;
        finish(outcome ?? { ok: false, reason: "data_unavailable" });
      });
    } catch {
      finish({ ok: false, reason: "data_unavailable" });
    }
  });
}
