import { tm2ToWgs84 } from "./taipei-ramps-parse";

/**
 * `licode` of a painted (marked) sidewalk in 交工處's road-marking layer. The
 * same shapefile carries every other road marking (crosswalks, stop lines,
 * arrows…); only this code is a walkable strip.
 */
export const PAINTED_SIDEWALK_LICODE = "21";

/** `walkerstat` value marking a removed strip; such rows are dropped. */
export const REMOVED_WALKERSTAT = "D";

/** Rings with less area than this (m²) are survey slivers, not a strip. */
const MIN_STRIP_AREA_M2 = 1;

export type TwdRing = readonly (readonly number[])[];

export interface PaintedSidewalkFeature {
  properties?: Record<string, unknown> | null;
  geometry?: {
    type?: unknown;
    coordinates?: unknown;
  } | null;
}

export interface ParsedPaintedSidewalk {
  keyid: number;
  /** WGS84 MultiPolygon coordinates. */
  coordinates: number[][][][];
  /** Strip width estimated from area and perimeter, metres; null when not a strip. */
  widthM: number | null;
}

export type PaintedSidewalkResult =
  | { status: "ok"; sidewalk: ParsedPaintedSidewalk }
  | { status: "other_marking" }
  | { status: "removed" }
  | { status: "malformed" };

/**
 * @param prj Contents of the shapefile's `.prj`.
 * @returns Whether it declares TWD97 / TM2 zone 121 (EPSG:3826).
 */
export function isTwd97Tm2Prj(prj: string): boolean {
  const compact = prj.replace(/\s+/g, "");
  return (
    /TWD_?1997/i.test(compact) &&
    /PARAMETER\["Central_Meridian",121(\.0+)?\]/i.test(compact) &&
    /PARAMETER\["False_Easting",250000(\.0+)?\]/i.test(compact) &&
    /PARAMETER\["Scale_Factor",0\.9999\]/i.test(compact)
  );
}

function ringArea(ring: TwdRing): number {
  let sum = 0;
  for (let i = 0; i + 1 < ring.length; i += 1) {
    sum += ring[i][0] * ring[i + 1][1] - ring[i + 1][0] * ring[i][1];
  }
  return Math.abs(sum) / 2;
}

function ringPerimeter(ring: TwdRing): number {
  let sum = 0;
  for (let i = 0; i + 1 < ring.length; i += 1) {
    sum += Math.hypot(ring[i + 1][0] - ring[i][0], ring[i + 1][1] - ring[i][1]);
  }
  return sum;
}

/**
 * Width of a rectangle with the given area and perimeter: solving L·W = A and
 * L + W = P/2 for the shorter side.
 *
 * @param areaM2 Polygon area in m².
 * @param perimeterM Outer-ring perimeter in metres.
 * @returns The short side in metres, or null when no such rectangle exists.
 */
export function stripWidthM(areaM2: number, perimeterM: number): number | null {
  const halfPerimeter = perimeterM / 2;
  const discriminant = halfPerimeter * halfPerimeter - 4 * areaM2;
  if (!(areaM2 > 0) || !(discriminant >= 0)) return null;
  const width = (halfPerimeter - Math.sqrt(discriminant)) / 2;
  return Number.isFinite(width) && width > 0
    ? Math.round(width * 100) / 100
    : null;
}

function isRing(value: unknown): value is number[][] {
  return (
    Array.isArray(value) &&
    value.length >= 4 &&
    value.every(
      (point) =>
        Array.isArray(point) &&
        point.length >= 2 &&
        Number.isFinite(point[0]) &&
        Number.isFinite(point[1]),
    )
  );
}

function polygonsOf(
  geometry: PaintedSidewalkFeature["geometry"],
): number[][][][] | null {
  if (!geometry) return null;
  const { type, coordinates } = geometry;
  const polygons =
    type === "Polygon"
      ? [coordinates]
      : type === "MultiPolygon"
        ? coordinates
        : null;
  if (!Array.isArray(polygons) || polygons.length === 0) return null;
  for (const polygon of polygons) {
    if (
      !Array.isArray(polygon) ||
      polygon.length === 0 ||
      !polygon.every(isRing)
    ) {
      return null;
    }
  }
  return polygons as number[][][][];
}

function text(value: unknown): string {
  return typeof value === "string"
    ? value.trim()
    : value == null
      ? ""
      : String(value);
}

/**
 * Parse one road-marking feature (TWD97 TM2 coordinates) into a painted
 * sidewalk polygon in WGS84.
 *
 * @param feature One GeoJSON feature as read from the shapefile.
 * @returns The parsed strip, or why it was rejected.
 */
export function parsePaintedSidewalkFeature(
  feature: PaintedSidewalkFeature,
): PaintedSidewalkResult {
  const properties = feature.properties ?? {};
  if (text(properties.licode) !== PAINTED_SIDEWALK_LICODE) {
    return { status: "other_marking" };
  }
  if (text(properties.walkerstat).toUpperCase() === REMOVED_WALKERSTAT) {
    return { status: "removed" };
  }
  const keyid = Number(properties.keyid);
  if (!Number.isSafeInteger(keyid) || keyid <= 0)
    return { status: "malformed" };
  const polygons = polygonsOf(feature.geometry);
  if (!polygons) return { status: "malformed" };

  let area = 0;
  let perimeter = 0;
  for (const polygon of polygons) {
    area += ringArea(polygon[0]);
    for (const hole of polygon.slice(1)) area -= ringArea(hole);
    perimeter += ringPerimeter(polygon[0]);
  }
  if (!(area >= MIN_STRIP_AREA_M2)) return { status: "malformed" };

  const coordinates = polygons.map((polygon) =>
    polygon.map((ring) => ring.map(([x, y]) => tm2ToWgs84(x, y))),
  );
  return {
    status: "ok",
    sidewalk: { keyid, coordinates, widthM: stripWidthM(area, perimeter) },
  };
}
