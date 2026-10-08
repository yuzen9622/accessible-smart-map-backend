import crypto from "crypto";
import { RETENTION_DAY_MS } from "../../config/retention";
import { redisDel } from "../../config/redis";
import { MEMORY_CACHE_PREFIX } from "../../constants/memory";
import {
  anonymizeHazardReports,
  deleteAuthSessions,
  deleteOwnedRecords,
  findDeletedAccountsToSweep,
  recordDeletedAccountSweep,
  removeDeletedAccountEntry,
  tombstoneUserMemories,
  userExists,
  type DeletedAccountEntry,
} from "./user.account.repository";
import { deleteMemoryVectors } from "./user.account.service";
import type { RetentionContext, RetentionTask } from "../../types/retention";

/**
 * Removes whatever was written for one deleted account since its deletion.
 *
 * @returns How many records were removed or pseudonymised
 */
async function sweepAccount(userId: string): Promise<number> {
  let found = await deleteOwnedRecords(userId);
  found += await deleteAuthSessions(userId);
  found += await tombstoneUserMemories(userId);
  found += await anonymizeHazardReports(
    userId,
    `deleted:${crypto.randomUUID()}`,
  );
  await redisDel(MEMORY_CACHE_PREFIX + userId);
  // Idempotent; covers vectors whose delete failed earlier. A failure counts
  // as residue so the entry is kept until Chroma confirms.
  if (!(await deleteMemoryVectors(userId))) found += 1;
  return found;
}

function shouldRemove(
  entry: DeletedAccountEntry,
  ctx: RetentionContext,
  foundNow: boolean,
): "keep" | "done" | "cap" {
  const now = ctx.now.getTime();
  if (
    now - entry.createdAt.getTime() >=
    ctx.config.accountSweepCapDays * RETENTION_DAY_MS
  ) {
    return "cap";
  }
  if (foundNow) return "keep";
  const quietSince = (
    entry.lastFoundAt ??
    entry.userDeletedAt ??
    entry.createdAt
  ).getTime();
  return now - quietSince >= ctx.config.accountSweepQuietMs ? "done" : "keep";
}

/**
 * Sweeps registered account deletions: deletes records that concurrent
 * requests wrote for the account after it was deleted. An entry still
 * `pending` while its user exists is a deletion that failed part-way; it is
 * left untouched (the user can retry) so a live account never loses data.
 * Entries are dropped after a quiet period with nothing found, or at the hard
 * cap.
 */
export const deletedAccountSweepTask: RetentionTask = {
  name: "account.deleted-sweep",
  async runBatch(ctx) {
    const entries = await findDeletedAccountsToSweep(
      ctx.now,
      ctx.config.batchSize,
    );
    for (const entry of entries) {
      const userGone =
        entry.state === "user_deleted" || !(await userExists(entry.userId));
      if (ctx.dryRun) continue;
      if (!userGone) {
        await recordDeletedAccountSweep(entry.userId, ctx.now, false, false);
        if (shouldRemove(entry, ctx, false) === "cap") {
          await removeDeletedAccountEntry(entry.userId);
        }
        continue;
      }
      const found = await sweepAccount(entry.userId);
      await recordDeletedAccountSweep(entry.userId, ctx.now, found > 0, true);
      const verdict = shouldRemove(entry, ctx, found > 0);
      if (verdict === "cap" && found > 0) {
        console.error(
          "[retention] deleted-account sweep still finding data at cap",
          JSON.stringify({ found }),
        );
      }
      if (verdict !== "keep") await removeDeletedAccountEntry(entry.userId);
    }
    return entries.length;
  },
};
