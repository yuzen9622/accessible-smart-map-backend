/**
 * Injects trip-level `wheelchair_accessible` into a GTFS feed, keyed solely on
 * `route_type` from routes.txt. Pure CSV transform — no database, no network.
 *
 * Decision table (top-down, and it NEVER writes "2"):
 *   existing "1"      → keep  (TRA WheelChairFlag / official TRTC feed measured)
 *   route_type "1"    → "1"   (metro / light rail / gondola are step-free)
 *   route_type "3"    → "0"   (bus: unknown, per-vehicle and unknowable here)
 *   anything else     → "0"   (unknown; also normalises stray "2" downward)
 *
 * Writing "2" (inaccessible) is what this script exists to avoid: OTP's
 * router-config sets `wheelchairAccessibility.trip.inaccessibleCost = 3600`,
 * so a guessed "2" adds an hour of penalty per trip and pushes wheelchair
 * journeys off an entire city's bus network. Unknown ≠ inaccessible.
 */
import "dotenv/config";
import fs from "fs";
import path from "path";
import { execSync, execFileSync } from "child_process";

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

export interface TripA11yCounts {
  preserved: number;
  railAccessible: number;
  busUnknown: number;
  otherUnknown: number;
}

/**
 * Applies the wheelchair_accessible decision table to trips.txt rows in place.
 *
 * @param headers trips.txt headers; wheelchair_accessible is appended if absent
 * @param rows trips.txt rows, mutated in place
 * @param routeType route_id to route_type index built from routes.txt
 * @returns Per-branch counts for the run summary
 */
export function applyTripA11y(
  headers: string[],
  rows: Record<string, string>[],
  routeType: Map<string, string>,
): TripA11yCounts {
  if (!headers.includes("wheelchair_accessible")) {
    headers.push("wheelchair_accessible");
  }

  const counts: TripA11yCounts = {
    preserved: 0,
    railAccessible: 0,
    busUnknown: 0,
    otherUnknown: 0,
  };

  for (const r of rows) {
    if (!r.trip_id) continue;

    const rt = routeType.get(r.route_id) ?? "";
    if (rt === "1") {
      r.wheelchair_accessible = "1";
      counts.railAccessible++;
    } else if (rt === "3") {
      // Buses are uniformly reset to "0" (unknown) — even if an upstream feed
      // or prior heuristic set "1" or "2", the bus domain stays strictly unknown.
      r.wheelchair_accessible = "0";
      counts.busUnknown++;
    } else if (r.wheelchair_accessible === "1") {
      // Preserved non-bus feeds (e.g. TRA rail trips injected by inject-tra-gtfs.py)
      counts.preserved++;
    } else {
      r.wheelchair_accessible = "0";
      counts.otherUnknown++;
    }
  }

  return counts;
}

function readFromZip(zipPath: string, entry: string): string {
  try {
    // execFileSync, not execSync: no shell, so the paths cannot be interpreted
    // as commands regardless of what the operator passes on the CLI.
    return execFileSync("unzip", ["-p", zipPath, entry], {
      encoding: "utf-8",
      maxBuffer: 100 * 1024 * 1024,
    });
  } catch (err) {
    console.error(`Failed to extract ${entry} from zip:`, err);
    process.exit(1);
  }
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

  // 1. routes.txt -> route_id to route_type index
  console.log(`Reading routes.txt from ${path.basename(zipPath)}...`);
  const routeType = new Map<string, string>();
  for (const r of parseCSV(readFromZip(zipPath, "routes.txt")).rows) {
    if (r.route_id) routeType.set(r.route_id, (r.route_type ?? "").trim());
  }
  console.log(`Indexed ${routeType.size} routes from routes.txt.`);

  // 2. trips.txt -> apply the decision table
  console.log(`Extracting trips.txt from ${path.basename(zipPath)}...`);
  const { headers, rows } = parseCSV(readFromZip(zipPath, "trips.txt"));
  const counts = applyTripA11y(headers, rows, routeType);

  console.log(
    `wheelchair_accessible: preserved=1 on ${counts.preserved} trips, ` +
      `set 1 on ${counts.railAccessible} rail (route_type=1) trips, ` +
      `set 0 (unknown) on ${counts.busUnknown} bus + ${counts.otherUnknown} other trips. ` +
      `Never writes 2 (inaccessible).`,
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

  console.log("Done.");
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
