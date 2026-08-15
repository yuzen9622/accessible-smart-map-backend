import BusRouteModel from "../../model/bus-route.model";

/** The bus-route fields alert matching keys off. */
export interface BusRouteLookupRow {
  routeId?: string;
  direction?: number;
  subRouteName?: { Zh_tw?: string };
}

/**
 * Finds a city's bus routes matching any of the given Chinese route names.
 *
 * @param city Operating city
 * @param routeNames Candidate route names to match against `routeName.Zh_tw`
 * @returns Matching route rows
 */
export async function findBusRoutesByName(
  city: string,
  routeNames: string[],
): Promise<BusRouteLookupRow[]> {
  return BusRouteModel.find({
    city,
    "routeName.Zh_tw": { $in: routeNames },
  }).lean<BusRouteLookupRow[]>();
}
