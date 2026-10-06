import mongoose from "mongoose";
import { getRoutingConfig } from "../../config/routing";
import { taipeiYmdDash } from "../../config/taipei-time";
import BusFleetSightingModel from "../../model/bus-fleet-sighting.model";
import BusRouteModel from "../../model/bus-route.model";
import BusVehicleModel from "../../model/bus-vehicle.model";
import type {
  BusFleetSightingSource,
  RouteLowFloorEvidence,
} from "../../types";

const DAY_MS = 24 * 60 * 60 * 1000;
const ROUTE_INDEX_TTL_MS = 6 * 60 * 60 * 1000;

/** TDX route identity, from the routes the transit import stored. */
export interface RouteIndex {
  routeUids: Set<string>;
  routeUidBySubRoute: Map<string, string>;
}

let routeIndex: { value: RouteIndex; loadedAt: number } | null = null;

/**
 * Low-floor history is advisory, so its reads and writes skip instead of
 * queueing behind Mongoose's command buffer while the database is down.
 */
function databaseReady(): boolean {
  return mongoose.connection.readyState === mongoose.ConnectionStates.connected;
}

/**
 * The stored TDX routes as lookup tables, cached for six hours. Every
 * sighting is keyed by TDX `routeUid`, so city route ids and GTFS sub-route
 * ids both resolve here, and only exact matches are accepted.
 *
 * @returns Known route uids and the sub-route → route mapping.
 */
export async function loadRouteIndex(): Promise<RouteIndex> {
  if (routeIndex && Date.now() - routeIndex.loadedAt < ROUTE_INDEX_TTL_MS) {
    return routeIndex.value;
  }
  const rows = (await BusRouteModel.find(
    {},
    { routeUid: 1, subRouteUid: 1, _id: 0 },
  ).lean()) as unknown as { routeUid?: string; subRouteUid?: string }[];
  const value: RouteIndex = {
    routeUids: new Set(),
    routeUidBySubRoute: new Map(),
  };
  for (const row of rows) {
    if (!row.routeUid) continue;
    value.routeUids.add(row.routeUid);
    if (row.subRouteUid)
      value.routeUidBySubRoute.set(row.subRouteUid, row.routeUid);
  }
  routeIndex = { value, loadedAt: Date.now() };
  return value;
}

/** Clears the cached route index (tests). */
export function resetRouteIndexCache(): void {
  routeIndex = null;
}

/**
 * Record plates seen running TDX routes. One record per plate, route and
 * Taipei service day; a repeat sighting only refreshes its time and expiry.
 *
 * @param sightings Plate and TDX route uid pairs.
 * @param source Where the sightings came from.
 * @param now The sighting time.
 * @returns The number of records inserted or refreshed.
 */
export async function recordFleetSightings(
  sightings: { plateNumb: string; routeUid: string }[],
  source: BusFleetSightingSource,
  now: Date = new Date(),
): Promise<number> {
  const unique = new Map<string, { plateNumb: string; routeUid: string }>();
  for (const s of sightings) {
    const plateNumb = s.plateNumb.trim().toUpperCase();
    if (!plateNumb || plateNumb === "-1" || !s.routeUid) continue;
    unique.set(`${s.routeUid}|${plateNumb}`, {
      plateNumb,
      routeUid: s.routeUid,
    });
  }
  if (!unique.size || !databaseReady()) return 0;
  const seenOn = taipeiYmdDash(now);
  const expiresAt = new Date(
    now.getTime() + getRoutingConfig().fleetSightingTtlDays * DAY_MS,
  );
  const result = await BusFleetSightingModel.bulkWrite(
    [...unique.values()].map((s) => ({
      updateOne: {
        filter: { routeUid: s.routeUid, plateNumb: s.plateNumb, seenOn },
        update: { $set: { source, seenAt: now, expiresAt } },
        upsert: true,
      },
    })),
    { ordered: false },
  );
  return result.upsertedCount + result.modifiedCount;
}

