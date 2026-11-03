import { wktToGeoJson } from "../../utils/wkt";
import {
  haversineMeters,
  roundCoordinate,
  simplifyPath,
} from "../../utils/geo";

export type BusShapePath = [number, number][];

export type BusShape = {
  routeUid?: string;
  subRouteUid?: string;
  direction: number;
  path: BusShapePath;
};

export type BusShapeTarget = {
  routeUid?: string;
  subRouteUid: string;
  direction: number;
};

const SHAPE_SIMPLIFY_TOLERANCE_M = 5;
const MULTI_JOIN_MAX_GAP_M = 50;

/**
 * Converts a TDX shape WKT into one drawable [lng, lat] path.
 *
 * A MULTILINESTRING is joined only when every member starts where the previous
 * one ended; otherwise flattening would draw a straight ghost segment across
 * the gap, so the shape is rejected instead.
 *
 * @param wkt The TDX `Geometry` value.
 * @returns The path, or null when the geometry is unusable.
 */
export function shapeWktToPath(
  wkt: string | null | undefined,
): BusShapePath | null {
  const geometry = wktToGeoJson(wkt);
  if (!geometry) return null;
  if (geometry.type === "LineString") return geometry.coordinates;
  if (geometry.type !== "MultiLineString") return null;

  const [first, ...rest] = geometry.coordinates;
  const path: BusShapePath = [...first];
  for (const line of rest) {
    const [lastLng, lastLat] = path[path.length - 1];
    const [nextLng, nextLat] = line[0];
    if (
      haversineMeters(lastLat, lastLng, nextLat, nextLng) > MULTI_JOIN_MAX_GAP_M
    )
      return null;
    path.push(...line.slice(1));
  }
  return path;
}

/**
 * Normalizes raw TDX Bus Shape rows into simplified paths.
 *
 * @param rows Raw TDX `/Bus/Shape` records.
 * @returns One entry per row with a usable geometry.
 */
export function normalizeBusShapes(rows: any[]): BusShape[] {
  const shapes: BusShape[] = [];
  for (const r of rows) {
    if (r?.Direction !== 0 && r?.Direction !== 1) continue;
    const path = shapeWktToPath(r.Geometry);
    if (!path) continue;
    shapes.push({
      routeUid: r.RouteUID ?? undefined,
      subRouteUid: r.SubRouteUID ?? undefined,
      direction: r.Direction,
      path: simplifyPath(path, SHAPE_SIMPLIFY_TOLERANCE_M).map(roundCoordinate),
    });
  }
  return shapes;
}

/**
 * Picks the shape belonging to one sub-route direction.
 *
 * Matches on SubRouteUID first. Some cities (e.g. Taipei) publish shapes per
 * RouteUID only. Such a shape is taken as is when the RouteUID has a single
 * sub-route in this direction. With several branches it could belong to any
 * of them, so it is taken only when it is the one route-level shape the
 * target's own stops follow in order, trimmed to those stops.
 *
 * @param target The sub-route direction to draw.
 * @param shapes Normalized shapes for the route.
 * @param siblings Every sub-route direction of the route, for the uniqueness check.
 * @param stops The target's ordered stop coordinates, to attribute a shared shape.
 * @returns The path, or null when no shape can be attributed safely.
 */
export function matchBusShape(
  target: BusShapeTarget,
  shapes: BusShape[],
  siblings: BusShapeTarget[],
  stops: BusShapePath,
): BusShapePath | null {
  const exact = shapes.find(
    (s) =>
      s.subRouteUid === target.subRouteUid && s.direction === target.direction,
  );
  if (exact) return exact.path;

  if (!target.routeUid) return null;
  const byRoute = shapes.filter(
    (s) =>
      !s.subRouteUid &&
      s.routeUid === target.routeUid &&
      s.direction === target.direction,
  );
  const sameRouteDirection = siblings.filter(
    (s) => s.routeUid === target.routeUid && s.direction === target.direction,
  );
  if (sameRouteDirection.length === 1)
    return byRoute.length === 1 ? byRoute[0].path : null;
  // A shared shape spans every branch; keep only this branch's own run.
  const followed = byRoute
    .map((s) => trimBusShape(s.path, stops))
    .filter((path): path is BusShapePath => path !== null);
  return followed.length === 1 ? followed[0] : null;
}

