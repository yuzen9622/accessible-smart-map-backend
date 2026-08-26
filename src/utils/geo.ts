const EARTH_RADIUS_M = 6_371_000;

export interface Coordinates {
  lat: number;
  lng: number;
}

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

/**
 * Parses diverse location representations (string, object, array) into a
 * normalized { lat, lng } object.
 *
 * Handles:
 * - "lat,lng" or "lat, lng" (e.g. "25.0478,121.5171")
 * - "lng,lat" if lng > 90 and lat <= 90 (e.g. "121.5171,25.0478")
 * - JSON string e.g. '{"lat":25.0478,"lng":121.5171}'
 * - Object { lat, lng } or { latitude, longitude }
 * - Array [lng, lat] (GeoJSON) or [lat, lng]
 *
 * @param input Raw location input
 * @returns { lat, lng } or undefined if invalid/missing
 */
export function parseLocation(input: unknown): Coordinates | undefined {
  if (input === null || input === undefined || input === "") {
    return undefined;
  }

  // Object case
  if (typeof input === "object") {
    if (Array.isArray(input)) {
      if (input.length >= 2) {
        const n1 = Number(input[0]);
        const n2 = Number(input[1]);
        if (!Number.isNaN(n1) && !Number.isNaN(n2)) {
          return normalizeLatLng(n1, n2);
        }
      }
      return undefined;
    }

    const obj = input as Record<string, unknown>;
    const rawLat = obj.lat ?? obj.latitude;
    const rawLng = obj.lng ?? obj.longitude ?? obj.lon;
    if (rawLat !== undefined && rawLng !== undefined) {
      const lat = Number(rawLat);
      const lng = Number(rawLng);
      if (!Number.isNaN(lat) && !Number.isNaN(lng)) {
        return normalizeLatLng(lat, lng);
      }
    }
    return undefined;
  }

  // String case
  if (typeof input === "string") {
    const trimmed = input.trim();
    if (!trimmed) return undefined;

    // JSON check
    if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
      try {
        const parsed = JSON.parse(trimmed);
        return parseLocation(parsed);
      } catch {
        // Fall through to regex/comma split
      }
    }

    // Comma or whitespace separated numbers
    const parts = trimmed.split(/[,;\s]+/).map((p) => Number(p));
    if (parts.length >= 2) {
      const [n1, n2] = parts;
      if (!Number.isNaN(n1) && !Number.isNaN(n2)) {
        return normalizeLatLng(n1, n2);
      }
    }
  }

  return undefined;
}

function normalizeLatLng(val1: number, val2: number): Coordinates | undefined {
  if (Math.abs(val1) > 90 && Math.abs(val2) <= 90) {
    if (val1 >= -180 && val1 <= 180 && val2 >= -90 && val2 <= 90) {
      return { lat: val2, lng: val1 };
    }
  } else if (Math.abs(val2) > 90 && Math.abs(val1) <= 90) {
    if (val2 >= -180 && val2 <= 180 && val1 >= -90 && val1 <= 90) {
      return { lat: val1, lng: val2 };
    }
  } else {
    if (val1 >= -90 && val1 <= 90 && val2 >= -180 && val2 <= 180) {
      return { lat: val1, lng: val2 };
    }
  }
  return undefined;
}
