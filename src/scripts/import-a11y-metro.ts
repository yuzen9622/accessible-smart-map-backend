import "dotenv/config";
import fs from "fs";
import path from "path";
import mongoose from "mongoose";
import { replaceSnapshot } from "./replace-snapshot";
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
 * metro-a11y-parse.ts header for URLs). Snapshot import: validates a staging
 * collection before atomically replacing the previous snapshot.
 *
 * Run: pnpm import:a11y-metro
 */

const DEFAULT_CSV = path.resolve(
  __dirname,
  "../../data/metro-a11y/捷運車站出入口無障礙電梯、無障礙坡道GPS座標.csv",
);

export async function main() {
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) throw new Error("DATABASE_URL env var is required");

  const csvPath = process.argv[2] ?? DEFAULT_CSV;
  const raw = fs.readFileSync(csvPath, "utf-8").replace(/^\uFEFF/, "");
  const lines = raw.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (
    parseCsvLine(lines[0] ?? "").join(",") !==
    "項次,出入口電梯/無障礙坡道名稱,出入口編號,經度,緯度"
  ) {
    throw new Error("Unexpected metro CSV header; existing snapshot preserved");
  }
  const dataLines = lines.slice(1); // header: 項次,出入口電梯/無障礙坡道名稱,出入口編號,經度,緯度

  const docs: NonNullable<ReturnType<typeof rowToMetroA11yDoc>>[] = [];
  let skipped = 0;
  for (const line of dataLines) {
    const doc = rowToMetroA11yDoc(parseCsvLine(line));
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
    const inserted = await replaceSnapshot(A11y, docs);
    console.log(`Inserted ${inserted} metro accessibility rows`);
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
