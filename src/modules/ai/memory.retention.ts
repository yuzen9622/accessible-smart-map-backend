import UserMemory from "../../model/user-memory.model";
import { getDocumentsWhere } from "../../adapters/chroma.adapter";
import { RETENTION_DAY_MS, retentionCutoff } from "../../config/retention";
import {
  countDueMemories,
  findLiveVectorIds,
  findPurgeableTombstones,
  findDeletedAccountOwners,
  findTombstoneOwners,
  hardDeleteTombstones,
  legacyTombstoneFilter,
  scrubLegacyTombstones,
  tombstoneDueMemories,
} from "./memory.repository";
import {
  deleteMemoryIndex,
  getMemoryCollection,
  retireVectors,
} from "./memory.service";
import type { RetentionContext, RetentionTask } from "../../types/retention";

function dueCutoff(ctx: RetentionContext): Date {
  return retentionCutoff(
    ctx.now,
    ctx.config.memoryUnusedDeadlineDays * RETENTION_DAY_MS,
    ctx.config,
  );
}

/** Tombstones memories past `expiresAt` or unused for the policy period. */
export const memoryDueTask: RetentionTask = {
  name: "memory.unused-or-expired",
  async runBatch(ctx) {
    if (ctx.dryRun) {
      return countDueMemories(dueCutoff(ctx), ctx.now, ctx.config.batchSize);
    }
    const refs = await tombstoneDueMemories(
      dueCutoff(ctx),
      ctx.now,
      ctx.config.batchSize,
    );
    if (refs.length) await retireVectors(refs);
    return refs.length;
  },
  async oldestOverdue(ctx) {
    const deadline = new Date(
      ctx.now.getTime() -
        ctx.config.memoryUnusedDeadlineDays * RETENTION_DAY_MS,
    );
    const row = await UserMemory.findOne({
      deletedAt: null,
      updatedAt: { $lte: deadline },
      $or: [{ lastUsedAt: null }, { lastUsedAt: { $lte: deadline } }],
    })
      .sort({ updatedAt: 1 })
      .select("updatedAt")
      .lean<{ updatedAt?: Date }>();
    return row?.updatedAt ?? null;
  },
};

/** Drops content left on tombstones written before tombstones were content-free. */
export const memoryLegacyTombstoneTask: RetentionTask = {
  name: "memory.legacy-tombstone-scrub",
  async runBatch(ctx) {
    if (ctx.dryRun) {
      return UserMemory.countDocuments(legacyTombstoneFilter()).limit(
        ctx.config.batchSize,
      );
    }
    return scrubLegacyTombstones(ctx.config.batchSize);
  },
};

/**
 * Hard-deletes tombstones past the keep window, after confirming their
 * vectors are gone. A failed vector delete keeps the batch for the next run.
 */
export const memoryTombstonePurgeTask: RetentionTask = {
  name: "memory.tombstone-purge",
  async runBatch(ctx) {
    const keepCutoff = new Date(
      ctx.now.getTime() - ctx.config.memoryTombstoneKeepDays * RETENTION_DAY_MS,
    );
    const refs = await findPurgeableTombstones(
      keepCutoff,
      ctx.config.batchSize,
    );
    if (ctx.dryRun || !refs.length) return refs.length;
    if (!(await deleteMemoryIndex(refs.map((ref) => ref.vectorId)))) {
      console.warn(
        "[retention] tombstone purge deferred: vector delete failed",
        JSON.stringify({ count: refs.length }),
      );
      return 0;
    }
    return hardDeleteTombstones(refs.map((ref) => ref.memoryId));
  },
};

let reconcileCursor: string | null = null;

/**
 * Removes vectors that have no live memory behind them, one owner at a time.
 * Owners come from tombstones (kept for the keep window) and deleted-account
 * entries, so every vector a late or failed write could have stranded belongs
 * to an enumerated owner.
 * Each owner's vectors are read in one request, so concurrent deletes cannot
 * make the scan skip any. Vectors indexed within the grace window are left
 * alone; legacy vectors without `indexedAt` predate it and are eligible.
 */
export const memoryVectorReconcileTask: RetentionTask = {
  name: "memory.vector-reconcile",
  async runBatch(ctx) {
    // Owners with tombstones plus deleted accounts, merged in userId order
    // so the cursor pages through both.
    const [tombstoneOwners, deletedOwners] = await Promise.all([
      findTombstoneOwners(reconcileCursor, ctx.config.batchSize),
      findDeletedAccountOwners(reconcileCursor, ctx.config.batchSize),
    ]);
    const owners = [...new Set([...tombstoneOwners, ...deletedOwners])]
      .sort()
      .slice(0, ctx.config.batchSize);
    if (!owners.length) {
      reconcileCursor = null;
      return 0;
    }

    const collection = await getMemoryCollection();
    const graceLimit = ctx.now.getTime() - ctx.config.memoryVectorGraceMs;
    let orphans = 0;
    for (const userId of owners) {
      const [vectors, live] = await Promise.all([
        getDocumentsWhere(collection, { userId }),
        findLiveVectorIds(userId),
      ]);
      const orphanIds = vectors
        .filter((vector) => !live.has(vector.id))
        .filter((vector) => {
          const indexedAt = vector.metadata.indexedAt;
          return typeof indexedAt !== "number" || indexedAt <= graceLimit;
        })
        .map((vector) => vector.id);
      if (!orphanIds.length) continue;
      orphans += orphanIds.length;
      if (!ctx.dryRun) await deleteMemoryIndex(orphanIds);
    }
    // Advance only after the whole batch succeeded, so a failure retries it.
    reconcileCursor =
      owners.length < ctx.config.batchSize ? null : owners[owners.length - 1];
    if (orphans) {
      console.log(
        "[retention] orphan memory vectors",
        JSON.stringify({ owners: owners.length, orphans, dryRun: ctx.dryRun }),
      );
    }
    return owners.length;
  },
};

/** Test hook: restart reconciliation from the first owner. */
export function resetMemoryReconcileCursor(): void {
  reconcileCursor = null;
}
