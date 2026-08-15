import A11y from "../../model/a11y.model";
import BathroomModel from "../../model/bathroom.model";
import OsmA11y from "../../model/osm-a11y.model";
import DisabledParkingModel from "../../model/disabled-parking.model";
import type { PlaceType } from "../../model/review.model";
import type { IA11y, IBathroom, IOsmA11y } from "../../types";

export type { PlaceType };

function makeGeoQuery(lng: number, lat: number, radiusM: number) {
  return {
    $near: {
      $geometry: { type: "Point", coordinates: [lng, lat] },
      $maxDistance: radiusM,
    },
  };
}

/**
 * Counts local accessibility facilities within a radius, per source.
 *
 * Each source fails soft so one unavailable collection cannot blank the whole
 * count.
 *
 * @param lat Latitude of the search centre
 * @param lng Longitude of the search centre
 * @param radiusM Search radius in metres
 * @returns The per-source row counts
 */
export async function countFacilitiesNearby(
  lat: number,
  lng: number,
  radiusM: number,
): Promise<{
  metro: number;
  osm: number;
  bathroom: number;
  parking: number;
}> {
  const geoQuery = makeGeoQuery(lng, lat, radiusM);
  const [metro, osm, bathroom, parking] = await Promise.all([
    A11y.find({ location: geoQuery })
      .lean()
      .catch(() => []),
    OsmA11y.find({ location: geoQuery })
      .lean()
      .catch(() => []),
    BathroomModel.find({ type: "無障礙廁所", location: geoQuery })
      .lean()
      .catch(() => []),
    DisabledParkingModel.find({ location: geoQuery })
      .lean()
      .catch(() => []),
  ]);
  return {
    metro: metro.length,
    osm: osm.length,
    bathroom: bathroom.length,
    parking: parking.length,
  };
}

/**
 * Nearby accessible toilets and metro accessibility exits, capped per source.
 *
 * Each source fails soft, matching the count path.
 *
 * @param lat Latitude of the search centre
 * @param lng Longitude of the search centre
 * @param radiusM Search radius in metres
 * @param limit Per-source cap
 * @returns The three raw result sets
 */
export async function findNearbyFacilityRows(
  lat: number,
  lng: number,
  radiusM: number,
  limit: number,
): Promise<{
  bathrooms: IBathroom[];
  osmToilets: IOsmA11y[];
  metro: IA11y[];
}> {
  const geoQuery = makeGeoQuery(lng, lat, radiusM);
  const [bathrooms, osmToilets, metro] = await Promise.all([
    BathroomModel.find({ type: "無障礙廁所", location: geoQuery })
      .limit(limit)
      .lean()
      .catch(() => []),
    OsmA11y.find({ category: "toilet", location: geoQuery })
      .limit(limit)
      .lean()
      .catch(() => []),
    A11y.find({ location: geoQuery })
      .limit(limit)
      .lean()
      .catch(() => []),
  ]);
  return {
    bathrooms: bathrooms as unknown as IBathroom[],
    osmToilets: osmToilets as unknown as IOsmA11y[],
    metro: metro as unknown as IA11y[],
  };
}
