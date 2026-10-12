import BusStopModel from "../../model/bus-stop.model";
import BusRouteModel from "../../model/bus-route.model";
import MetroStationModel from "../../model/metro-station.model";
import TrainStationModel from "../../model/train-station.model";

export interface RouteNameKeys {
  busStops: string[];
  busRoutes: string[];
  metroStations: string[];
  trainStations: { railSystem: "TRA" | "THSR"; id: string }[];
}
export interface RouteNameSources {
  busStops: Map<string, string>;
  busRoutes: Map<string, string>;
  metroStations: Map<string, string>;
  trainStations: Map<string, string>;
}
export const trainNameKey = (system: string, id: string): string =>
  `${system}:${id}`;

/** Fixed four local batch boundaries, no text joins or external provider calls. */
export async function lookupRouteNameSources(
  keys: RouteNameKeys,
): Promise<RouteNameSources> {
  async function safe<T>(
    query: () => Promise<T[]>,
    needed: boolean,
  ): Promise<T[]> {
    if (!needed) return [];
    try {
      return await query();
    } catch {
      console.warn("[accessible-route] source name lookup unavailable");
      return [];
    }
  }
  const [stops, routes, metro, train] = await Promise.all([
    safe(
      () =>
        BusStopModel.find({ stopUid: { $in: keys.busStops } })
          .select("stopUid stopName")
          .lean()
          .exec(),
      keys.busStops.length > 0,
    ),
    safe(
      () =>
        BusRouteModel.find({ subRouteUid: { $in: keys.busRoutes } })
          .select("subRouteUid routeName")
          .lean()
          .exec(),
      keys.busRoutes.length > 0,
    ),
    safe(
      () =>
        MetroStationModel.find({ stationUid: { $in: keys.metroStations } })
          .select("stationUid stationName")
          .lean()
          .exec(),
      keys.metroStations.length > 0,
    ),
    safe(
      () =>
        TrainStationModel.find({
          $or: (["TRA", "THSR"] as const).map((railSystem) => {
            const ids = keys.trainStations
              .filter((key) => key.railSystem === railSystem)
              .map((key) => key.id);
            return {
              railSystem,
              $or: [{ stationUID: { $in: ids } }, { stationID: { $in: ids } }],
            };
          }),
        })
          .select("stationUID stationID railSystem stationName")
          .lean()
          .exec(),
      keys.trainStations.length > 0,
    ),
  ]);
  // Conflicting records for an ID are never guessed (e.g. bus directions).
  function collect(
    rows: { id: string; english?: unknown; identity?: string }[],
  ): Map<string, string> {
    const names = new Map<string, string>();
    const ambiguous = new Set<string>();
    const identities = new Map<string, string>();
    for (const row of rows) {
      const en = typeof row.english === "string" ? row.english.trim() : "";
      if (!en) continue;
      if (
        names.has(row.id) &&
        (names.get(row.id) !== en ||
          (row.identity !== undefined &&
            identities.get(row.id) !== row.identity))
      )
        ambiguous.add(row.id);
      if (row.identity !== undefined) identities.set(row.id, row.identity);
      names.set(row.id, en);
    }
    for (const id of ambiguous) names.delete(id);
    return names;
  }
  return {
    busStops: collect(
      stops.map((r) => ({ id: r.stopUid, english: r.stopName?.En })),
    ),
    busRoutes: collect(
      routes.map((r) => ({ id: r.subRouteUid, english: r.routeName?.En })),
    ),
    metroStations: collect(
      metro.map((r) => ({ id: r.stationUid, english: r.stationName?.En })),
    ),
    trainStations: collect(
      train.flatMap((r) =>
        [r.stationUID, r.stationID].map((id) => ({
          id: trainNameKey(r.railSystem, id),
          english: r.stationName?.En,
          identity: r.stationUID,
        })),
      ),
    ),
  };
}
