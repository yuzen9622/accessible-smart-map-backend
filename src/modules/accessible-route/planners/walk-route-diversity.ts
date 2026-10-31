import type { AccessibleRoute } from "../../../types/route";

type Point = readonly [number, number];
interface MetricPoint {
  x: number;
  y: number;
}
interface Segment {
  start: MetricPoint;
  end: MetricPoint;
  length: number;
}
interface Sample {
  point: MetricPoint;
  length: number;
}
interface WalkShape {
  samples: Sample[];
  distance: number;
  grid: Map<string, Segment[]>;
}

const METRES_PER_DEGREE = 111_195;
const MATCH_DISTANCE_M = 1.5;
const MAX_SHARED_FRACTION = 0.75;
const SAMPLE_SPACING_M = 4;
const GRID_CELL_M = 16;
const MAX_POINTS = 12_000;
const MAX_SAMPLES = 8_000;
const MAX_GRID_REFERENCES = 100_000;
const MAX_COMPARISONS = 400_000;
const MAX_TOTAL_COMPARISONS = 2_000_000;
const MAX_LEG_GAP_M = MATCH_DISTANCE_M;
const MAX_CANDIDATES = 24;

function cellKey(x: number, y: number): string {
  return `${x},${y}`;
}

function validPoint(point: Point): boolean {
  return (
    Array.isArray(point) &&
    Number.isFinite(point[0]) &&
    Number.isFinite(point[1]) &&
    Math.abs(point[0]) <= 180 &&
    Math.abs(point[1]) <= 90
  );
}

function project([lng, lat]: Point, longitudeScale: number): MetricPoint {
  return { x: lng * longitudeScale, y: lat * METRES_PER_DEGREE };
}

function distance(a: MetricPoint, b: MetricPoint): number {
  return Math.hypot(b.x - a.x, b.y - a.y);
}

function pointAlong(segment: Segment, fraction: number): MetricPoint {
  return {
    x: segment.start.x + (segment.end.x - segment.start.x) * fraction,
    y: segment.start.y + (segment.end.y - segment.start.y) * fraction,
  };
}

function segmentDistance(point: MetricPoint, segment: Segment): number {
  const dx = segment.end.x - segment.start.x;
  const dy = segment.end.y - segment.start.y;
  const denominator = dx * dx + dy * dy;
  const position = denominator
    ? Math.max(
        0,
        Math.min(
          1,
          ((point.x - segment.start.x) * dx +
            (point.y - segment.start.y) * dy) /
            denominator,
        ),
      )
    : 0;
  return Math.hypot(
    point.x - segment.start.x - position * dx,
    point.y - segment.start.y - position * dy,
  );
}

