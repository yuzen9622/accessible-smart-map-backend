/**
 * Snapshot import: accessible toilets → MongoDB.
 *
 * Downloads 環境部「全國公廁建檔資料」 (see moenv-toilet.adapter.ts) unless a CSV
 * with the same columns is passed for an offline re-run.
 *
 * Run: pnpm import:bathrooms [path-to-csv]
 */

import "dotenv/config";
import fs from "fs";
import { parseCsvLine } from "../utils/csv";
import mongoose from "mongoose";
import { replaceSnapshot } from "./replace-snapshot";
import BathroomModel from "../model/bathroom.model";
import {
  fetchAccessibleToilets,
  isAccessibleToilet,
  MOENV_TOILET_FIELDS,
  type MoenvToiletRow,
} from "../adapters/moenv-toilet.adapter";

function rowToDoc(row: MoenvToiletRow) {
  const {
    county,
    areacode,
    village,
    number,
    name,
    address,
    administration,
    latitude: latStr,
    longitude: lngStr,
    grade,
    type2,
    type,
    exec,
    diaper,
  } = row;

  let latitude = parseFloat(latStr);
  let longitude = parseFloat(lngStr);
  if (!name || !Number.isFinite(latitude) || !Number.isFinite(longitude))
    return null;

  if (latitude > 90) [latitude, longitude] = [longitude, latitude];
  if (Math.abs(latitude) > 90 || Math.abs(longitude) > 180) return null;

  return {
    county,
    areacode,
    village,
    number,
    name,
    address,
    administration,
    latitude,
    longitude,
    location: { type: "Point" as const, coordinates: [longitude, latitude] },
    grade,
    type2,
    type,
    exec,
    diaper,
  };
}

function readCsvRows(csvPath: string): MoenvToiletRow[] {
  const raw = fs.readFileSync(csvPath, "utf-8").replace(/^\uFEFF/, "");
  const lines = raw.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (
    parseCsvLine(lines[0] ?? "").join(",") !== MOENV_TOILET_FIELDS.join(",")
  ) {
    throw new Error(
      "Unexpected bathroom CSV header; existing snapshot preserved",
    );
  }
  return lines.slice(1).map((line) => {
    const fields = parseCsvLine(line);
    return Object.fromEntries(
      MOENV_TOILET_FIELDS.map((key, i) => [key, fields[i] ?? ""]),
    ) as MoenvToiletRow;
  });
}

export async function main() {
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) throw new Error("DATABASE_URL env var is required");

  const csvPath = process.argv[2];
  let rows: MoenvToiletRow[];
  if (csvPath) {
    rows = readCsvRows(csvPath).filter(isAccessibleToilet);
  } else {
    const apiKey = process.env.MOENV_API_KEY;
    if (!apiKey) throw new Error("MOENV_API_KEY env var is required");
    rows = await fetchAccessibleToilets(apiKey);
  }
  console.log(`Fetched ${rows.length} accessible toilets`);

  const docs: NonNullable<ReturnType<typeof rowToDoc>>[] = [];
  let skipped = 0;
  for (const row of rows) {
    const doc = rowToDoc(row);
    if (doc) docs.push(doc);
    else skipped++;
  }
  console.log(`Parsed ${docs.length} rows, skipped ${skipped}`);

  if (!docs.length)
    throw new Error(
      "Refusing to import zero valid rows; existing snapshot preserved",
    );

  try {
    await mongoose.connect(dbUrl);
    const inserted = await replaceSnapshot(BathroomModel, docs);
    console.log(`Inserted ${inserted} bathroom rows`);
  } finally {
    await mongoose.disconnect();
  }
}

if (require.main === module) {
  void main().catch((err: unknown) => {
    console.error(err);
    process.exitCode = 1;
  });
}
