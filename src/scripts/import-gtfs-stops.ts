/**
 * Import stops.txt → GtfsStop collection (161,636 rows)
 * Run: npx ts-node src/scripts/import-gtfs-stops.ts
 */

import "dotenv/config";
import fs from "fs";
import path from "path";
import readline from "readline";
import mongoose from "mongoose";
import { GtfsStop } from "../model/gtfs-stop.model";
import { GTFS_DIR } from "../constants/gtfs";

const BATCH = 1000;

function parseLine(headers: string[], values: string[]) {
  const row: Record<string, string> = {};
  headers.forEach((h, i) => (row[h] = values[i]?.trim() ?? ""));
  return row;
}

async function main() {
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) throw new Error("DATABASE_URL is required");
  await mongoose.connect(dbUrl);
  console.log("Connected to MongoDB");

  const filePath = path.join(GTFS_DIR, "stops.txt");
  const rl = readline.createInterface({
    input: fs.createReadStream(filePath),
    crlfDelay: Infinity,
  });

  let headers: string[] = [];
  let batch: Parameters<typeof GtfsStop.bulkWrite>[0] = [];
  let total = 0;
  let errors = 0;
  const start = Date.now();

  for await (const line of rl) {
    if (!headers.length) {
      headers = line.replace(/^﻿/, "").split(",");
      continue;
    }
    const values = line.split(",");
    const row = parseLine(headers, values);

    const locationType = parseInt(row.location_type || "0", 10) as
      0 | 1 | 2 | 3;

    const hasCoords =
      !isNaN(parseFloat(row.stop_lat)) && !isNaN(parseFloat(row.stop_lon));
    if (!row.stop_id) continue;
    if (locationType === 0 && !hasCoords) continue;
    const lat = hasCoords ? parseFloat(row.stop_lat) : 0;
    const lon = hasCoords ? parseFloat(row.stop_lon) : 0;

    batch.push({
      updateOne: {
        filter: { stopId: row.stop_id },
        update: {
          $set: {
            stopId: row.stop_id,
            stopName: row.stop_name,
            stopLat: lat,
            stopLon: lon,
            zoneId: row.zone_id || undefined,
            locationType,
            parentStation: row.parent_station || undefined,
            levelId: row.level_id || undefined,
            location: { type: "Point", coordinates: [lon, lat] },
          },
        },
        upsert: true,
      },
    });

    if (batch.length >= BATCH) {
      try {
        await GtfsStop.bulkWrite(batch, { ordered: false });
        total += batch.length;
      } catch {
        errors += batch.length;
      }
      batch = [];
      if (total % 10000 === 0) process.stdout.write(`  ${total}...\r`);
    }
  }

  if (batch.length) {
    await GtfsStop.bulkWrite(batch, { ordered: false });
    total += batch.length;
  }

  const elapsed = ((Date.now() - start) / 1000).toFixed(1);
  console.log(`\n✓ GtfsStop: ${total} upserted, ${errors} errors, ${elapsed}s`);
  await mongoose.disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
