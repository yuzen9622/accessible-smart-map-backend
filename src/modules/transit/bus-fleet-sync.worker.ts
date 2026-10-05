import { fetchHsinchuFleet } from "../../adapters/hsinchu-bus.adapter";
import { fetchKeelungFleet } from "../../adapters/keelung-bus.adapter";
import { fetchTaichungFleet } from "../../adapters/taichung-bus.adapter";
import { taipeiYmdDash } from "../../config/taipei-time";
import type { BusFleetObservation } from "../../types";
import { upsertVehicleObservations } from "./bus.repository";

const DEFAULT_SYNC_INTERVAL_MS = 15 * 60 * 1000;
const MIN_SYNC_INTERVAL_MS = 60 * 1000;
const configuredInterval = Number(process.env.BUS_FLEET_SYNC_INTERVAL_MS);
const BUS_FLEET_SYNC_INTERVAL_MS =
  Number.isFinite(configuredInterval) && configuredInterval > 0
    ? Math.max(configuredInterval, MIN_SYNC_INTERVAL_MS)
    : DEFAULT_SYNC_INTERVAL_MS;

const FLEET_SOURCES: {
  name: string;
  fetch: () => Promise<BusFleetObservation[]>;
}[] = [
  { name: "taichung", fetch: () => fetchTaichungFleet(taipeiYmdDash()) },
  { name: "keelung", fetch: fetchKeelungFleet },
  { name: "hsinchu", fetch: fetchHsinchuFleet },
];

let syncRunning = false;

/**
 * Pull plate-level low-floor status from every city source and store it in
 * the vehicle table the realtime join reads. Sources fail independently.
 *
 * @returns Per-source counts of plates seen and records written.
 */
export async function syncBusFleet(): Promise<
  Record<string, { seen: number; written: number } | { error: string }>
> {
  const results: Record<
    string,
    { seen: number; written: number } | { error: string }
  > = {};
  for (const source of FLEET_SOURCES) {
    try {
      const observations = await source.fetch();
      const written = await upsertVehicleObservations(observations);
      results[source.name] = { seen: observations.length, written };
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
