import type { RetentionConfig } from "../../config/retention";
import {
  sosAutoResolveTask,
  sosResolvedDeletionTask,
  sosResolvedNoticeTask,
} from "../sos/sos.retention";
import { contactLocationTask } from "../line/line.retention";
import {
  memoryDueTask,
  memoryLegacyTombstoneTask,
  memoryTombstonePurgeTask,
  memoryVectorReconcileTask,
} from "../ai/memory.retention";
import {
  hazardClosedAtBackfillTask,
  hazardContentScrubTask,
  hazardPhotoDeleteTask,
} from "../hazard-report/hazard-report.retention";
import { deletedAccountSweepTask } from "../user/user.account.retention";
import type { RetentionContext, RetentionTask } from "../../types/retention";

/** Deadline-driven tasks, run every scan. Order matters only within a cycle. */
export const RETENTION_TASKS: RetentionTask[] = [
  sosAutoResolveTask,
  sosResolvedNoticeTask,
  sosResolvedDeletionTask,
  contactLocationTask,
  memoryDueTask,
  memoryLegacyTombstoneTask,
  memoryTombstonePurgeTask,
  hazardClosedAtBackfillTask,
  hazardContentScrubTask,
  hazardPhotoDeleteTask,
];

/**
 * Reconciliation sweeps, run every `reconcileIntervalMs`. The account sweep
 * goes first: it tombstones late memories, which the vector reconciliation
 * then picks up.
 */
export const RECONCILE_TASKS: RetentionTask[] = [
  deletedAccountSweepTask,
  memoryVectorReconcileTask,
];

export interface RetentionTaskSummary {
  name: string;
  processed: number;
  drained: boolean;
  failed: boolean;
}

export interface RetentionRunSummary {
  tasks: RetentionTaskSummary[];
  /** True when the budget ran out with work left. */
  backlog: boolean;
  /** Tasks with data already past the policy deadline. */
  overdue: { name: string; oldest: Date }[];
}

/**
 * Runs the given tasks round-robin, one batch per task per cycle, until each
 * task is drained or failed or the run budget is spent. Round-robin keeps one
 * large category from starving the others. A dry run does one counting pass.
 *
 * @param tasks Tasks to run
 * @param config Effective retention config
 * @param options Run time and dry-run flag
 * @returns Per-task counts, whether backlog remains, and overdue findings
 */
export async function runRetention(
  tasks: RetentionTask[],
  config: RetentionConfig,
  options: { now?: Date; dryRun?: boolean } = {},
): Promise<RetentionRunSummary> {
  const ctx: RetentionContext = {
    now: options.now ?? new Date(),
    config,
    dryRun: options.dryRun ?? false,
  };
  const startedAt = Date.now();
  const entries = tasks.map((task) => ({
    task,
    summary: {
      name: task.name,
      processed: 0,
      drained: false,
      failed: false,
    } as RetentionTaskSummary,
  }));
  const summaries = new Map(entries.map((e) => [e.task.name, e.summary]));

  let active = entries;
  while (active.length && Date.now() - startedAt < config.runBudgetMs) {
    const next: typeof entries = [];
    for (const entry of active) {
      const { task, summary } = entry;
      try {
        const handled = await task.runBatch(ctx);
        summary.processed += handled;
        if (handled < config.batchSize || ctx.dryRun) summary.drained = true;
        else next.push(entry);
      } catch (error) {
        summary.failed = true;
        console.error(`[retention] ${task.name} failed:`, error);
      }
      if (Date.now() - startedAt >= config.runBudgetMs) break;
    }
    active = next;
  }

  const overdue: { name: string; oldest: Date }[] = [];
  for (const task of tasks) {
    if (!task.oldestOverdue) continue;
    try {
      const oldest = await task.oldestOverdue(ctx);
      if (oldest) overdue.push({ name: task.name, oldest });
    } catch (error) {
      console.error(`[retention] ${task.name} overdue check failed:`, error);
    }
  }

  const result: RetentionRunSummary = {
    tasks: [...summaries.values()],
    backlog: [...summaries.values()].some((s) => !s.drained && !s.failed),
    overdue,
  };

  const touched = result.tasks.filter((s) => s.processed > 0 || s.failed);
  if (touched.length || result.backlog) {
    console.log(
      "[retention] run",
      JSON.stringify({
        dryRun: ctx.dryRun,
        ms: Date.now() - startedAt,
        backlog: result.backlog,
        tasks: touched,
      }),
    );
  }
  for (const item of overdue) {
    console.warn(
      "[retention] data past policy deadline",
      JSON.stringify({
        task: item.name,
        oldest: item.oldest.toISOString(),
        ageHours: Math.round(
          (ctx.now.getTime() - item.oldest.getTime()) / 3_600_000,
        ),
      }),
    );
  }
  return result;
}
