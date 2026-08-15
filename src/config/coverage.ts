export type ServiceCoverageBbox = readonly [
  minLng: number,
  minLat: number,
  maxLng: number,
  maxLat: number,
];

export interface ServiceCoveragePoint {
  lat: number;
  lng: number;
}

export interface ServiceCoverageConfig {
  bbox: ServiceCoverageBbox;
  maxRouteDistanceKm: number;
}

export const DEFAULT_SERVICE_COVERAGE_BBOX: ServiceCoverageBbox = [
  117.9, 21.85, 122.6, 26.55,
];

/**
 * Default single-route straight-line distance limit (km). Rated to cover the
 * whole default Taiwan bbox (max corner-to-corner diagonal ≈ 700 km) so
 * intercity trips (e.g. THSR Taipei→Kaohsiung) keep working like the original
 * system, which had no distance cap. Real feasibility is decided by the
 * routing engines; this guard only rejects clearly absurd input.
 */
export const MAX_ROUTE_DISTANCE_KM = 750;

function cloneBbox(bbox: ServiceCoverageBbox): ServiceCoverageBbox {
  return [bbox[0], bbox[1], bbox[2], bbox[3]];
}

function invalidCoverageBbox(message: string): never {
  throw new Error(`Invalid SERVICE_COVERAGE_BBOX: ${message}`);
}

function parseServiceCoverageBbox(value: string): ServiceCoverageBbox {
  const parts = value.split(",").map((part) => part.trim());
  if (parts.length !== 4 || parts.some((part) => part.length === 0)) {
    return invalidCoverageBbox(
      "expected minLng,minLat,maxLng,maxLat with four numeric values",
    );
  }

  const values = parts.map(Number);
  if (values.some((value) => !Number.isFinite(value))) {
    return invalidCoverageBbox(
      "expected minLng,minLat,maxLng,maxLat with finite numeric values",
    );
  }

  const [minLng, minLat, maxLng, maxLat] = values;
  if (
    minLng < -180 ||
    maxLng > 180 ||
    minLat < -90 ||
    maxLat > 90 ||
    minLng >= maxLng ||
    minLat >= maxLat
  ) {
    return invalidCoverageBbox(
      "bounds must be ordered and remain within valid longitude/latitude ranges",
    );
  }

  return [minLng, minLat, maxLng, maxLat];
}

function parseMaxRouteDistanceKm(value: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(
      `Invalid SERVICE_MAX_ROUTE_DISTANCE_KM: expected a positive number of kilometers, got "${value}"`,
    );
  }
  return parsed;
}

/**
 * Resolves the current service-coverage settings. The optional bbox and max
 * route distance overrides are read on every call so deployment configuration
 * errors fail immediately rather than silently widening coverage.
 */
export function getServiceCoverageConfig(): ServiceCoverageConfig {
  const configuredBbox = process.env.SERVICE_COVERAGE_BBOX;
  const bbox =
    configuredBbox == null || configuredBbox.trim() === ""
      ? cloneBbox(DEFAULT_SERVICE_COVERAGE_BBOX)
      : parseServiceCoverageBbox(configuredBbox);

  const configuredMaxDistance = process.env.SERVICE_MAX_ROUTE_DISTANCE_KM;
  const maxRouteDistanceKm =
    configuredMaxDistance == null || configuredMaxDistance.trim() === ""
      ? MAX_ROUTE_DISTANCE_KM
      : parseMaxRouteDistanceKm(configuredMaxDistance);

  return {
    bbox,
    maxRouteDistanceKm,
  };
}

/**
 * Checks whether a latitude/longitude point is within a configured coverage
 * bbox. Both minimum and maximum boundaries are included.
 */
export function isWithinServiceCoverage(
  point: ServiceCoveragePoint,
  bbox: ServiceCoverageBbox = getServiceCoverageConfig().bbox,
): boolean {
  const [minLng, minLat, maxLng, maxLat] = bbox;
  return (
    point.lng >= minLng &&
    point.lng <= maxLng &&
    point.lat >= minLat &&
    point.lat <= maxLat
  );
}
