import proj4 from "proj4";
import { IDisabledParking } from "../types";
import { parseCsvLine } from "../utils/csv";

export { parseCsvLine };

/**
 * TWD97 / TM2 (EPSG:3826) — the projected CRS the New Taipei parking open-data
 * ships its X/Y in. Central meridian 121°E, scale 0.9999, false easting 250km.
 */
const EPSG_3826 =
  "+proj=tmerc +lat_0=0 +lon_0=121 +k=0.9999 +x_0=250000 +y_0=0 " +
  "+ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs";

const TW_BOUNDS = { lngMin: 119, lngMax: 122.5, latMin: 21.5, latMax: 26.5 };

/**
 * Reproject a TWD97/TM2 easting/northing to WGS84.
 * @param x TM2 easting (the column the CSV mislabels "longitude").
 * @param y TM2 northing (the column the CSV mislabels "latitude").
 * @returns `[lng, lat]` in WGS84 degrees.
 */
export function tm2ToWgs84(x: number, y: number): [number, number] {
  const [lng, lat] = proj4(EPSG_3826, "WGS84", [x, y]);
  return [lng, lat];
}

/**
 * Map one parsed CSV row to a DisabledParking document. Columns are read by
 * POSITION because the source header names are shifted one column off the data.
 * Coordinates are reprojected from TM2 to WGS84 and bounds-checked to Taiwan.
 * @param cols Fields from {@link parseCsvLine} (expects ≥9 columns).
 * @param city City label stored on every row from this feed.
 * @returns The document, or `null` if the row is malformed / out of bounds.
 */
export function rowToParking(
  cols: string[],
  city: string,
): Omit<IDisabledParking, "_id"> | null {
  if (cols.length < 9) return null;

  const district = cols[0]?.trim();
  const placeName = cols[3]?.trim();
  const x = Number(cols[7]);
  const y = Number(cols[8]);
  if (!district || !placeName) return null;
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;

  const [lng, lat] = tm2ToWgs84(x, y);
  if (
    lng < TW_BOUNDS.lngMin ||
    lng > TW_BOUNDS.lngMax ||
    lat < TW_BOUNDS.latMin ||
    lat > TW_BOUNDS.latMax
  ) {
    return null;
  }

  return {
    city,
    district,
    areacode: cols[1]?.trim(),
    quantity: Number(cols[2]) || 1,
    placeName,
    chargeType: cols[4]?.trim(),
    spaceLabel: cols[5]?.trim(),
    isMarked: cols[6]?.trim() === "是",
    latitude: lat,
    longitude: lng,
    location: { type: "Point", coordinates: [lng, lat] },
    importedAt: new Date(),
  };
}