function buildShape(
  route: AccessibleRoute,
  longitudeScale: number,
): WalkShape | null {
  if (!route.legs.length) return null;
  const samples: Sample[] = [];
  const grid = new Map<string, Segment[]>();
  let totalDistance = 0;
  let totalPoints = 0;
  let gridReferences = 0;
  let previousLegEnd: MetricPoint | undefined;

  for (const leg of route.legs) {
    if (
      leg.type !== "WALK" ||
      !Array.isArray(leg.polyline) ||
      leg.polyline.length < 2
    )
      return null;
    totalPoints += leg.polyline.length;
    if (totalPoints > MAX_POINTS || !leg.polyline.every(validPoint))
      return null;
    const points = leg.polyline.map((point) => project(point, longitudeScale));
    if (previousLegEnd && distance(previousLegEnd, points[0]) > MAX_LEG_GAP_M)
      return null;
    previousLegEnd = points[points.length - 1];
    let legDistance = 0;

    for (let i = 1; i < points.length; i++) {
      const length = distance(points[i - 1], points[i]);
      if (!length) continue;
      const segment: Segment = { start: points[i - 1], end: points[i], length };
      totalDistance += length;
      legDistance += length;
      const sampleCount = Math.ceil(length / SAMPLE_SPACING_M);
      if (samples.length + sampleCount > MAX_SAMPLES) return null;
      for (let j = 0; j < sampleCount; j++) {
        samples.push({
          point: pointAlong(segment, (j + 0.5) / sampleCount),
          length: length / sampleCount,
        });
      }

      const pieceCount = Math.ceil(length / GRID_CELL_M);
      for (let j = 0; j < pieceCount; j++) {
        const start = pointAlong(segment, j / pieceCount);
        const end = pointAlong(segment, (j + 1) / pieceCount);
        const piece: Segment = { start, end, length: length / pieceCount };
        const minX = Math.floor(
          (Math.min(start.x, end.x) - MATCH_DISTANCE_M) / GRID_CELL_M,
        );
        const maxX = Math.floor(
          (Math.max(start.x, end.x) + MATCH_DISTANCE_M) / GRID_CELL_M,
        );
        const minY = Math.floor(
          (Math.min(start.y, end.y) - MATCH_DISTANCE_M) / GRID_CELL_M,
        );
        const maxY = Math.floor(
          (Math.max(start.y, end.y) + MATCH_DISTANCE_M) / GRID_CELL_M,
        );
        for (let x = minX; x <= maxX; x++) {
          for (let y = minY; y <= maxY; y++) {
            if (++gridReferences > MAX_GRID_REFERENCES) return null;
            const key = cellKey(x, y);
            const items = grid.get(key);
            if (items) items.push(piece);
            else grid.set(key, [piece]);
          }
        }
      }
    }
    if (!legDistance) return null;
  }
  return totalDistance > 0 ? { samples, distance: totalDistance, grid } : null;
}

interface ComparisonBudget {
  remaining: number;
}

function overlapFraction(
  source: WalkShape,
  target: WalkShape,
  budget: ComparisonBudget,
): number | null {
  let sharedDistance = 0;
  let comparisons = 0;
  for (const sample of source.samples) {
    const key = cellKey(
      Math.floor(sample.point.x / GRID_CELL_M),
      Math.floor(sample.point.y / GRID_CELL_M),
    );
    const nearby = target.grid.get(key) ?? [];
    for (const segment of nearby) {
      if (++comparisons > MAX_COMPARISONS || --budget.remaining < 0)
        return null;
      if (segmentDistance(sample.point, segment) <= MATCH_DISTANCE_M) {
        sharedDistance += sample.length;
        break;
      }
    }
  }
  return sharedDistance / source.distance;
}

type Candidate<T> = { route: T; shape: WalkShape; index: number; tier: string };

function hazardTier(route: AccessibleRoute): string {
  const blocking = route.hazardAdvisory?.blockingOnRoute ?? 0;
  const penalty = blocking > 0 ? (route.hazardAdvisory?.penaltyPoints ?? 0) : 0;
  return `${blocking}:${penalty}`;
}

function isDistinct(
  a: WalkShape,
  b: WalkShape,
  budget: ComparisonBudget,
): boolean {
  const forward = overlapFraction(a, b, budget);
  const reverse = overlapFraction(b, a, budget);
  return (
    forward !== null &&
    reverse !== null &&
    forward < MAX_SHARED_FRACTION &&
    reverse < MAX_SHARED_FRACTION
  );
}

/** Compare named street distances as well as geometry, so opposite sidewalks
 * are not advertised as separate main-road alternatives. Unknown names cannot
 * establish a different corridor; they remain eligible as the primary route. */
function namedStreetDistances(route: AccessibleRoute): Map<string, number> {
  const streets = new Map<string, number>();
  for (const leg of route.legs) {
    if (leg.type !== "WALK") continue;
    for (const step of leg.steps ?? []) {
      const name = step.streetName
        .trim()
        .toLowerCase()
        .replace(/人行道|sidewalk/g, "")
        .replace(/[（(].*?[）)]/g, "")
        .replace(/[一二三四五六七八九十百\d]+段.*$|\d+巷.*$/g, "")
        .replace(/\s+/g, "");
      if (
        step.bogusName ||
        !name ||
        /^\d+(?:[;,-]\d+)*$/.test(name) ||
        /^(steps|stairs|footway|path|walkway|人行通道|樓梯|無名道路)$/.test(
          name,
        )
      )
        continue;
      if (Number.isFinite(step.distanceM) && step.distanceM > 0)
        streets.set(name, (streets.get(name) ?? 0) + step.distanceM);
    }
  }
  return streets;
}

