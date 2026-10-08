import crypto from "crypto";
import HazardReport from "../../model/hazard-report.model";
import { deleteHazardPhoto } from "../../adapters/gcs.adapter";
import { RETENTION_DAY_MS, retentionCutoff } from "../../config/retention";
import {
  backfillRejectedClosedAt,
  deferReportPhotoDelete,
  findOldestOverdueReport,
  findReportsDueForPhotoDelete,
  findReportsDueForScrub,
  markReportDeidentified,
  scrubReportContent,
} from "./hazard-report.repository";
import type { RetentionContext, RetentionTask } from "../../types/retention";

const PHOTO_RETRY_BASE_MS = 15 * 60 * 1000;
const PHOTO_RETRY_CAP_MS = 6 * 60 * 60 * 1000;

function scrubCutoff(ctx: RetentionContext): Date {
  return retentionCutoff(
    ctx.now,
    ctx.config.hazardReportDeadlineDays * RETENTION_DAY_MS,
    ctx.config,
  );
}

/** Gives reports rejected before `closedAt` existed a close time. */
export const hazardClosedAtBackfillTask: RetentionTask = {
  name: "hazard.closed-at-backfill",
  async runBatch(ctx) {
    if (ctx.dryRun) {
      return HazardReport.countDocuments({
        status: "rejected",
        closedAt: { $exists: false },
        contentScrubbedAt: { $exists: false },
      }).limit(ctx.config.batchSize);
    }
    return backfillRejectedClosedAt(ctx.config.batchSize);
  },
};

/**
 * Phase A: scrubs identity and free text from reports closed or expired for
 * the policy period. Runs independently of GCS, so a storage outage cannot
 * delay it.
 */
export const hazardContentScrubTask: RetentionTask = {
  name: "hazard.content-scrub",
  async runBatch(ctx) {
    const cutoff = scrubCutoff(ctx);
    const ids = await findReportsDueForScrub(cutoff, ctx.config.batchSize);
    if (ctx.dryRun) return ids.length;
    for (const id of ids) {
      await scrubReportContent(
        id,
        cutoff,
        `deidentified:${crypto.randomUUID()}`,
      );
    }
    return ids.length;
  },
  async oldestOverdue(ctx) {
    return findOldestOverdueReport(
      new Date(
        ctx.now.getTime() -
          ctx.config.hazardReportDeadlineDays * RETENTION_DAY_MS,
      ),
    );
  },
};

/**
 * Phase B: deletes the photo object of scrubbed reports, then drops its URL.
 * Failures back off exponentially per report (capped) so one stuck object
 * cannot hold the front of the queue.
 */
export const hazardPhotoDeleteTask: RetentionTask = {
  name: "hazard.photo-delete",
  async runBatch(ctx) {
    const due = await findReportsDueForPhotoDelete(
      ctx.now,
      ctx.config.batchSize,
    );
    if (ctx.dryRun) return due.length;
    for (const report of due) {
      try {
        if (report.photoStoragePath) {
          await deleteHazardPhoto(report.photoStoragePath);
        }
        await markReportDeidentified(report._id);
      } catch (error) {
        const delay = Math.min(
          PHOTO_RETRY_BASE_MS * 2 ** report.attempts,
          PHOTO_RETRY_CAP_MS,
        );
        console.warn(
          "[retention] hazard photo delete failed",
          JSON.stringify({
            reportId: report._id,
            attempt: report.attempts + 1,
          }),
          error instanceof Error ? error.message : error,
        );
        await deferReportPhotoDelete(
          report._id,
          new Date(ctx.now.getTime() + delay),
        );
      }
    }
    return due.length;
  },
};
