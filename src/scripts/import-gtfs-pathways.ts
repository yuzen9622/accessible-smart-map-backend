/**
 * Import pathways.txt → GtfsPathway collection (10,221 rows)
 * Core indoor navigation graph: elevator, stairs, fare gates.
 * Run: npx ts-node src/scripts/import-gtfs-pathways.ts
 */

import "dotenv/config";
import fs from "fs";
import path from "path";
import readline from "readline";
import mongoose from "mongoose";
import { GtfsPathway } from "../model/gtfs-pathway.model";
import { GTFS_DIR } from "../constants/gtfs";

const BATCH = 1000;

async function main() {
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) throw new Error("DATABASE_URL is required");
  await mongoose.connect(dbUrl);
  console.log("Connected to MongoDB");

  const filePath = path.join(GTFS_DIR, "pathways.txt");
  const rl = readline.createInterface({
    input: fs.createReadStream(filePath),
    crlfDelay: Infinity,
  });

  let headers: string[] = [];
  let batch: Parameters<typeof GtfsPathway.bulkWrite>[0] = [];
  let total = 0;
  const start = Date.now();

  for await (const line of rl) {
    if (!headers.length) {
      headers = line.replace(/^﻿/, "").split(",");
      continue;
    }
    const values = line.split(",");
    const row: Record<string, string> = {};
    headers.forEach((h, i) => (row[h] = values[i]?.trim() ?? ""));

    if (!row.pathway_id) continue;

    const traversalTime = row.traversal_time
      ? parseFloat(row.traversal_time)
      : undefined;
    const stairCount = row.stair_count
      ? parseInt(row.stair_count, 10)
      : undefined;

    batch.push({
      updateOne: {
        filter: { pathwayId: row.pathway_id },
        update: {
          $set: {
            pathwayId: row.pathway_id,
            fromStopId: row.from_stop_id,
            toStopId: row.to_stop_id,
            pathwayMode: parseInt(row.pathway_mode, 10) as
              1 | 2 | 3 | 4 | 5 | 6 | 7,
            isBidirectional: parseInt(row.is_bidirectional, 10) as 0 | 1,
            traversalTime:
              traversalTime !== undefined && !isNaN(traversalTime)
                ? traversalTime
                : undefined,
            stairCount:
              stairCount !== undefined && !isNaN(stairCount)
                ? stairCount
                : undefined,
          },
        },
        upsert: true,
      },
    });

    if (batch.length >= BATCH) {
      await GtfsPathway.bulkWrite(batch, { ordered: false });
      total += batch.length;
      batch = [];
    }
  }

  if (batch.length) {
    await GtfsPathway.bulkWrite(batch, { ordered: false });
    total += batch.length;
  }

  const elapsed = ((Date.now() - start) / 1000).toFixed(1);
  console.log(`✓ GtfsPathway: ${total} upserted, ${elapsed}s`);
  await mongoose.disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
