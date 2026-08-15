/**
 * One-shot import: New Taipei roadside disabled-parking spaces (CSV) → MongoDB.
 *
 * The source CSV has two traps handled here: its X/Y are TWD97/TM2 (EPSG:3826)
 * projected coordinates (reprojected to WGS84), and its header names are shifted
 * one column off the data (so rows are parsed by position, not header name).
 *
 * Run: npm run import:parking [path-to-csv]
 */

import "dotenv/config";
import fs from "fs";
import path from "path";
import mongoose from "mongoose";
import DisabledParkingModel from "../model/disabled-parking.model";
import { IDisabledParking } from "../types";
import { parseCsvLine, rowToParking } from "./disabled-parking-parse";

const DEFAULT_CSV = path.resolve(
  __dirname,
  "../../data/disabled-parking/新北市路邊停車場身心障礙停車格.csv",
);
const CITY = "新北市";

async function main() {
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) throw new Error("DATABASE_URL env var is required");

  const csvPath = process.argv[2] ?? DEFAULT_CSV;
  const raw = fs.readFileSync(csvPath, "utf-8").replace(/^﻿/, "");
  const lines = raw.split(/\r?\n/).filter((l) => l.trim().length > 0);
  const dataLines = lines.slice(1);

  const docs: Omit<IDisabledParking, "_id">[] = [];
  let skipped = 0;
  for (const line of dataLines) {
    const doc = rowToParking(parseCsvLine(line), CITY);
    if (doc) docs.push(doc);
    else skipped++;
  }
  console.log(`Parsed ${docs.length} rows, skipped ${skipped}`);

  await mongoose.connect(dbUrl);
  console.log("Connected to MongoDB");

  const del = await DisabledParkingModel.deleteMany({ city: CITY });
  console.log(`Cleared ${del.deletedCount} existing ${CITY} rows`);

  const CHUNK = 500;
  let inserted = 0;
  for (let i = 0; i < docs.length; i += CHUNK) {
    const batch = await DisabledParkingModel.insertMany(
      docs.slice(i, i + CHUNK),
      { ordered: false },
    );
    inserted += batch.length;
  }

  console.log(`✓ Inserted ${inserted} ${CITY} disabled-parking rows`);
  await mongoose.disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
