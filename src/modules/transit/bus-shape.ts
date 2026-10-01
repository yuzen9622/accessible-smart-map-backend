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
