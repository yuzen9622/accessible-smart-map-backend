import mongoose from "mongoose";
import GtfsStopAliasModel from "../../model/gtfs-stop-alias.model";

/**
 * Original stop ids for (GTFS route_id, merged stop_id) pairs. Skips instead
 * of queueing behind Mongoose's command buffer when the database is down.
 *
 * @param pairs Route and stop id pairs seen in OTP itineraries.
 * @returns Original stop ids keyed by `${routeId}|${stopId}`; pairs whose stop
 *   was never merged are absent.
 */
export async function findStopAliases(
  pairs: { routeId: string; stopId: string }[],
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (
    !pairs.length ||
    mongoose.connection.readyState !== mongoose.ConnectionStates.connected
  ) {
    return out;
  }
  const rows = (await GtfsStopAliasModel.find(
    {
      routeId: { $in: [...new Set(pairs.map((p) => p.routeId))] },
      stopId: { $in: [...new Set(pairs.map((p) => p.stopId))] },
    },
    { routeId: 1, stopId: 1, originalStopId: 1, _id: 0 },
  ).lean()) as unknown as {
    routeId: string;
    stopId: string;
    originalStopId: string;
  }[];
  for (const row of rows) {
    out.set(`${row.routeId}|${row.stopId}`, row.originalStopId);
  }
  return out;
}
