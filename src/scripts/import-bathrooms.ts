import "dotenv/config";
import fs from "fs";
import path from "path";
import mongoose from "mongoose";
import BathroomModel from "../model/bathroom.model";

const DEFAULT_CSV = path.resolve(
  __dirname,
  "../../data/bathrooms/無障礙廁所.csv",
);

function parseCsvLine(line: string): string[] {
  const fields: string[] = [];
  let current = "";
  let inQuotes = false;
  for (const ch of line) {
    if (ch === '"') {
      inQuotes = !inQuotes;
    } else if (ch === "," && !inQuotes) {
      fields.push(current);
      current = "";
    } else {
      current += ch;
    }
  }
  fields.push(current);
  return fields;
}

function rowToDoc(fields: string[]) {
  const [
    county,
    areacode,
    village,
    number,
    name,
    address,
    administration,
    latStr,
    lngStr,
    grade,
    type2,
    type,
    exec,
    diaper,
  ] = fields;

  let latitude = parseFloat(latStr);
  let longitude = parseFloat(lngStr);
  if (!name || isNaN(latitude) || isNaN(longitude)) return null;

  if (latitude > 90) [latitude, longitude] = [longitude, latitude];

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

async function main() {
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) throw new Error("DATABASE_URL env var is required");

  const csvPath = process.argv[2] ?? DEFAULT_CSV;
  const raw = fs.readFileSync(csvPath, "utf-8").replace(/^﻿/, "");
  const lines = raw.split(/\r?\n/).filter((l) => l.trim().length > 0);
  const dataLines = lines.slice(1);

  const docs: ReturnType<typeof rowToDoc>[] = [];
  let skipped = 0;
  for (const line of dataLines) {
    const doc = rowToDoc(parseCsvLine(line));
    if (doc) docs.push(doc);
    else skipped++;
  }
  console.log(`Parsed ${docs.length} rows, skipped ${skipped}`);

  await mongoose.connect(dbUrl);
  console.log("Connected to MongoDB");

  const del = await BathroomModel.deleteMany({});
  console.log(`Cleared ${del.deletedCount} existing bathroom rows`);

  const CHUNK = 500;
  let inserted = 0;
  for (let i = 0; i < docs.length; i += CHUNK) {
    const batch = await BathroomModel.insertMany(
      docs.slice(i, i + CHUNK) as any[],
      { ordered: false },
    );
    inserted += batch.length;
  }

  console.log(`Inserted ${inserted} bathroom rows`);
  await mongoose.disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
