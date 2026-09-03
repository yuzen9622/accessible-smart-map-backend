/**
 * Minimal WKT reader for the geometries TDX Road/Traffic actually emits:
 * `LINESTRING` for section shapes and `POINT` for road events. Parsing is done
 * here instead of via a dependency because those two forms (plus
 * `MULTILINESTRING`, which TDX may use for split sections) are the entire
 * surface we need.
 *
 * Malformed input yields `null` rather than an exception so bulk importers can
 * count failures and keep going.
 */

export interface GeoJsonPoint {
  type: "Point";
  coordinates: [number, number];
}

export interface GeoJsonLineString {
  type: "LineString";
  coordinates: [number, number][];
}

export interface GeoJsonMultiLineString {
  type: "MultiLineString";
  coordinates: [number, number][][];
}

export type WktGeometry =
  GeoJsonPoint | GeoJsonLineString | GeoJsonMultiLineString;

const MAX_LONGITUDE = 180;
const MAX_LATITUDE = 90;

/** Splits `TAG (body)` while tolerating case, padding and dimension suffixes. */
const WKT_PATTERN = /^([a-z]+)\s*(?:z|m|zm)?\s*\(([\s\S]*)\)$/i;

/** A `MULTILINESTRING` body: parenthesised members separated by commas only. */
const MULTI_MEMBERS_PATTERN = /^\([^()]*\)(?:\s*,\s*\([^()]*\))*$/;

/**
 * @param token One whitespace-separated coordinate pair, e.g. `121.5 25.04`.
 * @returns The pair as GeoJSON `[lng, lat]`, or `null` when unusable.
 */
function parseCoordinate(token: string): [number, number] | null {
  const parts = token.trim().split(/\s+/);
  if (parts.length !== 2) return null;
  const lng = Number(parts[0]);
  const lat = Number(parts[1]);
  if (!Number.isFinite(lng) || !Number.isFinite(lat)) return null;
  // A 2dsphere index rejects out-of-range coordinates at insert time, so they
  // are treated as a parse failure rather than pushed downstream.
  if (Math.abs(lng) > MAX_LONGITUDE || Math.abs(lat) > MAX_LATITUDE)
    return null;
  return [lng, lat];
}

/**
 * @param body Comma-separated coordinate list, without the wrapping parens.
 * @returns The coordinates in input order, or `null` when any pair is unusable.
 */
function parseCoordinateList(body: string): [number, number][] | null {
  const tokens = body.split(",");
  const coordinates: [number, number][] = [];
  for (const token of tokens) {
    const coordinate = parseCoordinate(token);
    if (!coordinate) return null;
    coordinates.push(coordinate);
  }
  return coordinates;
}

/**
 * Parses a WKT `POINT`, `LINESTRING` or `MULTILINESTRING` into GeoJSON.
 *
 * @param wkt Raw WKT text, e.g. `LINESTRING(121.57 25.06,121.58 25.06)`.
 * @returns The GeoJSON geometry, or `null` when the input is absent, is not one
 *   of the supported forms, or holds an unusable coordinate.
 */
export function wktToGeoJson(
  wkt: string | null | undefined,
): WktGeometry | null {
  if (!wkt) return null;
  let text = wkt.trim();

  // TDX 歷史資料庫瑕疵容錯：高公局 (Freeway) 與部分省道 (Highway) 的 SectionShape WKT
  // 在 500 字元處被截斷（缺失結尾括號與最後半截坐標）。
  // 若為截斷的 LINESTRING，自動截取至最後一個完整逗號並補齊右括號。
  if (/^LINESTRING\s*\(/i.test(text) && !text.endsWith(")")) {
    const lastComma = text.lastIndexOf(",");
    if (lastComma !== -1) {
      text = text.slice(0, lastComma) + ")";
    }
  }

  const match = WKT_PATTERN.exec(text);
  if (!match) return null;
  const tag = match[1].toUpperCase();
  const body = match[2].trim();
  if (body === "") return null;

  if (tag === "POINT") {
    const coordinate = parseCoordinate(body);
    return coordinate ? { type: "Point", coordinates: coordinate } : null;
  }

  if (tag === "LINESTRING") {
    const coordinates = parseCoordinateList(body);
    if (!coordinates || coordinates.length < 2) return null;
    return { type: "LineString", coordinates };
  }

  if (tag === "MULTILINESTRING") {
    if (!MULTI_MEMBERS_PATTERN.test(body)) return null;
    const lines: [number, number][][] = [];
    for (const group of body.match(/\([^()]*\)/g) ?? []) {
      const coordinates = parseCoordinateList(group.slice(1, -1));
      if (!coordinates || coordinates.length < 2) return null;
      lines.push(coordinates);
    }
    return { type: "MultiLineString", coordinates: lines };
  }

  return null;
}
