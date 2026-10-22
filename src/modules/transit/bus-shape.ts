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
 * RouteUID only; that fallback is used only when the RouteUID has a single
 * sub-route in this direction, since otherwise the shape could belong to a
 * different branch.
 *
 * @param target The sub-route direction to draw.
 * @param shapes Normalized shapes for the route.
 * @param siblings Every sub-route direction of the route, for the uniqueness check.
 * @returns The path, or null when no shape can be attributed safely.
 */
export function matchBusShape(
  target: BusShapeTarget,
  shapes: BusShape[],
  siblings: BusShapeTarget[],
): BusShapePath | null {
  const exact = shapes.find(
    (s) =>
      s.subRouteUid === target.subRouteUid && s.direction === target.direction,
  );
  if (exact) return exact.path;

  if (!target.routeUid) return null;
  const sameRouteDirection = siblings.filter(
    (s) => s.routeUid === target.routeUid && s.direction === target.direction,
  );
  if (sameRouteDirection.length !== 1) return null;
  const byRoute = shapes.filter(
    (s) =>
      !s.subRouteUid &&
      s.routeUid === target.routeUid &&
      s.direction === target.direction,
  );
  return byRoute.length === 1 ? byRoute[0].path : null;
}

/** Project ordered stops onto the same directed shape, retaining road bends. */
export function trimBusShape(
  path: BusShapePath,
  stops: BusShapePath,
  range: { from: number; to: number } = { from: 0, to: stops.length - 1 },
): BusShapePath | null {
  if (path.length < 2 || stops.length < 2) return null;
  const positions: {
    segment: number;
    fraction: number;
    point: [number, number];
  }[] = [];
  let previous = 0;
  for (const stop of stops) {
    let best:
      | {
          segment: number;
          fraction: number;
          point: [number, number];
          distance: number;
        }
      | undefined;
    const scale = Math.cos((stop[1] * Math.PI) / 180);
    for (
      let segment = Math.floor(previous);
      segment < path.length - 1;
      segment++
    ) {
      const a = path[segment],
        b = path[segment + 1];
      const dx = (b[0] - a[0]) * scale,
        dy = b[1] - a[1];
      const length = dx * dx + dy * dy;
      if (!length) continue;
      const fraction = Math.max(
        segment === Math.floor(previous) ? previous - segment : 0,
        Math.min(
          1,
          ((stop[0] - a[0]) * scale * dx + (stop[1] - a[1]) * dy) / length,
        ),
      );
      const point: [number, number] = [
        a[0] + fraction * (b[0] - a[0]),
        a[1] + fraction * (b[1] - a[1]),
      ];
      const distance = haversineMeters(stop[1], stop[0], point[1], point[0]);
      if (!best || distance < best.distance)
        best = { segment, fraction, point, distance };
    }
    // Stops can sit on the pavement beside the road, but not a different street.
    if (!best || best.distance > 75) return null;
    positions.push(best);
    previous = best.segment + best.fraction;
  }
  const first = positions[range.from],
    last = positions[range.to];
  if (!first || !last) return null;
  if (last.segment + last.fraction <= first.segment + first.fraction)
    return null;
  return [
    first.point,
    ...path.slice(first.segment + 1, last.segment + 1),
    last.point,
  ].filter(
    (point, index, all) =>
      index === 0 ||
      point[0] !== all[index - 1][0] ||
      point[1] !== all[index - 1][1],
  );
}
