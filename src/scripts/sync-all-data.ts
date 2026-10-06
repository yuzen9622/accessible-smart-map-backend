/**
 * One command to refresh every imported dataset: Mongo imports, PostGIS curb
 * ramps, Chroma RAG and Valhalla tiles. Runs the existing scripts as child
 * processes in dependency order; the scripts themselves are unchanged.
 *
 * Run: pnpm data:sync                    (base: upsert-only steps)
 *      pnpm data:sync:all                (every group — fresh environment)
 *      pnpm data:sync --with-valhalla --with-snapshot
 *      pnpm data:sync --only=tdx-tra,tdx-thsr
 *      pnpm data:sync --all --skip=rag --plan
 *
 * Groups: base (default) · --with-snapshot (wipe + reinsert) · --with-valhalla
 * (tile rebuild restarts Valhalla) · --with-slow · --with-paid · --all.
 *
 * Before anything runs, every selected step's env/files and every backing
 * service (Mongo, PostGIS, Chroma, docker) are checked; any unmet
 * precondition aborts the run, so a step is never silently skipped. Exit code
 * is 1 if any step failed or was skipped because a dependency failed.
 *
 * Exit 0 from a child means the process finished, not that every record
 * landed — steps with known partial-failure behaviour are listed again in the
 * summary, and Mongo steps get a non-empty-collection check afterwards.
 */

import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import mongoose, { type Model } from "mongoose";
import { Client } from "pg";
import A11yModel from "../model/a11y.model";
import BathroomModel from "../model/bathroom.model";
import BusRouteModel from "../model/bus-route.model";
import BusStopModel from "../model/bus-stop.model";
import BusVehicleModel from "../model/bus-vehicle.model";
import CampusA11yModel from "../model/campus-a11y.model";
import DisabledParkingModel from "../model/disabled-parking.model";
import { GtfsLevel } from "../model/gtfs-level.model";
import { GtfsPathway } from "../model/gtfs-pathway.model";
import { GtfsStop } from "../model/gtfs-stop.model";
import { GtfsTrip } from "../model/gtfs-trip.model";
import MetroStationModel from "../model/metro-station.model";
import OsmA11yModel from "../model/osm-a11y.model";
import ParkAreaModel from "../model/park-area.model";
import ParkEntranceModel from "../model/park-entrance.model";
import TrafficSectionModel from "../model/traffic-section.model";
import TrainStationModel from "../model/train-station.model";
import VisualA11yModel from "../model/visual-a11y.model";
import WelfareModel from "../model/welfare.model";
import {
  dependencySkipReason,
  findStepBlockers,
  parseSyncArgs,
  selectSteps,
  SYNC_STEPS,
  syncExitCode,
  type StepStatus,
  type SyncStep,
} from "./sync-all-data-plan";

const ROOT = path.resolve(__dirname, "../..");
const LOCK_DIR = path.join(ROOT, ".data-sync.lock");
const DEFAULT_PBF_PATH = "./otp-data/taiwan-latest.osm.pbf";
const DEFAULT_PBF_URL =
  "https://download.geofabrik.de/asia/taiwan-latest.osm.pbf";
const DEFAULT_CHROMA_URL = "http://localhost:8100";
const CONNECT_TIMEOUT_MS = 5000;

/** Collections a Mongo step must leave non-empty. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const NON_EMPTY_AFTER: Record<string, Model<any>[]> = {
  "tdx-stops": [BusStopModel],
  "tdx-bus-routes": [BusRouteModel],
  "tdx-bus-vehicles": [BusVehicleModel],
  "city-bus-vehicles": [BusVehicleModel],
  "tdx-metro": [MetroStationModel],
  "tdx-tra": [TrainStationModel],
  "tdx-thsr": [TrainStationModel],
  "traffic-sections": [TrafficSectionModel],
  osm: [OsmA11yModel],
  "visual-a11y": [VisualA11yModel],
  "taipei-aps": [VisualA11yModel],
  "taipei-park-entrances": [ParkEntranceModel, ParkAreaModel],
  "gtfs-levels": [GtfsLevel],
  "gtfs-stops": [GtfsStop],
  "gtfs-trips": [GtfsTrip],
  "gtfs-pathways": [GtfsPathway],
  "a11y-metro": [A11yModel],
  bathrooms: [BathroomModel],
  "parking-tdx": [DisabledParkingModel],
  "campus-a11y": [CampusA11yModel],
  welfare: [WelfareModel],
};

/** Extra hints printed when a step exits with a specific code. */
const EXIT_HINTS: Record<string, Record<number, string>> = {
  "taipei-aps": {
    2: "visual_a11ys still has the legacy index — back up, then run `pnpm migrate:visual-a11y-source` (not run automatically)",
  },
};

interface StepResult {
  status: StepStatus;
  seconds: number;
  detail?: string;
}

