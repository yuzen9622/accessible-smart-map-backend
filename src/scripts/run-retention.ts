/**
 * Runs the privacy retention tasks once (all of them, reconciliation sweeps
 * included) and exits non-zero if any task failed. For manual runs, cron, or
 * verifying a deployment:
 *   pnpm retention:run [--dry-run]
 */

import "dotenv/config";
import mongoose from "mongoose";
import { getRetentionConfig } from "../config/retention";
import {
  RECONCILE_TASKS,
  RETENTION_TASKS,
  runRetention,
} from "../modules/retention/retention.orchestration";

async function main() {
  const dryRun = process.argv.includes("--dry-run");
  const config = getRetentionConfig();
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) throw new Error("DATABASE_URL is required");
  await mongoose.connect(dbUrl);

  let failed = false;
  try {
    const result = await runRetention(
      [...RETENTION_TASKS, ...RECONCILE_TASKS],
      config,
      { dryRun },
    );
    console.table(
      result.tasks.map((t) => ({
        task: t.name,
        [dryRun ? "due (≤ batch)" : "processed"]: t.processed,
        drained: t.drained,
        failed: t.failed,
      })),
    );
    if (result.backlog) console.log("Backlog remains; run again to continue.");
    failed = result.tasks.some((t) => t.failed);
  } finally {
    await mongoose.disconnect();
  }
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
