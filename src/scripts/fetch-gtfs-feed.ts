/**
 * Refresh data/gtfs from the TDX national GTFS feed: download, extract the four
 * tables the Mongo `import:gtfs-*` scripts read, add the generated `P_*` parent
 * stations, validate, then move them over the live files. Everything up to the
 * final rename happens in a staging directory, so a failed download or a
 * malformed feed leaves the previous files untouched.
 *
 * Run: pnpm fetch:gtfs
 */

import "dotenv/config";
import { spawnSync } from "child_process";
import fs from "fs";
import path from "path";
import readline from "readline";
import { GTFS_DIR } from "../constants/gtfs";
import { downloadNationalGtfs } from "../adapters/tdx-gtfs.adapter";
import { addParentStations } from "./generate-gtfs-parents";

/** Columns each imported table must carry; the first one is the row id. */
export const GTFS_REQUIRED_COLUMNS: Record<string, readonly string[]> = {
  "levels.txt": ["level_id", "level_index"],
  "stops.txt": ["stop_id", "stop_name", "stop_lat", "stop_lon"],
  "trips.txt": ["trip_id", "route_id", "service_id"],
  "pathways.txt": [
    "pathway_id",
    "from_stop_id",
    "to_stop_id",
    "pathway_mode",
    "is_bidirectional",
  ],
};

/**
 * @param filePath A GTFS table.
 * @param required Required columns; the first is the row id.
 * @returns Why the table cannot be imported, or null when it has the required
 *          columns and at least one row with an id.
 */
export async function findGtfsTableProblem(
  filePath: string,
  required: readonly string[],
): Promise<string | null> {
  if (!fs.existsSync(filePath)) return "missing";
  const lines = readline.createInterface({
    input: fs.createReadStream(filePath),
    crlfDelay: Infinity,
  });
  let header: string[] | null = null;
  try {
    for await (const line of lines) {
      if (!line.trim()) continue;
      if (!header) {
        const columns = line.replace(/^\uFEFF/, "").split(",");
        const missing = required.filter((c) => !columns.includes(c));
        if (missing.length) return `missing columns ${missing.join(", ")}`;
        header = columns;
        continue;
      }
      const id = line.split(",")[header.indexOf(required[0])]?.trim();
      if (id) return null;
    }
  } finally {
    lines.close();
  }
  return header ? "no rows" : "empty";
}

async function main(): Promise<void> {
  // data/ is untracked, so a fresh clone has no parent for the staging dir.
  fs.mkdirSync(path.dirname(GTFS_DIR), { recursive: true });
  const staging = fs.mkdtempSync(`${GTFS_DIR}.staging-`);
  try {
    const zipPath = path.join(staging, "feed.zip");
    console.log("Downloading TDX national GTFS feed…");
    await downloadNationalGtfs(zipPath);
    console.log(
      `Downloaded ${(fs.statSync(zipPath).size / 1e6).toFixed(0)} MB`,
    );

    const tables = Object.keys(GTFS_REQUIRED_COLUMNS);
    const unzip = spawnSync(
      "unzip",
      ["-o", "-j", "-q", zipPath, ...tables, "-d", staging],
      { stdio: "inherit" },
    );
    if (unzip.error) throw unzip.error;
    if (unzip.status !== 0)
      throw new Error(`unzip exited ${unzip.status}; data/gtfs left unchanged`);
    fs.rmSync(zipPath);

    addParentStations(path.join(staging, "stops.txt"));

    const problems: string[] = [];
    for (const table of tables) {
      const problem = await findGtfsTableProblem(
        path.join(staging, table),
        GTFS_REQUIRED_COLUMNS[table],
      );
      if (problem) problems.push(`${table}: ${problem}`);
    }
    if (problems.length)
      throw new Error(
        `GTFS feed rejected (${problems.join("; ")}); data/gtfs left unchanged`,
      );

    fs.mkdirSync(GTFS_DIR, { recursive: true });
    for (const table of tables) {
      fs.renameSync(path.join(staging, table), path.join(GTFS_DIR, table));
    }
    console.log(`Updated ${tables.join(", ")} in ${GTFS_DIR}`);
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
}

if (require.main === module) {
  main().catch((err: unknown) => {
    console.error(err);
    process.exitCode = 1;
  });
}
