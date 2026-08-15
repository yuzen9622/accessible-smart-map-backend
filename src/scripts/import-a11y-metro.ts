import "dotenv/config";
import fs from "fs";
import path from "path";
import mongoose from "mongoose";
import A11y from "../model/a11y.model";
import { parseCsvLine } from "../utils/csv";
import { rowToMetroA11yDoc } from "./metro-a11y-parse";

/**
 * One-shot import: Taipei Metro exit accessibility facilities (elevators /
 * ramps with GPS coordinates) → the legacy Accessibility collection, which
 * powers the `metro` source of /a11y nearby & all-facilities endpoints.
 *
 * Source: 臺北市資料大平臺「臺北捷運車站出入口無障礙電梯、無障礙坡道GPS座標」
 * (upstream CSV is Big5; the copy under data/metro-a11y/ is UTF-8 — see
 * metro-a11y-parse.ts header for URLs). Snapshot import: clears the
 * collection and re-inserts every row.
 *
 * Run: pnpm import:a11y-metro
 */

const DEFAULT_CSV = path.resolve(
  __dirname,
  "../../data/metro-a11y/捷運車站出入口無障礙電梯、無障礙坡道GPS座標.csv",
);

async function main() {
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) throw new Error("DATABASE_URL env var is required");

  const csvPath = process.argv[2] ?? DEFAULT_CSV;
  const raw = fs.readFileSync(csvPath, "utf-8").replace(/^\uFEFF/, "");
  const lines = raw.split(/\r?\n/).filter((l) => l.trim().length > 0);
  const dataLines = lines.slice(1); // header: 項次,出入口電梯/無障礙坡道名稱,出入口編號,經度,緯度

  const docs: NonNullable<ReturnType<typeof rowToMetroA11yDoc>>[] = [];
  let skipped = 0;
  for (const line of dataLines) {
    const doc = rowToMetroA11yDoc(parseCsvLine(line));
    if (doc) docs.push(doc);
    else skipped++;
  }
  console.log(`Parsed ${docs.length} rows, skipped ${skipped}`);

  await mongoose.connect(dbUrl);
  console.log("Connected to MongoDB");

  const del = await A11y.deleteMany({});
  console.log(`Cleared ${del.deletedCount} existing accessibility rows`);

  const CHUNK = 500;
  let inserted = 0;
  for (let i = 0; i < docs.length; i += CHUNK) {
    const batch = await A11y.insertMany(docs.slice(i, i + CHUNK) as any[], {
      ordered: false,
    });
    inserted += batch.length;
  }

  console.log(`Inserted ${inserted} metro accessibility rows`);
  await mongoose.disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
