import "dotenv/config";
import fs from "fs";
import { parseCsvLine } from "../utils/csv";
import path from "path";
import mongoose from "mongoose";
import { replaceSnapshot } from "./replace-snapshot";
import BathroomModel from "../model/bathroom.model";

const DEFAULT_CSV = path.resolve(
  __dirname,
  "../../data/bathrooms/無障礙廁所.csv",
);

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

export async function main() {
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) throw new Error("DATABASE_URL env var is required");

  const csvPath = process.argv[2] ?? DEFAULT_CSV;
  const raw = fs.readFileSync(csvPath, "utf-8").replace(/^﻿/, "");
  const lines = raw.split(/\r?\n/).filter((l) => l.trim().length > 0);
  const expectedHeader =
    "county,areacode,village,number,name,address,administration,latitude,longitude,grade,type2,type,exec,diaper";
  if (parseCsvLine(lines[0] ?? "").join(",") !== expectedHeader) {
    throw new Error(
      "Unexpected bathroom CSV header; existing snapshot preserved",
    );
  }
  const dataLines = lines.slice(1);

  const docs: NonNullable<ReturnType<typeof rowToDoc>>[] = [];
  let skipped = 0;
  for (const line of dataLines) {
    const doc = rowToDoc(parseCsvLine(line));
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
