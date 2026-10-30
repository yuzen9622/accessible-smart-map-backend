import {
  PLACE_EXTENT_MAX_SPAN_M,
  PLACE_EXTENT_PADDING_M,
} from "../config/place-extent";

/** A GeoJSON bounding box in [minLng, minLat, maxLng, maxLat] order. */
export type PlaceBounds = [number, number, number, number];

const EARTH_RADIUS_M = 6_371_000;

function metresToLatitudeDegrees(metres: number): number {
  return (metres / EARTH_RADIUS_M) * (180 / Math.PI);
}

function metresToLongitudeDegrees(metres: number, latitude: number): number {
  const cosLatitude = Math.cos((latitude * Math.PI) / 180);
  return (metres / (EARTH_RADIUS_M * cosLatitude)) * (180 / Math.PI);
}

/**
 * Expands a place viewport by the configured padding and caps each axis at the
 * configured maximum span around the viewport's own centre.
 *
 * The centre is calculated before capping so a large viewport is reduced
 * symmetrically around the place, rather than around the coordinate origin.
 */
export function preparePlaceBounds(bounds: PlaceBounds): PlaceBounds {
  const [minLng, minLat, maxLng, maxLat] = bounds;
  const centerLng = (minLng + maxLng) / 2;
  const centerLat = (minLat + maxLat) / 2;
  const paddingLat = metresToLatitudeDegrees(PLACE_EXTENT_PADDING_M);
  const paddingLng = metresToLongitudeDegrees(
    PLACE_EXTENT_PADDING_M,
    centerLat,
  );

  const paddedMinLng = minLng - paddingLng;
  const paddedMaxLng = maxLng + paddingLng;
  const paddedMinLat = minLat - paddingLat;
  const paddedMaxLat = maxLat + paddingLat;
  const maxLatSpan = metresToLatitudeDegrees(PLACE_EXTENT_MAX_SPAN_M);
  const maxLngSpan = metresToLongitudeDegrees(
    PLACE_EXTENT_MAX_SPAN_M,
    centerLat,
  );

  const lngHalfSpan = Math.min(
    (paddedMaxLng - paddedMinLng) / 2,
    maxLngSpan / 2,
  );
  const latHalfSpan = Math.min(
    (paddedMaxLat - paddedMinLat) / 2,
    maxLatSpan / 2,
  );

  return [
    Math.max(-180, centerLng - lngHalfSpan),
    Math.max(-90, centerLat - latHalfSpan),
    Math.min(180, centerLng + lngHalfSpan),
    Math.min(90, centerLat + latHalfSpan),
  ];
}

/** Converts a bounding box into a closed GeoJSON Polygon ring. */
export function bboxPolygon(bounds: PlaceBounds): {
  type: "Polygon";
  coordinates: [
    [
      [number, number],
      [number, number],
      [number, number],
      [number, number],
      [number, number],
    ],
  ];
} {
  const [minLng, minLat, maxLng, maxLat] = bounds;
  return {
    type: "Polygon",
    coordinates: [
      [
        [minLng, minLat],
        [maxLng, minLat],
        [maxLng, maxLat],
        [minLng, maxLat],
        [minLng, minLat],
      ],
    ],
  };
}
