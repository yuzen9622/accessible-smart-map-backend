/**
 * Snapshot import: national disability welfare institutions → MongoDB.
 *
 * Downloads 衛福部社家署「全國身心障礙福利機構一覽表」 (see
 * mohw-welfare.adapter.ts) unless a UTF-8 CSV path is passed for an offline
 * re-run. The CSV has no coordinates, only addresses, so each row is
 * forward-geocoded via the existing Google adapter (`getCoordinates`).
 *
 * Run: pnpm import:welfare [path-to-csv]
 */

import "dotenv/config";
import fs from "fs";
import mongoose from "mongoose";
import WelfareModel from "../model/welfare.model";
import { IWelfare } from "../types";
import { parseCsvLine } from "../utils/csv";
import { rowToWelfare } from "./welfare-parse";
import { getCoordinates } from "../adapters/google.adapter";
import { fetchWelfareCsv } from "../adapters/mohw-welfare.adapter";
import { replaceSnapshot } from "./replace-snapshot";

const EXPECTED_HEADER =
  "機構名稱,縣市,鄉鎮市區,地址,連絡電話,機構類型,核定服務人數(住宿),核定服務人數(夜間),核定服務人數(日間),實際服務人數(住宿),實際服務人數(夜間),實際服務人數(日間),評鑑屆次,最近1次評鑑等第";

function sleep(ms: number) {
  return new Promise<void>((r) => setTimeout(r, ms));
}

async function main() {
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) throw new Error("DATABASE_URL env var is required");
  if (!process.env.GOOGLE_MAPS_API_KEY) {
    throw new Error("GOOGLE_MAPS_API_KEY env var is required for geocoding");
  }

  const csvPath = process.argv[2];
  const raw = (
    csvPath ? fs.readFileSync(csvPath, "utf-8") : await fetchWelfareCsv()
  ).replace(/^\uFEFF/, "");
  const lines = raw.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (parseCsvLine(lines[0] ?? "").join(",") !== EXPECTED_HEADER) {
    throw new Error(
      "Unexpected welfare CSV header; existing snapshot preserved",
    );
  }
  const dataLines = lines.slice(1);

  const bases = [];
  let skipped = 0;
  for (const line of dataLines) {
    const b = rowToWelfare(parseCsvLine(line));
    if (b) bases.push(b);
    else skipped++;
  }
  console.log(`Parsed ${bases.length} rows, skipped ${skipped}`);
  if (!bases.length)
    throw new Error(
      "Refusing to import zero valid rows; existing snapshot preserved",
    );

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

  try {
    await mongoose.connect(dbUrl);
    const inserted = await replaceSnapshot(WelfareModel, docs);
    console.log(`✓ Inserted ${inserted} welfare rows`);
  } finally {
    await mongoose.disconnect();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