function log(message: string): void {
  console.log(`[data:sync] ${message}`);
}

function hasCommand(name: string): boolean {
  return spawnSync("sh", ["-c", `command -v ${name}`]).status === 0;
}

function fileExists(relativePath: string): boolean {
  return fs.existsSync(path.resolve(ROOT, relativePath));
}

/** @returns Unmet preconditions of the selected steps' backing services. */
async function checkBackends(steps: readonly SyncStep[]): Promise<string[]> {
  const backends = new Set(steps.flatMap((s) => s.backends));
  const problems: string[] = [];

  if (backends.has("mongo") && process.env.DATABASE_URL) {
    try {
      await mongoose.connect(process.env.DATABASE_URL, {
        serverSelectionTimeoutMS: CONNECT_TIMEOUT_MS,
      });
      await mongoose.connection.db?.admin().ping();
    } catch (err) {
      problems.push(
        `MongoDB unreachable at DATABASE_URL (${(err as Error).message}) — on the host, compose publishes Mongo on 127.0.0.1:27018`,
      );
    }
  }

  if (backends.has("postgis") && process.env.PED_GRAPH_DATABASE_URL) {
    const client = new Client({
      connectionString: process.env.PED_GRAPH_DATABASE_URL,
      connectionTimeoutMillis: CONNECT_TIMEOUT_MS,
    });
    try {
      await client.connect();
      const { rows } = await client.query<{ exists: boolean }>(
        "SELECT to_regclass('public.ped_graph_version') IS NOT NULL AS exists",
      );
      if (!rows[0]?.exists) {
        problems.push(
          "PostGIS has no ped_graph_version table — build the ped graph first (pnpm build:ped-graph) or --skip=taipei-ramps",
        );
      }
    } catch (err) {
      problems.push(
        `PostGIS unreachable at PED_GRAPH_DATABASE_URL (${(err as Error).message}) — on the host, compose publishes PostGIS on 127.0.0.1:5434`,
      );
    } finally {
      await client.end().catch(() => undefined);
    }
  }

  if (backends.has("chroma")) {
    const url = process.env.CHROMA_URL || DEFAULT_CHROMA_URL;
    try {
      const res = await fetch(new URL("/api/v2/heartbeat", url), {
        signal: AbortSignal.timeout(CONNECT_TIMEOUT_MS),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
    } catch (err) {
      problems.push(`Chroma unreachable at ${url} (${(err as Error).message})`);
    }
  }

  if (backends.has("docker")) {
    for (const tool of ["docker", "curl", "jq"]) {
      if (!hasCommand(tool)) problems.push(`${tool} is not installed`);
    }
  }
  return problems;
}

function runCommand(command: readonly string[]): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(command[0], command.slice(1), {
      cwd: ROOT,
      stdio: "inherit",
      env: process.env,
    });
    child.on("error", (err) => {
      console.error(err);
      resolve(1);
    });
    child.on("close", (code) => resolve(code ?? 1));
  });
}

/** Downloads the Valhalla source PBF unless it is already present. */
async function ensurePbf(): Promise<number> {
  const pbfPath = path.resolve(
    ROOT,
    process.env.VALHALLA_PBF_PATH || DEFAULT_PBF_PATH,
  );
  if (fs.existsSync(pbfPath)) {
    log(`PBF present: ${pbfPath}`);
    return 0;
  }
  const url = process.env.OTP_OSM_PBF_URL || DEFAULT_PBF_URL;
  log(`PBF missing — downloading ${url}`);
  fs.mkdirSync(path.dirname(pbfPath), { recursive: true });
  const tmpPath = `${pbfPath}.tmp`;
  const code = await runCommand(["curl", "-fSL", "-o", tmpPath, url]);
  if (code !== 0) {
    fs.rmSync(tmpPath, { force: true });
    return code;
  }
  fs.renameSync(tmpPath, pbfPath);
  return 0;
}

