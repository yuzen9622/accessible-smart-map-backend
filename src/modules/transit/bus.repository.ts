import BusRouteModel from "../../model/bus-route.model";
import BusVehicleModel from "../../model/bus-vehicle.model";
import BusStopModel from "../../model/bus-stop.model";
import type { BusFleetObservation, ITdxBusVehicle } from "../../types";
import { buildFuzzyKeywordRegex } from "../../utils/transit-text";

/** A stored bus route with the stop list the info endpoint reads. */
export interface BusRouteDoc {
  routeUid?: string;
  subRouteUid: string;
  direction: number;
  operators?: { name?: string }[];
  stops?: {
    seq: number;
    stopName?: { Zh_tw?: string; En?: string };
    lat: number;
    lng: number;
    stopUID?: string;
  }[];
  routeName?: { Zh_tw?: string; En?: string };
  subRouteName?: { Zh_tw?: string; En?: string };
  city?: string;
}

/** One grouped row from the route keyword search. */
export interface BusRouteSearchRow {
  routeNameEn?: string;
  _id: { routeName: string; city: string };
  subRoutes: {
    direction: number;
    stops?: {
      seq: number;
      stopName?: { Zh_tw?: string; En?: string };
      lat?: number;
      lng?: number;
    }[];
  }[];
}

/** A stored bus stop as the search / nearby paths read it. */
export interface BusStopDoc {
  stopUid: string;
  stopName: { Zh_tw: string; En?: string };
  city: string;
  location: { type: "Point"; coordinates: [number, number] };
  subRouteIds?: string[];
  /** Populated only by the `$geoNear` path, in metres. */
  distance: number;
}

/** The sub-route to route name mapping rows. */
export interface SubRouteNameRow {
  subRouteName?: { Zh_tw?: string; En?: string };
  routeName?: { Zh_tw?: string; En?: string };
}

/**
 * Vehicle records for a set of plate numbers, for the low-floor join.
 *
 * @param plateNumbers Plate numbers to look up
 * @returns The matching vehicle records
 */
export async function findVehiclesByPlate(
  plateNumbers: string[],
): Promise<ITdxBusVehicle[]> {
  return BusVehicleModel.find({
    plateNumb: { $in: plateNumbers },
  }).lean<ITdxBusVehicle[]>();
}

/**
 * Upsert plate-level low-floor observations from a city's own bus system.
 * `hasLiftOrRamp` is cleared so a stale TDX value cannot contradict the city
 * source; its absence means the same as `isLowFloor`.
 *
 * @param observations Per-plate observations from one source
 * @returns The number of vehicle records inserted or changed
 */
export async function upsertVehicleObservations(
  observations: BusFleetObservation[],
): Promise<number> {
  if (!observations.length) return 0;
  const now = new Date();
  const result = await BusVehicleModel.bulkWrite(
    observations.map((obs) => ({
      updateOne: {
        filter: { plateNumb: obs.plateNumb },
        update: {
          $set: {
            plateNumb: obs.plateNumb,
            city: obs.city,
            isLowFloor: obs.isLowFloor,
            source: obs.source,
            importedAt: now,
          },
          $unset: { hasLiftOrRamp: "" },
        },
        upsert: true,
      },
    })),
    { ordered: false },
  );
  return result.upsertedCount + result.modifiedCount;
}

/**
 * Routes matching any of the given Chinese names, scoped to a city unless the
 * scope is inter-city.
 *
 * @param city Operating city, or "InterCity" for the unscoped lookup
 * @param routeNames Candidate route names
 * @returns The matching route documents
 */
export async function findRoutesByName(
  city: string,
  routeNames: string[],
): Promise<BusRouteDoc[]> {
  const query =
    city === "InterCity"
      ? { "routeName.Zh_tw": { $in: routeNames } }
      : { city, "routeName.Zh_tw": { $in: routeNames } };
  return BusRouteModel.find(query).lean<BusRouteDoc[]>();
}

/**
 * Routes whose Chinese name fuzzily matches a keyword, grouped by (name, city).
 *
 * @param keyword Free-text search term
 * @param limit Maximum grouped rows
 * @returns Grouped route rows
 */
export async function searchRoutesByKeyword(
  keyword: string,
  limit: number,
  bilingual = false,
): Promise<BusRouteSearchRow[]> {
  return BusRouteModel.aggregate([
    {
      $match: {
        ...nameKeyword("routeName", buildFuzzyKeywordRegex(keyword), bilingual),
      },
    },
    {
      $group: {
        _id: { routeName: "$routeName.Zh_tw", city: "$city" },
        routeNameEn: { $first: "$routeName.En" },
        subRoutes: { $push: { direction: "$direction", stops: "$stops" } },
      },
    },
    { $limit: limit },
  ]);
}

