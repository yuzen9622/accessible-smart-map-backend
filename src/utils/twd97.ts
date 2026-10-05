import proj4 from "proj4";

const EPSG_3826 =
  "+proj=tmerc +lat_0=0 +lon_0=121 +k=0.9999 +x_0=250000 +y_0=0 " +
  "+ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs";

/**
 * Convert TWD97 / TM2 (EPSG:3826) coordinates to WGS84.
 *
 * @param x TM2 easting in metres.
 * @param y TM2 northing in metres.
 * @returns `[lng, lat]` in degrees.
 */
export function twd97ToWgs84(x: number, y: number): [number, number] {
  const [lng, lat] = proj4(EPSG_3826, "WGS84", [x, y]);
  return [lng, lat];
}

/**
 * Points along TM2 polylines at most `spacingM` apart (vertices included),
 * converted to WGS84 and capped. Interpolation runs in the projected plane,
 * where metres are exact.
 *
 * @param lines TM2 polylines as `[x, y]` vertex lists.
 * @param spacingM Maximum spacing between consecutive samples.
 * @param maxPoints Upper bound on the number of samples returned.
 * @returns `{ lat, lng }` samples, rounded to 6 decimals.
 */
export function sampleTwd97Lines(
  lines: readonly (readonly [number, number])[][],
  spacingM: number,
  maxPoints: number,
): { lat: number; lng: number }[] {
  const projected: [number, number][] = [];
  for (const line of lines) {
    for (let i = 0; i < line.length; i++) {
      const [x, y] = line[i];
      if (i > 0) {
        const [px, py] = line[i - 1];
        const steps = Math.floor(Math.hypot(x - px, y - py) / spacingM);
        for (let s = 1; s <= steps; s++) {
          const t = s / (steps + 1);
          projected.push([px + (x - px) * t, py + (y - py) * t]);
        }
      }
      projected.push([x, y]);
    }
  }
  const stride = Math.max(1, Math.ceil(projected.length / maxPoints));
  const seen = new Set<string>();
  const out: { lat: number; lng: number }[] = [];
  for (let i = 0; i < projected.length; i += stride) {
    const [lng, lat] = twd97ToWgs84(projected[i][0], projected[i][1]);
    const point = {
      lat: Math.round(lat * 1e6) / 1e6,
      lng: Math.round(lng * 1e6) / 1e6,
    };
    const key = `${point.lat},${point.lng}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(point);
  }
  return out;
}