/** @returns Names of collections the step should have filled but are empty. */
async function emptyCollectionsAfter(stepId: string): Promise<string[]> {
  const empty: string[] = [];
  for (const model of NON_EMPTY_AFTER[stepId] ?? []) {
    const count = await model.countDocuments({}, { limit: 1 });
    if (count === 0) empty.push(model.collection.collectionName);
  }
  return empty;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function printPlan(steps: readonly SyncStep[]): void {
  log(`plan (${steps.length} steps, in order):`);
  steps.forEach((step, i) => {
    const deps = step.dependsOn?.length
      ? `  ← ${step.dependsOn.join(", ")}`
      : "";
    console.log(
      `  ${String(i + 1).padStart(2)}. [${step.group}] ${step.id}${deps}`,
    );
  });
}

function printSummary(
  steps: readonly SyncStep[],
  results: ReadonlyMap<string, StepResult>,
): void {
  log("summary:");
  for (const step of steps) {
    const result = results.get(step.id);
    if (!result) {
      console.log(`  ·         ${step.id} (not run — stopped by --fail-fast)`);
      continue;
    }
    const time = `${result.seconds.toFixed(0)}s`.padStart(6);
    const detail = result.detail ? `  — ${result.detail}` : "";
    console.log(`  ${result.status.padEnd(11)} ${time}  ${step.id}${detail}`);
  }
  const notes = steps.filter(
    (s) => s.partialFailureNote && results.get(s.id)?.status === "EXITED_0",
  );
  if (notes.length > 0) {
    log("exit 0 cannot rule out partial failure for — check their logs above:");
    for (const step of notes) {
      console.log(`  ${step.id}: ${step.partialFailureNote}`);
    }
  }
}

function releaseLock(): void {
  fs.rmSync(LOCK_DIR, { recursive: true, force: true });
}

function acquireLock(): void {
  try {
    fs.mkdirSync(LOCK_DIR);
  } catch {
    throw new Error(
      `another data:sync holds ${LOCK_DIR} — remove it if no sync is running`,
    );
  }
  try {
    fs.writeFileSync(
      path.join(LOCK_DIR, "owner"),
      `pid=${process.pid}\nstarted_at=${new Date().toISOString()}\n`,
    );
  } catch (err) {
    releaseLock();
    throw err;
  }
  // `finally` does not run when the process is killed by a signal.
  for (const [signal, code] of [
    ["SIGINT", 130],
    ["SIGTERM", 143],
  ] as const) {
    process.once(signal, () => {
      releaseLock();
      process.exit(code);
    });
  }
}

async function main(): Promise<number> {
  const options = parseSyncArgs(process.argv.slice(2));
  const steps = selectSteps(SYNC_STEPS, options);
  if (steps.length === 0) {
    log("no steps selected");
    return 1;
  }
  printPlan(steps);

  const blockers = steps.flatMap((step) =>
    findStepBlockers(step, process.env, fileExists).map(
      (reason) => `${step.id}: ${reason}`,
    ),
  );
  blockers.push(...(await checkBackends(steps)));
  if (blockers.length > 0) {
    log("preflight failed — nothing was run:");
    blockers.forEach((b) => console.log(`  ✗ ${b}`));
    log("fix the above, or exclude steps with --skip=<id,...>");
    return 1;
  }
  log("preflight ok");
  if (options.planOnly) return 0;

  acquireLock();
  const statuses = new Map<string, StepStatus>();
  const results = new Map<string, StepResult>();
  let lastWasTdx = false;
  try {
    for (const step of steps) {
      const skipReason = dependencySkipReason(step, statuses);
      if (skipReason) {
        statuses.set(step.id, "SKIPPED_DEP");
        results.set(step.id, {
          status: "SKIPPED_DEP",
          seconds: 0,
          detail: skipReason,
        });
        continue;
      }
      if (step.tdx && lastWasTdx && options.tdxGapSeconds > 0) {
        log(`waiting ${options.tdxGapSeconds}s between TDX steps`);
        await sleep(options.tdxGapSeconds * 1000);
      }

      log(`▶ ${step.id}`);
      const start = Date.now();
      let status: StepStatus;
      let detail: string | undefined;
      try {
        const code =
          step.id === "valhalla-pbf"
            ? await ensurePbf()
            : await runCommand(step.command);
        status = code === 0 ? "EXITED_0" : "FAILED";
        detail = code === 0 ? undefined : `exit ${code}`;
        const hint = EXIT_HINTS[step.id]?.[code];
        if (hint) detail = `${detail}: ${hint}`;
        if (status === "EXITED_0") {
          const empty = await emptyCollectionsAfter(step.id);
          if (empty.length > 0) {
            status = "FAILED";
            detail = `exited 0 but left empty: ${empty.join(", ")}`;
          }
        }
      } catch (err) {
        status = "FAILED";
        detail = (err as Error).message;
      }
      const seconds = (Date.now() - start) / 1000;
      statuses.set(step.id, status);
      results.set(step.id, { status, seconds, detail });
      log(
        `${status === "EXITED_0" ? "✓" : "✗"} ${step.id} (${seconds.toFixed(0)}s)`,
      );
      lastWasTdx = Boolean(step.tdx);
      if (status === "FAILED" && options.failFast) break;
    }
  } finally {
    releaseLock();
  }

  printSummary(steps, results);
  const ranAll = results.size === steps.length;
  return ranAll ? syncExitCode(statuses) : 1;
}

main()
  .then(async (code) => {
    await mongoose.disconnect();
    process.exit(code);
  })
  .catch(async (err) => {
    console.error(`[data:sync] ${(err as Error).message}`);
    await mongoose.disconnect();
    process.exit(1);
  });
