import mongoose from "mongoose";
import GtfsStopAliasModel from "../../model/gtfs-stop-alias.model";

const MAX_ALIASES_PER_CANONICAL_STOP = 64;

/** Expand only canonical ids already supplied by OTP, never historical reverse guesses. */
export async function expandOriginalStopsForCanonical(
  canonicalIds: string[],
): Promise<{ stops: Map<string, string[]>; complete: boolean }> {
  const uniqueIds = [...new Set(canonicalIds)];
  const stops = new Map(uniqueIds.map((id) => [id, [id]]));
  if (
    !uniqueIds.length ||
    mongoose.connection.readyState !== mongoose.ConnectionStates.connected
  )
    return { stops, complete: false };

  let complete = true;
  const loadAliases = async (canonicalId: string): Promise<void> => {
    const rows = await GtfsStopAliasModel.find(
      { stopId: canonicalId },
      { stopId: 1, originalStopId: 1, _id: 0 },
    )
      .sort({ routeId: 1, originalStopId: 1 })
      .limit(MAX_ALIASES_PER_CANONICAL_STOP + 1)
      .maxTimeMS(1000)
      .lean();
    if (rows.length > MAX_ALIASES_PER_CANONICAL_STOP) complete = false;
    const ids = stops.get(canonicalId);
    if (!ids) return;
    for (const row of rows.slice(0, MAX_ALIASES_PER_CANONICAL_STOP))
      if (!ids.includes(row.originalStopId)) ids.push(row.originalStopId);
  };
  await Promise.all(uniqueIds.map((canonicalId) => loadAliases(canonicalId)));
  return { stops, complete };
}

/** Backward-compatible map-only view for existing import/runtime callers. */
export async function findOriginalStopsForCanonical(
  canonicalIds: string[],
): Promise<Map<string, string[]>> {
  return (await expandOriginalStopsForCanonical(canonicalIds)).stops;
}

/** Legacy only: ambiguous historical canonical ids are not authoritative. */
export async function findUniqueCanonicalStop(
  routeId: string,
  originalStopId: string,
): Promise<string | null> {
  if (mongoose.connection.readyState !== mongoose.ConnectionStates.connected)
    return null;
  const rows = await GtfsStopAliasModel.find(
    { routeId, originalStopId },
    { stopId: 1, _id: 0 },
  )
    .maxTimeMS(1000)
    .lean();
  const ids = [...new Set(rows.map((r) => r.stopId))];
  return ids.length === 1 ? ids[0] : null;
}

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
  const rows = await GtfsStopAliasModel.find(
    {
      routeId: { $in: [...new Set(pairs.map((p) => p.routeId))] },
      stopId: { $in: [...new Set(pairs.map((p) => p.stopId))] },
    },
    { routeId: 1, stopId: 1, originalStopId: 1, _id: 0 },
  ).lean<{ routeId: string; stopId: string; originalStopId: string }[]>();
  for (const row of rows) {
    out.set(`${row.routeId}|${row.stopId}`, row.originalStopId);
  }
  return out;
}
