/**
 * One-off migration for visual_a11ys: backfill `source: "osm"` and
 * `sourceId = String(osmNodeId)` on existing OSM documents, then replace the
 * legacy unique index {osmNodeId, type} with {source, sourceId, type}. The old
 * index must go before any non-OSM document is written: those have no
 * osmNodeId, and a unique index treats every missing value as the same null.
 *
 * Idempotent. Back up the collection first and run it with the backend
 * stopped (or at low traffic).
 *
 * Run: pnpm migrate:visual-a11y-source
 */

import "dotenv/config";
import mongoose from "mongoose";
import VisualA11yModel from "../model/visual-a11y.model";

const LEGACY_INDEX = "osmNodeId_1_type_1";

/**
 * Backfill source fields and swap the unique index. Idempotent.
 *
 * @returns What changed and how many documents still lack source fields.
 */
export async function migrateVisualA11ySource(): Promise<{
  backfilled: number;
  droppedLegacyIndex: boolean;
  missing: number;
}> {
  const backfill = await VisualA11yModel.collection.updateMany(
    { source: { $exists: false }, osmNodeId: { $type: "number" } },
    [{ $set: { source: "osm", sourceId: { $toString: "$osmNodeId" } } }],
  );
  const indexes = await VisualA11yModel.collection.indexes();
  const droppedLegacyIndex = indexes.some((i) => i.name === LEGACY_INDEX);
  if (droppedLegacyIndex) {
    await VisualA11yModel.collection.dropIndex(LEGACY_INDEX);
  }
  await VisualA11yModel.createIndexes();
  const missing = await VisualA11yModel.countDocuments({
    $or: [{ source: { $exists: false } }, { sourceId: { $exists: false } }],
  });
  return { backfilled: backfill.modifiedCount, droppedLegacyIndex, missing };
}

async function main() {
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) throw new Error("DATABASE_URL env var is required");
  await mongoose.connect(dbUrl);
  const result = await migrateVisualA11ySource();
  console.log(`✓ ${JSON.stringify(result)}`);
  await mongoose.disconnect();
  if (result.missing > 0) process.exit(2);
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
