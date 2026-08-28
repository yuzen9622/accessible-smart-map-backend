import proj4 from "proj4";

/**
 * TWD97 / TM2 (EPSG:3826) — the projected CRS Taipei's curb ramp point
 * dataset ships `geometry.coordinates` and `X_3826`/`Y_3826` in. Central
 * meridian 121°E, scale 0.9999, false easting 250km.
 */
export const EPSG_3826 =
  "+proj=tmerc +lat_0=0 +lon_0=121 +k=0.9999 +x_0=250000 +y_0=0 " +
  "+ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs";

/** The only `Name` value this import accepts. */
export const ACCESSIBLE_RAMP_NAME = "無障礙斜坡道";

/**
 * Car driveway ramps crossing the sidewalk — the dataset's other `Name`
 * value. These are often an obstacle for wheelchair users, not a facility,
 * and must never be imported alongside `ACCESSIBLE_RAMP_NAME`.
 */
export const CAR_RAMP_NAME = "汽車斜坡道";

/** Above this TM2 planar separation, `geometry.coordinates` and `X_3826`/`Y_3826` disagree too much to trust either. */
const MAX_COORDINATE_MISMATCH_M = 0.01;

export interface RampFeature {
  properties?: {
    OBJECTID?: unknown;
    Name?: unknown;
    Town_N?: unknown;
    X_3826?: unknown;
    Y_3826?: unknown;
  } | null;
  geometry?: {
    type?: unknown;
    coordinates?: unknown;
  } | null;
}

export interface ParsedRampPoint {
  objectid: number;
  lng: number;
  lat: number;
  town: string | null;
}

export type RampFeatureResult =
  | { status: "ok"; point: ParsedRampPoint }
  | { status: "not_accessible_ramp" }
  | { status: "coordinate_mismatch" }
  | { status: "malformed" };

/**
 * @param x TM2 easting.
 * @param y TM2 northing.
 * @returns `[lng, lat]` in WGS84 degrees.
 */
export function tm2ToWgs84(x: number, y: number): [number, number] {
  const [lng, lat] = proj4(EPSG_3826, "WGS84", [x, y]);
  return [lng, lat];
}

/**
 * Parse and validate one raw GeoJSON ramp feature.
 *
 * Only `無障礙斜坡道` (accessibility ramp) rows are accepted — `汽車斜坡道`
 * (car driveway ramps crossing the sidewalk) and any other `Name` value are
 * rejected here. This is the load-bearing filter for the whole import: a car
 * ramp is often an obstacle for wheelchair users, not a facility, so it must
 * never reach `ped_ramp_point`.
 *
 * `geometry.coordinates` and the `X_3826`/`Y_3826` properties are two
 * independently-recorded copies of the same TM2 point; a feature is dropped
 * rather than guessed at when they disagree by more than 1 centimetre.
 *
 * @param feature One raw GeoJSON Feature from the source FeatureCollection.
 * @returns The parsed point, or the reason it was rejected.
 */
export function parseRampFeature(feature: RampFeature): RampFeatureResult {
  const properties = feature.properties;
  if (properties === null || properties === undefined) {
    return { status: "malformed" };
  }
  if (properties.Name !== ACCESSIBLE_RAMP_NAME) {
    return { status: "not_accessible_ramp" };
  }

  const objectid = Number(properties.OBJECTID);
  const geometry = feature.geometry;
  if (
    !Number.isFinite(objectid) ||
    geometry === null ||
    geometry === undefined ||
    geometry.type !== "Point" ||
    !Array.isArray(geometry.coordinates) ||
    geometry.coordinates.length !== 2
  ) {
    return { status: "malformed" };
  }

  const [geomX, geomY] = geometry.coordinates as [unknown, unknown];
  const geomXNum = Number(geomX);
  const geomYNum = Number(geomY);
  const fieldXNum = Number(properties.X_3826);
  const fieldYNum = Number(properties.Y_3826);
  if (
    !Number.isFinite(geomXNum) ||
    !Number.isFinite(geomYNum) ||
    !Number.isFinite(fieldXNum) ||
    !Number.isFinite(fieldYNum)
  ) {
    return { status: "malformed" };
  }

  const mismatchM = Math.hypot(geomXNum - fieldXNum, geomYNum - fieldYNum);
  if (mismatchM > MAX_COORDINATE_MISMATCH_M) {
    return { status: "coordinate_mismatch" };
  }

  const [lng, lat] = tm2ToWgs84(geomXNum, geomYNum);
  const town = typeof properties.Town_N === "string" ? properties.Town_N : null;
  return { status: "ok", point: { objectid, lng, lat, town } };
}
