import type { BusFleetObservation } from "../types";

/**
 * Add one observation to a per-plate map, keeping the latest flag and the
 * union of the city route ids the plate was seen on.
 *
 * @param byPlate Observations keyed by plate, updated in place.
 * @param obs The observation to merge.
 */
export function mergeFleetObservation(
  byPlate: Map<string, BusFleetObservation>,
  obs: BusFleetObservation,
): void {
  const routes = new Set([
    ...(byPlate.get(obs.plateNumb)?.cityRouteIds ?? []),
    ...(obs.cityRouteIds ?? []),
  ]);
  byPlate.set(
    obs.plateNumb,
    routes.size ? { ...obs, cityRouteIds: [...routes] } : obs,
  );
}
