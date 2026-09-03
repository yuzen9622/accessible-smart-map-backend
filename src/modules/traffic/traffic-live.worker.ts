import { redisSetNx } from "../../config/redis";
import { TRAFFIC_REFRESH, TRAFFIC_TARGET_CITIES } from "../../config/traffic";
import { refreshCityLiveTraffics } from "./traffic-flow.service";

/** Targets refreshed every tick: configured cities plus the two national networks. */
function refreshTargets(): string[] {
  return Array.from(new Set([...TRAFFIC_TARGET_CITIES, "Freeway", "Highway"]));
}

const scheduledRefreshes = new Set<string>();

/**
 * Fire-and-forget single-target refresh used by the SWR read path.
 * Deduplicates concurrent triggers for the same target in this process.
 */
export function scheduleLiveRefresh(target: string): void {
  if (scheduledRefreshes.has(target)) {
    return;
  }
  scheduledRefreshes.add(target);
  void refreshCityLiveTraffics(target)
    .catch((err: unknown) => {
      console.warn(`[traffic] background refresh for ${target} failed:`, err);
    })
    .finally(() => {
      scheduledRefreshes.delete(target);
    });
}

/**
 * Periodically refreshes all configured targets using a distributed Redis lock.
 * Lock is not manually deleted; it self-expires via TTL before the next interval.
 */
export async function refreshAllLiveTraffics(): Promise<{
  refreshed: number;
  skipped: boolean;
}> {
  const acquired = await redisSetNx(
    TRAFFIC_REFRESH.lockKey,
    TRAFFIC_REFRESH.lockTtlSec,
  );
  if (!acquired) {
    console.log(
      "[traffic] live refresh skipped: lock held by another instance",
    );
    return { refreshed: 0, skipped: true };
  }

  const targets = refreshTargets();
  const results = await Promise.allSettled(
    targets.map((target) => refreshCityLiveTraffics(target)),
  );

  let refreshed = 0;
  for (const res of results) {
    if (res.status === "fulfilled") {
      refreshed++;
    }
  }

  console.log(
    "[traffic] live refresh completed",
    JSON.stringify({ refreshed, total: targets.length }),
  );

  return { refreshed, skipped: false };
}

/**
 * Starts periodic background live traffic refresh.
 * Performs an immediate warm-up tick, then sets up the interval.
 * Timer is unref-ed so it does not block Node process exit.
 */
export function startTrafficLiveRefreshJob(): NodeJS.Timeout {
  void refreshAllLiveTraffics();

  const timer = setInterval(() => {
    void refreshAllLiveTraffics();
  }, TRAFFIC_REFRESH.liveIntervalMs);
  timer.unref();
  return timer;
}
