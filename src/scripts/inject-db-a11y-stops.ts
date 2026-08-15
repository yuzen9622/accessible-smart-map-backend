import "dotenv/config";
import fs from "fs";
import path from "path";
import { execSync } from "child_process";
import mongoose from "mongoose";
import A11y from "../model/a11y.model";

// Haversine formula for distance between two coordinates in meters
function haversineDistance(
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number,
): number {
  const R = 6371e3; // Earth radius in meters
  const phi1 = (lat1 * Math.PI) / 180;
  const phi2 = (lat2 * Math.PI) / 180;
  const deltaPhi = ((lat2 - lat1) * Math.PI) / 180;
  const deltaLambda = ((lon2 - lon1) * Math.PI) / 180;

  const a =
    Math.sin(deltaPhi / 2) * Math.sin(deltaPhi / 2) +
    Math.cos(phi1) *
      Math.cos(phi2) *
      Math.sin(deltaLambda / 2) *
      Math.sin(deltaLambda / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));

  return R * c; // in meters
}

function parseCSV(csvText: string): {
  headers: string[];
  rows: Record<string, string>[];
} {
  // Simple CSV parser supporting quotes
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
      "Usage: npx ts-node src/scripts/inject-db-a11y-stops.ts <gtfs-zip-path>",
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

  console.log(`Connecting to MongoDB...`);
  await mongoose.connect(dbUrl);
  console.log("Connected to MongoDB.");

  // 1. Fetch all A11y accessibility elevator/ramp records
  console.log("Fetching accessibilities from database...");
  const a11yRecords = await A11y.find().lean();
  console.log(
    `Loaded ${a11yRecords.length} accessibility coordinates from database.`,
  );

  if (a11yRecords.length === 0) {
    console.log("No accessibility records found in database. Exiting.");
    await mongoose.disconnect();
    return;
  }

  // 2. Extract stops.txt from GTFS zip via stdout
  console.log(`Extracting stops.txt from ${path.basename(zipPath)}...`);
  let stopsCSV: string;
  try {
    stopsCSV = execSync(`unzip -p "${zipPath}" stops.txt`, {
      encoding: "utf-8",
      maxBuffer: 50 * 1024 * 1024,
    });
  } catch (err) {
    console.error("Failed to extract stops.txt from zip:", err);
    await mongoose.disconnect();
    process.exit(1);
  }

  const { headers, rows } = parseCSV(stopsCSV);
  if (!headers.includes("wheelchair_boarding")) {
    headers.push("wheelchair_boarding");
  }

  // Find all TRTC stops (which represent stations/stops in this GTFS feed, location_type === "0" or empty)
  const trtcStops = rows.filter(
    (r) =>
      r.stop_id.startsWith("TRTC_") &&
      (r.location_type === "0" || r.location_type === ""),
  );
  console.log(`Found ${trtcStops.length} TRTC stops in stops.txt.`);

  const accessibleStopIds = new Set<string>();

  // 3. Match each TRTC stop against A11y records using spatial proximity
  for (const stop of trtcStops) {
    const lat = parseFloat(stop.stop_lat);
    const lon = parseFloat(stop.stop_lon);
    if (isNaN(lat) || isNaN(lon)) continue;

    // Check if there is any elevator/ramp within 200 meters in the database
    const hasNearbyFacility = a11yRecords.some((rec) => {
      const recLng = rec.location.coordinates[0];
      const recLat = rec.location.coordinates[1];
      const distance = haversineDistance(lat, lon, recLat, recLng);
      return distance < 200; // 200 meters matching threshold
    });

    if (hasNearbyFacility) {
      accessibleStopIds.add(stop.stop_id);
    }
  }

  console.log(
    `Matched ${accessibleStopIds.size} accessible TRTC stops based on database coordinates.`,
  );

  // 4. Update wheelchair_boarding for matched stops and any parent/child associations
  let updatedCount = 0;
  for (const r of rows) {
    const isMatched = accessibleStopIds.has(r.stop_id);
    const isChildOfMatched =
      r.parent_station && accessibleStopIds.has(r.parent_station);

    if (isMatched || isChildOfMatched) {
      r.wheelchair_boarding = "1";
      updatedCount++;
    }
  }

  console.log(`Updated wheelchair_boarding=1 on ${updatedCount} stops.`);

  // 5. Write updated stops.txt back to ZIP
  const updatedCSV = stringifyCSV(headers, rows);
  const tempDir = path.join(__dirname, "../../tmp");
  if (!fs.existsSync(tempDir)) {
    fs.mkdirSync(tempDir, { recursive: true });
  }
  const tempFilePath = path.join(tempDir, "stops.txt");
  fs.writeFileSync(tempFilePath, updatedCSV, "utf-8");

  console.log("Injecting updated stops.txt back into GTFS zip...");
  try {
    execSync(`zip -ju "${zipPath}" "${tempFilePath}"`);
    console.log("Successfully injected updated stops.txt back into the zip.");
  } catch (err) {
    console.error("Failed to inject stops.txt into zip:", err);
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
