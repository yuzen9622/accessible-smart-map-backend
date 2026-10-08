import type { RetentionConfig } from "../../config/retention";
import {
  RECONCILE_TASKS,
  RETENTION_TASKS,
  runRetention,
} from "./retention.orchestration";

const BACKLOG_FOLLOW_UP_MS = 5_000;

/**
 * Starts the in-process retention job: one run now, then every
 * `scanIntervalMs`, plus the reconciliation sweeps every
 * `reconcileIntervalMs`. A run that ends with backlog schedules a follow-up
 * shortly after instead of waiting a full interval. Overlapping runs in this
 * process are skipped; across instances every step is an atomic conditional
 * update or an idempotent delete, so concurrent runs cannot double-act.
 *
 * @param config Validated retention config
 * @returns A stop function for shutdown
 */
export function startRetentionJob(config: RetentionConfig): () => void {
  let inFlight = false;
  let stopped = false;
  let lastReconcileAt = 0;
  let followUp: NodeJS.Timeout | undefined;

  const run = async () => {
    if (inFlight || stopped) return;
    inFlight = true;
    try {
      const reconcileDue =
        Date.now() - lastReconcileAt >= config.reconcileIntervalMs;
      const tasks = reconcileDue
        ? [...RETENTION_TASKS, ...RECONCILE_TASKS]
        : RETENTION_TASKS;
      const result = await runRetention(tasks, config);
      if (reconcileDue) {
        const reconcileOk = RECONCILE_TASKS.every((task) => {
          const summary = result.tasks.find((s) => s.name === task.name);
          return summary?.drained && !summary.failed;
        });
        if (reconcileOk) lastReconcileAt = Date.now();
      }
      if (result.backlog && !stopped) {
        followUp = setTimeout(() => void run(), BACKLOG_FOLLOW_UP_MS);
        followUp.unref?.();
      }
    } catch (error) {
      console.error("[retention] run failed:", error);
    } finally {
      inFlight = false;
    }
  };

  void run();
  const timer = setInterval(() => void run(), config.scanIntervalMs);
  timer.unref?.();
  return () => {
    stopped = true;
    clearInterval(timer);
    if (followUp) clearTimeout(followUp);
  };
}
