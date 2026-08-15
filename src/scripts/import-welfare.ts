/**
 * One-shot import: national disability welfare institutions (CSV) → MongoDB.
 *
 * Source CSV has no coordinates, only addresses, so each row is forward-geocoded
 * via the existing Google adapter (`getCoordinates`). The CSV is committed as
 * UTF-8 under data/welfare/ (converted from Big5 at copy time).
 *
 * Run: npm run import:welfare [path-to-csv]
 */

import "dotenv/config";
import fs from "fs";
import path from "path";
import mongoose from "mongoose";
import WelfareModel from "../model/welfare.model";
import { IWelfare } from "../types";
import { parseCsvLine } from "../utils/csv";
import { rowToWelfare } from "./welfare-parse";
import { getCoordinates } from "../adapters/google.adapter";

const DEFAULT_CSV = path.resolve(
  __dirname,
  "../../data/welfare/全國身心障礙福利機構一覽表.csv",
);

function sleep(ms: number) {
  return new Promise<void>((r) => setTimeout(r, ms));
}

async function main() {
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) throw new Error("DATABASE_URL env var is required");
  if (!process.env.GOOGLE_MAPS_API_KEY) {
    throw new Error("GOOGLE_MAPS_API_KEY env var is required for geocoding");
  }

  const csvPath = process.argv[2] ?? DEFAULT_CSV;
  const raw = fs.readFileSync(csvPath, "utf-8").replace(/^﻿/, "");
  const lines = raw.split(/\r?\n/).filter((l) => l.trim().length > 0);
  const dataLines = lines.slice(1);

  const bases = [];
  let skipped = 0;
  for (const line of dataLines) {
    const b = rowToWelfare(parseCsvLine(line));
    if (b) bases.push(b);
    else skipped++;
  }
  console.log(`Parsed ${bases.length} rows, skipped ${skipped}`);

  const docs: Omit<IWelfare, "_id">[] = [];
  let geocoded = 0;
  let failed = 0;
  for (let i = 0; i < bases.length; i++) {
    const b = bases[i];
    const query = b.address.includes(b.county)
      ? b.address
      : `${b.county}${b.district}${b.address}`;
    let location: IWelfare["location"];
    try {
      const c = await getCoordinates(query);
      if (c) {
        location = { type: "Point", coordinates: [c.longitude, c.latitude] };
        geocoded++;
      } else {
        failed++;
      }
    } catch {
      failed++;
    }
    docs.push({ ...b, geocoded: !!location, location, importedAt: new Date() });
    if ((i + 1) % 25 === 0) {
      console.log(
        `  geocoded ${i + 1}/${bases.length} (ok ${geocoded}, fail ${failed})`,
      );
    }
    await sleep(120);
  }
  console.log(`Geocoding done — ok ${geocoded}, failed ${failed}`);

  await mongoose.connect(dbUrl);
  console.log("Connected to MongoDB");

  const del = await WelfareModel.deleteMany({});
  console.log(`Cleared ${del.deletedCount} existing rows`);

  const inserted = await WelfareModel.insertMany(docs, { ordered: false });
  console.log(`✓ Inserted ${inserted.length} welfare rows`);

  await mongoose.disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