/**
 * Stops whose Chinese name fuzzily matches a keyword.
 * When `userLoc` is provided, utilizes MongoDB `$geoNear` to return the nearest
 * stops matching the keyword first, avoiding premature truncation across regions.
 *
 * @param keyword Free-text search term
 * @param limit Maximum rows
 * @param userLoc Optional reference location for spatial ordering
 * @returns Matching stops
 */
export async function searchStopsByKeyword(
  keyword: string,
  limit: number,
  userLoc?: { lat: number; lng: number } | null,
  bilingual = false,
): Promise<BusStopDoc[]> {
  const fuzzyRegex = buildFuzzyKeywordRegex(keyword);

  if (userLoc) {
    return BusStopModel.aggregate([
      {
        $geoNear: {
          near: { type: "Point", coordinates: [userLoc.lng, userLoc.lat] },
          distanceField: "distance",
          spherical: true,
          query: {
            ...nameKeyword("stopName", fuzzyRegex, bilingual),
          },
        },
      },
      { $limit: limit },
    ]);
  }

  return BusStopModel.aggregate([
    {
      $match: {
        ...nameKeyword("stopName", fuzzyRegex, bilingual),
      },
    },
    { $limit: limit },
  ]);
}

/**
 * Stops within a radius of a point, nearest first, carrying their distance.
 *
 * @param lat Latitude of the search centre
 * @param lng Longitude of the search centre
 * @param radiusM Search radius in metres
 * @param limit Maximum rows
 * @returns Matching stops with a `distance` field
 */
export async function findStopsNearby(
  lat: number,
  lng: number,
  radiusM: number,
  limit: number,
): Promise<BusStopDoc[]> {
  return BusStopModel.aggregate([
    {
      $geoNear: {
        near: { type: "Point", coordinates: [lng, lat] },
        distanceField: "distance",
        maxDistance: radiusM,
        spherical: true,
      },
    },
    { $limit: limit },
  ]);
}

/**
 * Maps sub-route names back to their parent route names.
 *
 * @param subRouteNames Sub-route Chinese names collected off stops
 * @returns Rows pairing sub-route name with route name
 */
export async function findRouteNamesBySubRoute(
  subRouteNames: string[],
): Promise<SubRouteNameRow[]> {
  return BusRouteModel.find({
    "subRouteName.Zh_tw": { $in: subRouteNames },
  })
    .select("subRouteName routeName")
    .lean<SubRouteNameRow[]>();
}

/**
 * Stops of one city within a radius of a point, nearest first. Unlike
 * {@link findStopsNearby} the city filter runs inside `$geoNear`, so stops of
 * another city that happen to sit inside the radius never consume the limit.
 *
 * @param city TDX city code the stops must belong to (e.g. "Taipei")
 * @param lat Latitude of the search centre
 * @param lng Longitude of the search centre
 * @param radiusM Search radius in metres
 * @param limit Maximum rows
 * @returns Matching stops with a `distance` field
 */
export async function findCityStopsNearby(
  city: string,
  lat: number,
  lng: number,
  radiusM: number,
  limit: number,
): Promise<BusStopDoc[]> {
  return BusStopModel.aggregate([
    {
      $geoNear: {
        near: { type: "Point", coordinates: [lng, lat] },
        distanceField: "distance",
        maxDistance: radiusM,
        spherical: true,
        query: { city },
      },
    },
    { $limit: limit },
  ]);
}

/**
 * Stored routes (both directions) for a set of sub-route UIDs, carrying only
 * what a headsign lookup needs. One batched query for any number of UIDs.
 *
 * @param subRouteUids TDX SubRouteUIDs
 * @returns The matching route documents
 */
export async function findRoutesBySubRouteUids(
  subRouteUids: string[],
): Promise<BusRouteDoc[]> {
  if (!subRouteUids.length) return [];
  return BusRouteModel.find({ subRouteUid: { $in: subRouteUids } })
    .select("subRouteUid direction stops.seq stops.stopName")
    .lean<BusRouteDoc[]>();
}

function nameKeyword(field: string, regex: string, bilingual: boolean) {
  const chinese = { [`${field}.Zh_tw`]: { $regex: regex, $options: "i" } };
  return bilingual
    ? { $or: [chinese, { [`${field}.En`]: { $regex: regex, $options: "i" } }] }
    : chinese;
}
