import EmergencyContact from "../../model/emergency-contact.model";
import { RETENTION_DAY_MS, retentionCutoff } from "../../config/retention";
import {
  clearContactLocationsBefore,
  findOldestContactLocationAt,
} from "./line.repository";
import type { RetentionTask } from "../../types/retention";

/** Clears LINE-shared contact locations older than the policy allows. */
export const contactLocationTask: RetentionTask = {
  name: "contact.line-location",
  async runBatch(ctx) {
    const cutoff = retentionCutoff(
      ctx.now,
      ctx.config.contactLocationDeadlineDays * RETENTION_DAY_MS,
      ctx.config,
    );
    if (ctx.dryRun) {
      return EmergencyContact.countDocuments({
        lastLineLocationUpdatedAt: { $lte: cutoff },
      }).limit(ctx.config.batchSize);
    }
    return clearContactLocationsBefore(cutoff, ctx.config.batchSize);
  },
  async oldestOverdue(ctx) {
    const oldest = await findOldestContactLocationAt();
    const deadline =
      ctx.now.getTime() -
      ctx.config.contactLocationDeadlineDays * RETENTION_DAY_MS;
    return oldest && oldest.getTime() <= deadline ? oldest : null;
  },
};
