import { z } from "zod";

const facilityLocationSchema = z.object({
  type: z.literal("Point"),
  coordinates: z.tuple([
    z.number().finite().min(-180).max(180),
    z.number().finite().min(-90).max(90),
  ]),
});

export type CampusFacilityLocation = z.infer<typeof facilityLocationSchema>;

/** Accepts usable GeoJSON only, including when reading legacy empty arrays. */
export function parseFacilityLocation(
  value: unknown,
): CampusFacilityLocation | undefined {
  const result = facilityLocationSchema.safeParse(value);
  return result.success ? result.data : undefined;
}

/** Converts MOE's EPSG:3857 metres to WGS84, in degrees. */
export function mercatorToWgs84(
  x: number,
  y: number,
): { lat: number; lng: number } {
  const radius = 6378137;
  const lng = (x / radius) * (180 / Math.PI);
  const lat =
    (2 * Math.atan(Math.exp(y / radius)) - Math.PI / 2) * (180 / Math.PI);
  return { lat: +lat.toFixed(7), lng: +lng.toFixed(7) };
}

/** Reads a facility POINT; never substitutes campus or building geometry. */
export function parseGeoPoint(s: string): { lat: number; lng: number } | null {
  const match = /^POINT\s*\(\s*([^\s()]+)\s+([^\s()]+)\s*\)$/i.exec(s.trim());
  if (!match) return null;
  const x = Number(match[1]);
  const y = Number(match[2]);
  const extent = Math.PI * 6378137;
  if (
    !Number.isFinite(x) ||
    !Number.isFinite(y) ||
    Math.abs(x) > extent ||
    Math.abs(y) > extent
  )
    return null;
  return mercatorToWgs84(x, y);
}