function differentNamedCorridors(
  a: AccessibleRoute,
  b: AccessibleRoute,
  aDistance: number,
  bDistance: number,
): boolean {
  const aStreets = namedStreetDistances(a);
  const bStreets = namedStreetDistances(b);
  let aNamed = 0;
  let bNamed = 0;
  let shared = 0;
  for (const [name, distance] of aStreets) {
    aNamed += distance;
    shared += Math.min(distance, bStreets.get(name) ?? 0);
  }
  for (const distance of bStreets.values()) {
    bNamed += distance;
  }
  return (
    aNamed >= aDistance * 0.1 &&
    bNamed >= bDistance * 0.1 &&
    aNamed - shared > aNamed * (1 - MAX_SHARED_FRACTION) &&
    bNamed - shared > bNamed * (1 - MAX_SHARED_FRACTION)
  );
}

/** Select already-ranked walking routes with distinguishable geometry. */
export function selectDiverseWalkRoutes<T extends AccessibleRoute>(
  routes: readonly T[],
  differentCorridors = false,
): T[] {
  if (!routes.length) return [];
  const first = routes[0];
  const firstPoint = first.legs[0]?.polyline?.[0];
  if (!firstPoint || !validPoint(firstPoint)) return [first];
  const longitudeScale =
    METRES_PER_DEGREE * Math.cos((firstPoint[1] * Math.PI) / 180);
  if (Math.abs(longitudeScale) < METRES_PER_DEGREE * 0.05) return [first];
  const firstShape = buildShape(first, longitudeScale);
  if (!firstShape) return [first];

  const candidates: Candidate<T>[] = [];
  const tiers: string[] = [];
  const budget: ComparisonBudget = { remaining: MAX_TOTAL_COMPARISONS };
  for (const [index, route] of routes.slice(1, MAX_CANDIDATES).entries()) {
    const shape = buildShape(route, longitudeScale);
    if (
      !shape ||
      !isDistinct(shape, firstShape, budget) ||
      (differentCorridors &&
        !differentNamedCorridors(
          route,
          first,
          shape.distance,
          firstShape.distance,
        ))
    )
      continue;
    const tier = hazardTier(route);
    if (!tiers.includes(tier)) tiers.push(tier);
    candidates.push({ route, shape, index: index + 1, tier });
  }

  const better = (a: Candidate<T>[], b: Candidate<T>[]): boolean => {
    for (const tier of tiers) {
      const difference =
        a.filter((candidate) => candidate.tier === tier).length -
        b.filter((candidate) => candidate.tier === tier).length;
      if (difference) return difference > 0;
    }
    if (a.length !== b.length) return a.length > b.length;
    return a.some((candidate, index) => {
      const other = b[index];
      return (
        other !== undefined &&
        candidate.index < other.index &&
        a.slice(0, index).every((prior, i) => prior.index === b[i].index)
      );
    });
  };

  let best: Candidate<T>[] = [];
  for (let i = 0; i < candidates.length; i++) {
    const one = [candidates[i]];
    if (better(one, best)) best = one;
    for (let j = i + 1; j < candidates.length; j++) {
      const pair = [candidates[i], candidates[j]];
      if (!better(pair, best)) continue;
      if (
        isDistinct(pair[0].shape, pair[1].shape, budget) &&
        (!differentCorridors ||
          differentNamedCorridors(
            pair[0].route,
            pair[1].route,
            pair[0].shape.distance,
            pair[1].shape.distance,
          ))
      )
        best = pair;
    }
  }
  return [first, ...best.map(({ route }) => route)];
}
