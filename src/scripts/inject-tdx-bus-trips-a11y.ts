import "dotenv/config";
import fs from "fs";
import path from "path";
import { execSync } from "child_process";
import mongoose from "mongoose";
import BusVehicleModel from "../model/bus-vehicle.model";

function parseCSV(csvText: string): {
  headers: string[];
  rows: Record<string, string>[];
} {
  const lines = csvText.split(/\r?\n/);
  if (lines.length === 0 || !lines[0].trim()) {
    return { headers: [], rows: [] };
  }

  const parseLine = (line: string): string[] => {
    const result: string[] = [];
    let current = "";
    let inQuotes = false;
    for (let i = 0; i < line.length; i++) {
      const char = line[i];
      if (char === '"') {
        inQuotes = !inQuotes;
      } else if (char === "," && !inQuotes) {
        result.push(current.trim());
        current = "";
      } else {
        current += char;
      }
    }
    result.push(current.trim());
    return result;
  };

  const headers = parseLine(lines[0].replace(/^﻿/, ""));
  const rows: Record<string, string>[] = [];

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) continue;
    const values = parseLine(line);
    const row: Record<string, string> = {};
    headers.forEach((h, idx) => {
      row[h] = values[idx] ?? "";
    });
    rows.push(row);
  }

  return { headers, rows };
}

function stringifyCSV(
  headers: string[],
  rows: Record<string, string>[],
): string {
  const headerLine = headers.join(",");
  const lines = rows.map((row) =>
    headers
      .map((h) => {
        const val = row[h] ?? "";
        return val.includes(",") || val.includes('"')
          ? `"${val.replace(/"/g, '""')}"`
          : val;
      })
      .join(","),
  );
  return [headerLine, ...lines].join("\n");
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length < 1) {
    console.error(
      "Usage: npx ts-node src/scripts/inject-tdx-bus-trips-a11y.ts <gtfs-zip-path>",
    );
    process.exit(1);
  }

  const zipPath = path.resolve(args[0]);
  if (!fs.existsSync(zipPath)) {
    console.error(`Error: File not found: ${zipPath}`);
    process.exit(1);
  }

  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) {
    console.error("Error: DATABASE_URL environment variable is required.");
    process.exit(1);
  }

  console.log("Connecting to MongoDB to read bus vehicle stats...");
  await mongoose.connect(dbUrl);
  console.log("Connected to MongoDB.");

  // 1. Calculate low floor ratio for each city based on BusVehicle collection
  const cities = [
    "Taipei",
    "NewTaipei",
    "Taoyuan",
    "Taichung",
    "Tainan",
    "Kaohsiung",
  ];
  const cityRatios: Record<string, number> = {};

  for (const city of cities) {
    const total = await BusVehicleModel.countDocuments({ city });
    const lowFloor = await BusVehicleModel.countDocuments({
      city,
      isLowFloor: 1,
    });
    cityRatios[city] = total > 0 ? lowFloor / total : 0;
    console.log(
      `  City ${city}: low floor ratio = ${(cityRatios[city] * 100).toFixed(1)}% (${lowFloor}/${total})`,
    );
  }

  // 2. Extract trips.txt from GTFS zip
  console.log(`Extracting trips.txt from ${path.basename(zipPath)}...`);
  let tripsCSV: string;
  try {
    tripsCSV = execSync(`unzip -p "${zipPath}" trips.txt`, {
      encoding: "utf-8",
      maxBuffer: 100 * 1024 * 1024,
    });
  } catch (err) {
    console.error("Failed to extract trips.txt from zip:", err);
    await mongoose.disconnect();
    process.exit(1);
  }

  const { headers, rows } = parseCSV(tripsCSV);
  if (!headers.includes("wheelchair_accessible")) {
    headers.push("wheelchair_accessible");
  }

  // Prefix mapping to city keys
  const prefixMap: Record<string, string> = {
    TPE: "Taipei",
    NWT: "NewTaipei",
    TYC: "Taoyuan",
    TXG: "Taichung",
    TNN: "Tainan",
    KHH: "Kaohsiung",
  };

  let accessibleCount = 0;
  let inaccessibleCount = 0;
  let unchangedCount = 0;

  for (const r of rows) {
    if (!r.trip_id) continue;

    // Preserve existing flags (e.g. 台鐵 trips injected by inject-tra-gtfs.py)
    if (r.wheelchair_accessible === "1" || r.wheelchair_accessible === "2") {
      unchangedCount++;
      continue;
    }

    // Determine city based on prefix in trip_id
    // e.g. TPE10873_00... -> TPE -> Taipei
    const prefix = r.trip_id.substring(0, 3);
    const city = prefixMap[prefix];

    if (city) {
      const ratio = cityRatios[city] ?? 0;
      // Heuristic: If city low-floor ratio > 70%, mark as accessible (1).
      // If < 30%, mark as inaccessible (2). Otherwise leave as unknown (0).
      if (ratio > 0.7) {
        r.wheelchair_accessible = "1";
        accessibleCount++;
      } else if (ratio < 0.3 && ratio > 0) {
        r.wheelchair_accessible = "2";
        inaccessibleCount++;
      } else {
        r.wheelchair_accessible = "0";
        unchangedCount++;
      }
    } else {
      r.wheelchair_accessible = "0";
      unchangedCount++;
    }
  }

  console.log(
    `Updated wheelchair_accessible=1 on ${accessibleCount} trips, set to 2 on ${inaccessibleCount} trips, left ${unchangedCount} trips unchanged.`,
  );

  // 3. Write updated trips.txt back to ZIP
  const updatedCSV = stringifyCSV(headers, rows);
  const tempDir = path.join(__dirname, "../../tmp");
  if (!fs.existsSync(tempDir)) {
    fs.mkdirSync(tempDir, { recursive: true });
  }
  const tempFilePath = path.join(tempDir, "trips.txt");
  fs.writeFileSync(tempFilePath, updatedCSV, "utf-8");

  console.log("Injecting updated trips.txt back into GTFS zip...");
  try {
    execSync(`zip -ju "${zipPath}" "${tempFilePath}"`);
    console.log("Successfully injected updated trips.txt back into the zip.");
  } catch (err) {
    console.error("Failed to inject trips.txt into zip:", err);
  } finally {
    if (fs.existsSync(tempFilePath)) {
      fs.unlinkSync(tempFilePath);
    }
  }

  await mongoose.disconnect();
  console.log("Disconnected from MongoDB. Done.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
