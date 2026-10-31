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
interface RoadShape {
  samples: Sample[];
  distance: number;
  grid: Map<string, Segment[]>;
}

const METRES_PER_DEGREE = 111_195;
const MATCH_DISTANCE_M = 5;
const MAX_SHARED_FRACTION = 0.75;
const SAMPLE_SPACING_M = 8;
const GRID_CELL_M = 16;
const MAX_POINTS = 12_000;
const MAX_SAMPLES = 8_000;
const MAX_GRID_REFERENCES = 100_000;
const MAX_COMPARISONS = 400_000;
const MAX_TOTAL_COMPARISONS = 2_000_000;
const MAX_LEG_GAP_M = MATCH_DISTANCE_M;

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
): RoadShape | null {
  if (!route.legs.length) return null;
  const samples: Sample[] = [];
  const grid = new Map<string, Segment[]>();
  let totalDistance = 0;
  let totalPoints = 0;
  let gridReferences = 0;
  let previousLegEnd: MetricPoint | undefined;
  let hasRoadLeg = false;

  for (const leg of route.legs) {
    if (
      (leg.type !== "WALK" &&
        leg.type !== "DRIVE" &&
        leg.type !== "MOTORCYCLE") ||
      !Array.isArray(leg.polyline) ||
      leg.polyline.length < 2
    )
      return null;
    if (leg.type !== "WALK") hasRoadLeg = true;
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
  return hasRoadLeg && totalDistance > 0
    ? { samples, distance: totalDistance, grid }
    : null;
}

interface ComparisonBudget {
  remaining: number;
}

function overlapFraction(
  source: RoadShape,
  target: RoadShape,
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

export function createRoadGeometryComparison(first: AccessibleRoute) {
  const firstPoint = first.legs[0]?.polyline?.[0];
  if (!firstPoint || !validPoint(firstPoint)) return null;
  const longitudeScale =
    METRES_PER_DEGREE * Math.cos((firstPoint[1] * Math.PI) / 180);
  if (Math.abs(longitudeScale) < METRES_PER_DEGREE * 0.05) return null;
  const firstShape = buildShape(first, longitudeScale);
  if (!firstShape) return null;
  const budget: ComparisonBudget = { remaining: MAX_TOTAL_COMPARISONS };
  return {
    firstShape,
    shape: (route: AccessibleRoute) => buildShape(route, longitudeScale),
    distinct: (a: RoadShape, b: RoadShape): boolean => {
      const forward = overlapFraction(a, b, budget);
      const reverse = overlapFraction(b, a, budget);
      return (
        forward !== null &&
        reverse !== null &&
        forward < MAX_SHARED_FRACTION &&
        reverse < MAX_SHARED_FRACTION
      );
    },
  };
}
