import type { RetentionConfig } from "../config/retention";

/** What one retention batch sees. */
export interface RetentionContext {
  now: Date;
  config: RetentionConfig;
  /** Report what would be processed without changing anything. */
  dryRun: boolean;
}

/**
 * One retention category. `runBatch` handles at most `config.batchSize`
 * records; a result below the batch size means the category is drained.
 */
export interface RetentionTask {
  name: string;
  runBatch(ctx: RetentionContext): Promise<number>;
  /**
   * Oldest record already past its policy deadline (not just the earlier
   * cutoff), for overdue monitoring. Null when nothing is overdue.
   */
  oldestOverdue?(ctx: RetentionContext): Promise<Date | null>;
}
