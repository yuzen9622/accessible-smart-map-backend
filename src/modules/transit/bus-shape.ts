import { wktToGeoJson } from "../../utils/wkt";
import { haversineMeters } from "../../utils/geo";

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

const SIMPLIFY_TOLERANCE_M = 5;
const MULTI_JOIN_MAX_GAP_M = 50;
const METRES_PER_DEGREE = 111_320;

/**
 * Perpendicular distance from a point to a segment, in metres, using a local
 * equirectangular projection (accurate at route scale).
 *
 * @param p The point as [lng, lat].
 * @param a The segment start as [lng, lat].
 * @param b The segment end as [lng, lat].
 * @returns The distance in metres.
 */
function segmentDistanceM(
  p: [number, number],
  a: [number, number],
  b: [number, number],
): number {
  const kx = Math.cos((a[1] * Math.PI) / 180) * METRES_PER_DEGREE;
  const ky = METRES_PER_DEGREE;
  const px = (p[0] - a[0]) * kx;
  const py = (p[1] - a[1]) * ky;
  const bx = (b[0] - a[0]) * kx;
  const by = (b[1] - a[1]) * ky;
  const len2 = bx * bx + by * by;
  const t =
    len2 === 0 ? 0 : Math.max(0, Math.min(1, (px * bx + py * by) / len2));
  return Math.hypot(px - t * bx, py - t * by);
}

/**
 * Douglas–Peucker simplification of a [lng, lat] path.
 *
 * @param path The input path.
 * @param toleranceM Maximum allowed deviation in metres.
 * @returns The simplified path; endpoints are always kept.
 */
export function simplifyPath(
  path: BusShapePath,
  toleranceM = SIMPLIFY_TOLERANCE_M,
): BusShapePath {
  if (path.length <= 2) return path;
  const keep = new Uint8Array(path.length);
  keep[0] = 1;
  keep[path.length - 1] = 1;
  const stack: [number, number][] = [[0, path.length - 1]];
  while (stack.length) {
    const [start, end] = stack.pop()!;
    let maxDist = 0;
    let index = -1;
    for (let i = start + 1; i < end; i++) {
      const d = segmentDistanceM(path[i], path[start], path[end]);
      if (d > maxDist) {
        maxDist = d;
        index = i;
      }
    }
    if (index !== -1 && maxDist > toleranceM) {
      keep[index] = 1;
      stack.push([start, index], [index, end]);
    }
  }
  return path.filter((_, i) => keep[i]);
}

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
 * Rounds a [lng, lat] pair to ~0.1 m; TDX ships up to 14 decimals.
 *
 * @param coordinate The [lng, lat] pair.
 * @returns The rounded pair.
 */
function roundCoordinate([lng, lat]: [number, number]): [number, number] {
  return [Math.round(lng * 1e6) / 1e6, Math.round(lat * 1e6) / 1e6];
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
      path: simplifyPath(path).map(roundCoordinate),
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
