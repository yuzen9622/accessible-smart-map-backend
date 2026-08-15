/**
 * Run the GTFS Mongo import scripts in dependency order.
 * Recommended to run individual scripts first to verify, then use this for a full refresh.
 *
 * Only the collections the live server still reads are imported:
 *   levels    (no deps)        — indoor graph
 *   stops     (refs levels)    — indoor graph (station/entrance/platform nodes)
 *   trips     (no runtime deps)— OTP direction_id lookup
 *   pathways  (refs stops)     — indoor graph
 *
 * The schedule tables (routes/calendar/frequencies/stop_times/shapes) backed the
 * retired in-Mongo GTFS router and are no longer imported — OTP reads the GTFS
 * feed files (data/gtfs) directly.
 *
 * Run: npx ts-node --max-old-space-size=2048 src/scripts/import-gtfs-all.ts
 */

import { execFile } from "child_process";
import path from "path";
import { promisify } from "util";

const execFileAsync = promisify(execFile);

const SCRIPTS = [
  "import-gtfs-levels.ts",
  "import-gtfs-stops.ts",
  "import-gtfs-trips.ts",
  "import-gtfs-pathways.ts",
];

async function runScript(scriptName: string): Promise<void> {
  const scriptPath = path.resolve(__dirname, scriptName);
  console.log(`\n▶ ${scriptName}`);
  const start = Date.now();

  const { stdout, stderr } = await execFileAsync(
    "node",
    ["--max-old-space-size=2048", "-r", "ts-node/register", scriptPath],
    {
      env: { ...process.env },
      maxBuffer: 10 * 1024 * 1024,
    },
  );

  if (stdout) process.stdout.write(stdout);
  if (stderr) process.stderr.write(stderr);

  const elapsed = ((Date.now() - start) / 1000).toFixed(1);
  console.log(`  Done in ${elapsed}s`);
}

async function main() {
  console.log("=== GTFS Full Import ===");
  console.log(`Scripts: ${SCRIPTS.length}`);

  const overallStart = Date.now();

  for (const script of SCRIPTS) {
    try {
      await runScript(script);
    } catch (err) {
      console.error(`✗ ${script} failed:`, (err as Error).message);
      console.error("Continuing with next script...");
    }
  }

  const totalElapsed = ((Date.now() - overallStart) / 1000 / 60).toFixed(1);
  console.log(`\n=== Import complete in ${totalElapsed} min ===`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
