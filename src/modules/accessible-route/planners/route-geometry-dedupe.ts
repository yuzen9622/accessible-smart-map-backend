import type { AccessibleRoute } from "../../../types/route";

type Point = readonly [number, number];

// Geometry is a fallback for routers that do not expose graph edge IDs.
// Keep this small enough to avoid merging nearby parallel streets.
const MATCH_DISTANCE_M = 1.5;
const MAX_SAMPLES = 600;
const MAX_POINTS = 12_000;
const SAMPLE_SPACING_M = 10;
const METRES_PER_LATITUDE = 111_195;

interface MetricPoint {
  x: number;
  y: number;
}

interface RouteShape {
  points: MetricPoint[];
  cumulative: number[];
  length: number;
}

function routePoints(route: AccessibleRoute): Point[] | null {
  if (!route.legs.length || route.legs.some((leg) => leg.polyline.length < 2))
    return null;

  const result: Point[] = [];
  for (const leg of route.legs) {
    for (const point of leg.polyline) {
      if (!Number.isFinite(point[0]) || !Number.isFinite(point[1])) return null;
      const last = result[result.length - 1];
      if (!last || last[0] !== point[0] || last[1] !== point[1]) {
        result.push(point);
        if (result.length > MAX_POINTS) return null;
      }
    }
  }
  return result.length >= 2 ? result : null;
}

function sameExactGeometry(a: AccessibleRoute, b: AccessibleRoute): boolean {
  if (!a.legs.length || a.legs.length !== b.legs.length) return false;
  let first: Point | undefined;
  let distinct = false;
  for (let legIndex = 0; legIndex < a.legs.length; legIndex++) {
    const left = a.legs[legIndex];
    const right = b.legs[legIndex];
    if (
      left.type !== right.type ||
      left.polyline.length < 2 ||
      left.polyline.length !== right.polyline.length
    )
      return false;
    for (let pointIndex = 0; pointIndex < left.polyline.length; pointIndex++) {
      const point = left.polyline[pointIndex];
      const other = right.polyline[pointIndex];
      if (
        !Number.isFinite(point[0]) ||
        !Number.isFinite(point[1]) ||
        point[0] !== other[0] ||
        point[1] !== other[1]
      )
        return false;
      if (!first) first = point;
      else if (point[0] !== first[0] || point[1] !== first[1]) distinct = true;
    }
  }
  return distinct;
}

export function dedupeExactRouteGeometry<T extends AccessibleRoute>(
  routes: readonly T[],
): T[] {
  const unique: T[] = [];
  for (const route of routes) {
    if (!unique.some((earlier) => sameExactGeometry(earlier, route))) {
      unique.push(route);
    }
  }
  return unique;
}

function project(
  points: Point[],
  origin: Point,
  latitude: number,
): RouteShape | null {
  const lonFactor = METRES_PER_LATITUDE * Math.cos((latitude * Math.PI) / 180);
  const metric = points.map(([lng, lat]) => ({
    x: (lng - origin[0]) * lonFactor,
    y: (lat - origin[1]) * METRES_PER_LATITUDE,
  }));
  const cumulative = [0];
  for (let i = 1; i < metric.length; i++) {
    cumulative.push(
      cumulative[i - 1] +
        Math.hypot(
          metric[i].x - metric[i - 1].x,
          metric[i].y - metric[i - 1].y,
        ),
    );
  }
  const length = cumulative[cumulative.length - 1];
  return length > 0 ? { points: metric, cumulative, length } : null;
}

function segmentDistance(
  point: MetricPoint,
  a: MetricPoint,
  b: MetricPoint,
): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lengthSquared = dx * dx + dy * dy;
  const position = lengthSquared
    ? Math.max(
        0,
        Math.min(
          1,
          ((point.x - a.x) * dx + (point.y - a.y) * dy) / lengthSquared,
        ),
      )
    : 0;
  return Math.hypot(
    point.x - a.x - position * dx,
    point.y - a.y - position * dy,
  );
}

function modeSequence(route: AccessibleRoute): string {
  return route.legs
    .reduce<string[]>((sequence, leg) => {
      if (sequence[sequence.length - 1] !== leg.type) sequence.push(leg.type);
      return sequence;
    }, [])
    .join(",");
}

function covers(source: RouteShape, target: RouteShape): boolean {
  const samples = Math.min(
    MAX_SAMPLES,
    Math.max(2, Math.ceil(source.length / SAMPLE_SPACING_M) + 1),
  );
  let sourceSegment = 1;
  let targetStart = 1;
  let comparisons = 0;
  const matchesAtProgress = (point: MetricPoint, progress: number): boolean => {
    const expected = target.length * progress;
    const window = Math.max(30, target.length * 0.02);
    while (
      targetStart < target.points.length - 1 &&
      target.cumulative[targetStart] < expected - window
    )
      targetStart++;
    for (let j = targetStart; j < target.points.length; j++) {
      if (target.cumulative[j - 1] > expected + window) break;
      // Uncertain or excessively dense geometry must not be discarded.
      if (++comparisons > 1_000_000) return false;
      if (
        segmentDistance(point, target.points[j - 1], target.points[j]) <=
        MATCH_DISTANCE_M
      )
        return true;
    }
    return false;
  };
  // Input vertices detect a short branch that falls between evenly spaced
  // samples on a very long journey.
  for (let i = 0; i < source.points.length; i++) {
    if (
      !matchesAtProgress(source.points[i], source.cumulative[i] / source.length)
    )
      return false;
  }
  targetStart = 1;
  for (let i = 0; i < samples; i++) {
    const distance = (source.length * i) / (samples - 1);
    while (
      sourceSegment < source.points.length - 1 &&
      source.cumulative[sourceSegment] < distance
    )
      sourceSegment++;
    const a = source.points[sourceSegment - 1];
    const b = source.points[sourceSegment];
    const segmentLength =
      source.cumulative[sourceSegment] - source.cumulative[sourceSegment - 1];
    const t = segmentLength
      ? (distance - source.cumulative[sourceSegment - 1]) / segmentLength
      : 0;
    const point = { x: a.x + t * (b.x - a.x), y: a.y + t * (b.y - a.y) };
    if (!matchesAtProgress(point, i / (samples - 1))) return false;
  }
  return true;
}

/** Drop routes only when both complete geometries trace the same path. */
export function dedupeRouteGeometry<T extends AccessibleRoute>(
  routes: readonly T[],
): T[] {
  const accepted: { route: T; points: Point[] | null }[] = [];
  for (const route of routes) {
    const points = routePoints(route);
    const duplicate = accepted.some((earlier) => {
      if (sameExactGeometry(earlier.route, route)) return true;
      if (!points || !earlier.points) return false;
      if (modeSequence(earlier.route) !== modeSequence(route)) return false;
      const latitude = (points[0][1] + earlier.points[0][1]) / 2;
      const a = project(points, points[0], latitude);
      const b = project(earlier.points, points[0], latitude);
      if (
        !a ||
        !b ||
        Math.abs(a.length - b.length) >
          Math.max(5, Math.min(a.length, b.length) * 0.02)
      )
        return false;
      return covers(a, b) && covers(b, a);
    });
    if (!duplicate) accepted.push({ route, points });
  }
  return accepted.map(({ route }) => route);
}