/**
 * Record plates seen on a GTFS/TDX sub-route (the realtime ETA rows of a
 * planned bus leg). Sub-routes absent from the stored TDX routes are skipped.
 *
 * @param subRouteUid The leg's TDX sub-route uid.
 * @param plates Plates reported on that sub-route.
 * @returns The number of records inserted or refreshed.
 */
export async function recordRealtimeSightings(
  subRouteUid: string,
  plates: (string | undefined)[],
): Promise<number> {
  if (!databaseReady()) return 0;
  const { routeUidBySubRoute } = await loadRouteIndex();
  const routeUid = routeUidBySubRoute.get(subRouteUid);
  if (!routeUid) return 0;
  return recordFleetSightings(
    plates
      .filter((p): p is string => !!p)
      .map((plateNumb) => ({ plateNumb, routeUid })),
    "tdx-realtime",
  );
}

/**
 * Low-floor history of the routes behind the given sub-routes, from distinct
 * plates seen within the evidence window joined with their vehicle records.
 * Plates without a known car type stay in `distinctPlates` only.
 *
 * @param subRouteUids TDX sub-route uids of planned bus legs.
 * @param now Reference time for the evidence window.
 * @returns Evidence per sub-route uid; sub-routes with no sightings are absent.
 */
export async function findRouteLowFloorEvidence(
  subRouteUids: string[],
  now: Date = new Date(),
): Promise<Map<string, RouteLowFloorEvidence>> {
  const out = new Map<string, RouteLowFloorEvidence>();
  if (!subRouteUids.length || !databaseReady()) return out;
  const { routeUidBySubRoute } = await loadRouteIndex();
  const routeOf = new Map<string, string>();
  for (const sub of new Set(subRouteUids)) {
    const route = routeUidBySubRoute.get(sub);
    if (route) routeOf.set(sub, route);
  }
  if (!routeOf.size) return out;

  const since = new Date(
    now.getTime() - getRoutingConfig().lowFloorEvidence.maxAgeDays * DAY_MS,
  );
  const sightings = (await BusFleetSightingModel.find(
    {
      routeUid: { $in: [...new Set(routeOf.values())] },
      seenAt: { $gte: since },
    },
    { plateNumb: 1, routeUid: 1, source: 1, seenAt: 1, _id: 0 },
  ).lean()) as unknown as {
    plateNumb: string;
    routeUid: string;
    source: BusFleetSightingSource;
    seenAt: Date;
  }[];
  if (!sightings.length) return out;

  const vehicles = (await BusVehicleModel.find(
    { plateNumb: { $in: [...new Set(sightings.map((s) => s.plateNumb))] } },
    { plateNumb: 1, isLowFloor: 1, _id: 0 },
  ).lean()) as unknown as { plateNumb: string; isLowFloor?: number }[];
  const flagByPlate = new Map(vehicles.map((v) => [v.plateNumb, v.isLowFloor]));

  const byRoute = new Map<
    string,
    {
      plates: Set<string>;
      lastSeenAt: Date;
      sources: Set<BusFleetSightingSource>;
    }
  >();
  for (const s of sightings) {
    const entry = byRoute.get(s.routeUid) ?? {
      plates: new Set<string>(),
      lastSeenAt: s.seenAt,
      sources: new Set<BusFleetSightingSource>(),
    };
    entry.plates.add(s.plateNumb);
    if (s.seenAt > entry.lastSeenAt) entry.lastSeenAt = s.seenAt;
    entry.sources.add(s.source);
    byRoute.set(s.routeUid, entry);
  }

  for (const [sub, route] of routeOf) {
    const entry = byRoute.get(route);
    if (!entry) continue;
    let knownTypePlates = 0;
    let lowFloorPlates = 0;
    for (const plate of entry.plates) {
      const flag = flagByPlate.get(plate);
      if (flag !== 0 && flag !== 1) continue;
      knownTypePlates += 1;
      if (flag === 1) lowFloorPlates += 1;
    }
    out.set(sub, {
      distinctPlates: entry.plates.size,
      knownTypePlates,
      lowFloorPlates,
      lastSeenAt: entry.lastSeenAt,
      sources: [...entry.sources].sort(),
    });
  }
  return out;
}
