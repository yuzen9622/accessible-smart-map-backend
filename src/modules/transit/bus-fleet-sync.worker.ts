import { fetchHsinchuFleet } from "../../adapters/hsinchu-bus.adapter";
import { fetchKeelungFleet } from "../../adapters/keelung-bus.adapter";
import { fetchTaichungFleet } from "../../adapters/taichung-bus.adapter";
import { taipeiYmdDash } from "../../config/taipei-time";
import type { BusFleetObservation, BusFleetSightingSource } from "../../types";
import {
  loadRouteIndex,
  recordFleetSightings,
  type RouteIndex,
} from "./bus-fleet.repository";
import { upsertVehicleObservations } from "./bus.repository";

const DEFAULT_SYNC_INTERVAL_MS = 15 * 60 * 1000;
const MIN_SYNC_INTERVAL_MS = 60 * 1000;
const configuredInterval = Number(process.env.BUS_FLEET_SYNC_INTERVAL_MS);
const BUS_FLEET_SYNC_INTERVAL_MS =
  Number.isFinite(configuredInterval) && configuredInterval > 0
    ? Math.max(configuredInterval, MIN_SYNC_INTERVAL_MS)
    : DEFAULT_SYNC_INTERVAL_MS;

/**
 * Resolve a city system's route id to a TDX routeUid, exactly or not at all.
 * Taichung's xno is TDX's Taichung RouteID; Hsinchu's id is a TDX SubRouteUID
 * plus a direction suffix. Keelung's ids only relate to TDX by route name, so
 * Keelung routes get their plate history from realtime sightings instead.
 */
type RouteResolver = (
  cityRouteId: string,
  index: RouteIndex,
) => string | undefined;

const FLEET_SOURCES: {
  name: string;
  fetch: () => Promise<BusFleetObservation[]>;
  sighting?: { source: BusFleetSightingSource; resolve: RouteResolver };
}[] = [
  {
    name: "taichung",
    fetch: () => fetchTaichungFleet(taipeiYmdDash()),
    sighting: {
      source: "taichung-ebus",
      resolve: (id, index) =>
        index.routeUids.has(`TXG${id}`) ? `TXG${id}` : undefined,
    },
  },
  { name: "keelung", fetch: fetchKeelungFleet },
  {
    name: "hsinchu",
    fetch: fetchHsinchuFleet,
    sighting: {
      source: "hsinchu-ibus",
      resolve: (id, index) =>
        index.routeUidBySubRoute.get(id.replace(/_\d+$/, "")),
    },
  },
];

/**
 * Turn observations into plate-on-route sightings, dropping route ids that
 * do not resolve to exactly one stored TDX route.
 *
 * @returns The sightings and the count of route ids left unresolved.
 */
function toSightings(
  observations: BusFleetObservation[],
  resolve: RouteResolver,
  index: RouteIndex,
): {
  sightings: { plateNumb: string; routeUid: string }[];
  unresolved: number;
} {
  const sightings: { plateNumb: string; routeUid: string }[] = [];
  let unresolved = 0;
  for (const obs of observations) {
    for (const id of obs.cityRouteIds ?? []) {
      const routeUid = resolve(id, index);
      if (routeUid) sightings.push({ plateNumb: obs.plateNumb, routeUid });
      else unresolved += 1;
    }
  }
  return { sightings, unresolved };
}

let syncRunning = false;

type SyncResult =
  | {
      seen: number;
      written: number;
      sightings?: number;
      unresolvedRoutes?: number;
    }
  | { error: string };

/**
 * Pull plate-level low-floor status from every city source and store it in
 * the vehicle table the realtime join reads, plus which TDX routes each plate
 * ran on (route low-floor history). Sources fail independently.
 *
 * @returns Per-source counts of plates seen, records written and sightings.
 */
export async function syncBusFleet(): Promise<Record<string, SyncResult>> {
  const results: Record<string, SyncResult> = {};
  for (const source of FLEET_SOURCES) {
    try {
      const observations = await source.fetch();
      const written = await upsertVehicleObservations(observations);
      const result: SyncResult = { seen: observations.length, written };
      if (source.sighting) {
        const index = await loadRouteIndex();
        const { sightings, unresolved } = toSightings(
          observations,
          source.sighting.resolve,
          index,
        );
        result.sightings = await recordFleetSightings(
          sightings,
          source.sighting.source,
        );
        result.unresolvedRoutes = unresolved;
      }
      results[source.name] = result;
    } catch (err) {
      results[source.name] = { error: (err as Error).message };
    }
  }
  return results;
}

/**
 * Starts the in-process fleet sync (runs once immediately, then every
 * `BUS_FLEET_SYNC_INTERVAL_MS`). A run still in progress is never overlapped,
 * and the timer is unref'd so it never keeps the process alive on its own.
 *
 * @returns The interval timer handle.
 */
export function startBusFleetSyncJob(): NodeJS.Timeout {
  const run = () => {
    if (syncRunning) return;
    syncRunning = true;
    void syncBusFleet()
      .then((results) =>
        console.log("[bus-fleet] sync", JSON.stringify(results)),
      )
      .catch((err) => console.error("[bus-fleet] sync failed:", err))
      .finally(() => {
        syncRunning = false;
      });
  };
  run();
  const timer = setInterval(run, BUS_FLEET_SYNC_INTERVAL_MS);
  timer.unref?.();
  return timer;
}
