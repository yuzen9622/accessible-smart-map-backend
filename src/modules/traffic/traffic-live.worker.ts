import { redisSetNx } from "../../config/redis";
import {
  TRAFFIC_LIVE_TARGET_CITIES,
  TRAFFIC_REFRESH,
} from "../../config/traffic";
import { refreshCityLiveTraffics } from "./traffic-flow.service";

/** Targets refreshed every tick: configured cities plus the two national networks. */
function refreshTargets(): string[] {
  return Array.from(
    new Set([...TRAFFIC_LIVE_TARGET_CITIES, "Freeway", "Highway"]),
  );
}

/**
 * @param ms Delay in milliseconds.
 * @returns A promise resolving once the delay elapsed.
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * @param target City or national network to refresh.
 * @param timeoutMs Wall-clock ceiling for this attempt.
 * @returns A promise rejecting once the ceiling is reached, leaving the underlying
 * refresh running so its cache write and SingleFlight dedupe still apply.
 */
async function refreshTargetWithTimeout(
  target: string,
  timeoutMs: number,
): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      refreshCityLiveTraffics(target),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          reject(new Error(`live refresh for ${target} timed out`));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
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
 * Targets run in batches whose wall-clock total stays below the lock TTL, so a
 * hung upstream call can never let one round overlap the next.
 */
export async function refreshAllLiveTraffics(): Promise<{
  refreshed: number;
  skipped: boolean;
  skippedTargets: number;
}> {
  const acquired = await redisSetNx(
    TRAFFIC_REFRESH.lockKey,
    TRAFFIC_REFRESH.lockTtlSec,
  );
  if (!acquired) {
    console.log(
      "[traffic] live refresh skipped: lock held by another instance",
    );
    return { refreshed: 0, skipped: true, skippedTargets: 0 };
  }

  const targets = refreshTargets();
  const roundDeadlineMs = TRAFFIC_REFRESH.lockTtlSec * 1000 * 0.9;
  const targetTimeoutMs = Math.min(
    TRAFFIC_REFRESH.liveRefreshTargetTimeoutMs,
    roundDeadlineMs,
  );
  const batchSize = Math.max(
    1,
    Math.floor(TRAFFIC_REFRESH.liveRefreshBatchSize),
  );
  const startedAt = Date.now();

  let refreshed = 0;
  let skippedTargets = 0;

  for (let start = 0; start < targets.length; start += batchSize) {
    if (
      start > 0 &&
      Date.now() - startedAt + targetTimeoutMs > roundDeadlineMs
    ) {
      skippedTargets = targets.length - start;
      break;
    }

    const results = await Promise.allSettled(
      targets
        .slice(start, start + batchSize)
        .map((target) => refreshTargetWithTimeout(target, targetTimeoutMs)),
    );
    for (const res of results) {
      if (res.status === "fulfilled") {
        refreshed++;
      }
    }

    const nextStart = start + batchSize;
    if (nextStart >= targets.length) {
      break;
    }

    const remaining = roundDeadlineMs - (Date.now() - startedAt);
    if (remaining <= targetTimeoutMs) {
      skippedTargets = targets.length - nextStart;
      break;
    }
    await sleep(
      Math.min(
        TRAFFIC_REFRESH.liveRefreshBatchGapMs,
        remaining - targetTimeoutMs,
      ),
    );
  }

  console.log(
    "[traffic] live refresh completed",
    JSON.stringify({
      refreshed,
      total: targets.length,
      skipped: skippedTargets,
    }),
  );

  return { refreshed, skipped: false, skippedTargets };
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
