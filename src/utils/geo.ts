const EARTH_RADIUS_M = 6_371_000;

/**
 * Great-circle distance between two WGS84 coordinates using the Haversine
 * formula.
 *
 * @param lat1 Latitude of the first point (degrees).
 * @param lng1 Longitude of the first point (degrees).
 * @param lat2 Latitude of the second point (degrees).
 * @param lng2 Longitude of the second point (degrees).
 * @returns Distance in metres.
 */
export function haversineMeters(
  lat1: number,
  lng1: number,
  lat2: number,
  lng2: number,
): number {
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return EARTH_RADIUS_M * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

export function haversineCoords(
  a: [number, number],
  b: [number, number],
): number {
  return haversineMeters(a[1], a[0], b[1], b[0]);
}
