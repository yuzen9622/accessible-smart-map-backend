import path from "node:path";

export const ELEVATION_LIMITS = Object.freeze({
  samplingIntervalM: 20,
  maxRouteM: 50_000,
  maxSamplesPerRoute: 2501,
  maxCandidates: 3,
  maxBatchPoints: 7503,
  maxActiveWorkers: 2,
  deadlineMs: 1500,
  maxWindows: 256,
  maxWindowPx: 256,
});

export function getElevationDtmPath(): string | undefined {
  const configured = process.env.ROUTE_ELEVATION_DTM_PATH;
  if (configured !== undefined && configured.trim() === "") return undefined;
  return path.resolve(configured?.trim() ?? "otp-data/dem/taiwan-dtm-20m.tif");
}
