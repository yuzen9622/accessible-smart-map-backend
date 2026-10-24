import { ELEVATION_LIMITS } from "../config/elevation";
import type { AccessibleRoute } from "../types/route";
import type {
  ElevationProfile,
  ElevationSample,
  UnavailableElevationProfile,
} from "../types/elevation";
import { haversineCoords } from "./geo";

type Position = [number, number];
export interface SampledWalkLine {
  distanceM: number;
  samples: Omit<ElevationSample, "elevationM">[];
}

export function sampleWalkingRoute(
  legs: AccessibleRoute["legs"],
): SampledWalkLine | UnavailableElevationProfile {
  const points: Position[] = [];
  for (const leg of legs) {
    if (
      leg.type !== "WALK" ||
      !Array.isArray(leg.polyline) ||
      leg.polyline.length < 2
    ) {
      return { status: "unavailable", reason: "invalid_geometry" };
    }
    for (const [index, point] of leg.polyline.entries()) {
      if (
        !Array.isArray(point) ||
        point.length !== 2 ||
        !Number.isFinite(point[0]) ||
        !Number.isFinite(point[1]) ||
        Math.abs(point[0]) > 180 ||
        Math.abs(point[1]) > 90
      )
        return { status: "unavailable", reason: "invalid_geometry" };
      const previous = points.at(-1);
      const gap = previous ? haversineCoords(previous, point) : 0;
      if (index === 0 && previous && gap > 1) {
        return { status: "unavailable", reason: "invalid_geometry" };
      }
      if (!previous || gap > 1e-6) points.push(point);
    }
  }
  if (points.length < 2)
    return { status: "unavailable", reason: "invalid_geometry" };
  const cumulative = [0];
  for (let i = 1; i < points.length; i++) {
    cumulative.push(
      cumulative[i - 1] + haversineCoords(points[i - 1], points[i]),
    );
  }
  const total = cumulative[cumulative.length - 1];
  if (total > ELEVATION_LIMITS.maxRouteM)
    return { status: "unavailable", reason: "route_too_long" };
  const samples: SampledWalkLine["samples"] = [];
  let segment = 0;
  for (
    let offset = 0;
    offset < total;
    offset += ELEVATION_LIMITS.samplingIntervalM
  ) {
    while (segment < points.length - 2 && cumulative[segment + 1] < offset)
      segment++;
    const a = points[segment],
      b = points[segment + 1];
    const ratio =
      (offset - cumulative[segment]) /
      (cumulative[segment + 1] - cumulative[segment]);
    samples.push({
      distanceM: offset,
      coordinates: [a[0] + (b[0] - a[0]) * ratio, a[1] + (b[1] - a[1]) * ratio],
    });
  }
  samples.push({
    distanceM: total,
    coordinates: [...points[points.length - 1]],
  });
  return { distanceM: total, samples };
}

export function elevationGain(values: readonly number[]) {
  let ascentM = 0,
    descentM = 0;
  for (let i = 1; i < values.length; i++) {
    const delta = values[i] - values[i - 1];
    ascentM += Math.max(0, delta);
    descentM += Math.max(0, -delta);
  }
  return {
    ascentM,
    descentM,
    netElevationM: values[values.length - 1] - values[0],
  };
}

export function makeElevationProfile(
  line: SampledWalkLine,
  heights: readonly (number | null)[],
): ElevationProfile {
  if (heights.length !== line.samples.length)
    return { status: "unavailable", reason: "data_unavailable" };
  const samples = line.samples.map((point, i) => ({
    ...point,
    elevationM:
      heights[i] !== null && Number.isFinite(heights[i]) ? heights[i] : null,
  }));
  const known = samples.flatMap((point) =>
    point.elevationM === null ? [] : [point.elevationM],
  );
  if (!known.length) return { status: "unavailable", reason: "no_coverage" };
  const complete = known.length === samples.length;
  return {
    status: complete ? "complete" : "partial",
    source: {
      dataset: "MOI_DTM_20M",
      kind: "terrain",
      resolutionM: 20,
      samplingIntervalM: 20,
      interpolation: "bilinear",
      smoothing: "none",
    },
    distanceM: line.distanceM,
    samples,
    summary: {
      ...(complete
        ? elevationGain(known)
        : { ascentM: null, descentM: null, netElevationM: null }),
      minElevationM: Math.min(...known),
      maxElevationM: Math.max(...known),
      validSamples: known.length,
      sampleCount: samples.length,
    },
  };
}