/** Stops can sit on the pavement beside the road, but not a different street. */
const STOP_MAX_OFFSET_M = 75;
/** Two stops sharing a pole or facing each other across a road may project
 * a few metres out of order; anything further back is a different pass. */
const STOP_BACKTRACK_SLACK_M = 30;

type StopProjection = {
  segment: number;
  fraction: number;
  point: [number, number];
  /** Metres along the shape from its first vertex. */
  along: number;
  offset: number;
};

/**
 * Project ordered stops onto the same directed shape, retaining road bends.
 *
 * A loop or out-and-back route passes the same road twice, so the nearest
 * point is often on the wrong pass. Every stop keeps each segment within
 * reach as a candidate, and the stops are matched together: the chosen
 * positions move forward along the shape with the smallest total offset.
 *
 * @param path The directed shape.
 * @param stops The route's stops, in order.
 * @param range The stop indexes to trim between.
 * @returns The trimmed path, or null when the stops do not follow the shape.
 */
export function trimBusShape(
  path: BusShapePath,
  stops: BusShapePath,
  range: { from: number; to: number } = { from: 0, to: stops.length - 1 },
): BusShapePath | null {
  if (path.length < 2 || stops.length < 2) return null;
  const starts = [0];
  for (let segment = 0; segment < path.length - 1; segment++)
    starts.push(
      starts[segment] +
        haversineMeters(
          path[segment][1],
          path[segment][0],
          path[segment + 1][1],
          path[segment + 1][0],
        ),
    );
  const candidates = stops.map((stop) => {
    const scale = Math.cos((stop[1] * Math.PI) / 180);
    const found: StopProjection[] = [];
    for (let segment = 0; segment < path.length - 1; segment++) {
      const a = path[segment],
        b = path[segment + 1];
      const dx = (b[0] - a[0]) * scale,
        dy = b[1] - a[1];
      const length = dx * dx + dy * dy;
      if (!length) continue;
      const fraction = Math.max(
        0,
        Math.min(
          1,
          ((stop[0] - a[0]) * scale * dx + (stop[1] - a[1]) * dy) / length,
        ),
      );
      const point: [number, number] = [
        a[0] + fraction * (b[0] - a[0]),
        a[1] + fraction * (b[1] - a[1]),
      ];
      const offset = haversineMeters(stop[1], stop[0], point[1], point[0]);
      if (offset > STOP_MAX_OFFSET_M) continue;
      found.push({
        segment,
        fraction,
        point,
        along:
          starts[segment] + fraction * (starts[segment + 1] - starts[segment]),
        offset,
      });
    }
    return found;
  });
  // cost[i][c]: least total offset of stops 0..i ending at candidate c.
  const cost: number[][] = [];
  const from: number[][] = [];
  for (const [i, options] of candidates.entries()) {
    cost.push([]);
    from.push([]);
    for (const option of options) {
      let best = i === 0 ? 0 : Infinity,
        previous = -1;
      if (i > 0)
        for (const [p, before] of candidates[i - 1].entries())
          if (
            before.along - STOP_BACKTRACK_SLACK_M <= option.along &&
            cost[i - 1][p] < best
          ) {
            best = cost[i - 1][p];
            previous = p;
          }
      cost[i].push(best + option.offset);
      from[i].push(previous);
    }
  }
  const last = cost.length - 1;
  let end = -1;
  for (const [c, value] of cost[last].entries())
    if (Number.isFinite(value) && (end < 0 || value < cost[last][end])) end = c;
  if (end < 0) return null;
  const positions: StopProjection[] = new Array(stops.length);
  for (let i = last, c = end; i >= 0; c = from[i][c], i--)
    positions[i] = candidates[i][c];
  const first = positions[range.from],
    final = positions[range.to];
  if (!first || !final || final.along <= first.along) return null;
  return [
    first.point,
    ...path.slice(first.segment + 1, final.segment + 1),
    final.point,
  ].filter(
    (point, index, all) =>
      index === 0 ||
      point[0] !== all[index - 1][0] ||
      point[1] !== all[index - 1][1],
  );
}
