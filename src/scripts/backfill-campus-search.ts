/**
 * Backfills `searchName` / `aliasNames` on existing campus documents so the
 * keyword directory search works without a full re-crawl. Idempotent — the
 * fields are recomputed deterministically from schoolName / branchName.
 *
 * Run: npm run backfill:campus-search
 */

import "dotenv/config";
import mongoose from "mongoose";
import CampusA11yModel from "../model/campus-a11y.model";
import {
  buildAliasNames,
  buildSearchName,
} from "../modules/campus/campus.util";

async function main() {
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) throw new Error("DATABASE_URL env var is required");

  await mongoose.connect(dbUrl);
  console.log("Connected to MongoDB");

  const docs = await CampusA11yModel.find({}, "schoolName branchName").lean();
  console.log(`Campuses to backfill: ${docs.length}`);

  if (docs.length > 0) {
    const res = await CampusA11yModel.bulkWrite(
      docs.map((d) => ({
        updateOne: {
          filter: { _id: d._id },
          update: {
            $set: {
              searchName: buildSearchName(d.schoolName, d.branchName),
              aliasNames: buildAliasNames(d.schoolName),
            },
          },
        },
      })),
      { ordered: false },
    );
    console.log(`✓ Backfilled ${res.modifiedCount} campuses`);
  }

  await mongoose.disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
