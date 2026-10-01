/**
 * Import: 臺北市交通管制工程處 audible-signal locations → visual_a11ys
 * (source "taipei_tce", type "audio_signal"). Idempotent upsert keyed by the
 * signal number. Run `migrate:visual-a11y-source` once before the first import.
 *
 * Run: pnpm import:taipei-aps
 */

import "dotenv/config";
import mongoose from "mongoose";
import { fetchTaipeiApsCsv } from "../adapters/taipei-aps.adapter";
import VisualA11yModel from "../model/visual-a11y.model";
import { syncTaipeiAps } from "../modules/visual-a11y/visual-a11y.service";

async function main() {
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) throw new Error("DATABASE_URL env var is required");

  const csv = await fetchTaipeiApsCsv();
  await mongoose.connect(dbUrl);
  const indexes = await VisualA11yModel.collection.indexes();
  if (indexes.some((i) => i.name === "osmNodeId_1_type_1")) {
    console.error(
      "visual_a11ys still has the legacy osmNodeId_1_type_1 index; run `pnpm migrate:visual-a11y-source` first.",
    );
    await mongoose.disconnect();
    process.exit(2);
  }
  const result = await syncTaipeiAps(csv);
  console.log(
    `✓ parsed=${result.parsed} inserted=${result.inserted} updated=${result.updated}`,
  );
  await mongoose.disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
