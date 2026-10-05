/**
 * One-shot import: fetches metro station data from TDX for all supported rail
 * systems and upserts into MongoDB for geospatial ($near) queries.
 *
 * Run: pnpm import:tdx-metro
 * Read-only validation: pnpm import:tdx-metro --system=NTALRT --dry-run
 */

import "dotenv/config";
import mongoose from "mongoose";
import MetroStationModel from "../model/metro-station.model";
import { metroUrl, METRO_STATION_SYSTEMS } from "../config/transit";
import { tdxFetch } from "../config/fetch";
import { TdxMetroStation, TdxMetroStationOfLine } from "../types/transit";
import { metroStationOperations } from "./tdx-metro-parse";

const DELAY_MS = 60000;
const CHUNK = 500;

const DRY_RUN = process.argv.includes("--dry-run");
const DRY_RUN_DELAY_MS = 1800;

function sleep(ms: number) {
  return new Promise<void>((r) => setTimeout(r, ms));
}

async function importSystem(railSystem: string): Promise<number> {
  const stationResp = await tdxFetch(
    `${metroUrl.stationUrl(railSystem)}?$format=JSON`,
  );
  if (!stationResp.ok) {
    const body = await stationResp.text();
    throw new Error(
      `TDX ${stationResp.status} for ${railSystem} stations: ${body.slice(0, 120)}`,
    );
  }
  const stations = (await stationResp.json()) as TdxMetroStation[];
  if (!Array.isArray(stations) || !stations.length) {
    throw new Error(`No stations returned for ${railSystem}`);
  }

  const lineResp = await tdxFetch(
    `${metroUrl.stationOfLineUrl(railSystem)}?$format=JSON`,
  );
  if (!lineResp.ok)
    throw new Error(`TDX ${lineResp.status} for ${railSystem} station lines`);
  const stationOfLines = (await lineResp.json()) as TdxMetroStationOfLine[];
  if (!Array.isArray(stationOfLines) || !stationOfLines.length)
    throw new Error(`No station lines returned for ${railSystem}`);

  const ops = metroStationOperations(stations, stationOfLines, railSystem);
  if (ops.length !== stations.length)
    throw new Error(
      `${railSystem}: ${stations.length - ops.length} stations have invalid coordinates/UID`,
    );
  const withoutLines = ops.filter(
    (op) =>
      "updateOne" in op && !(op.updateOne.update as any).$set.lineIds.length,
  );
  if (withoutLines.length)
    throw new Error(
      `${railSystem}: ${withoutLines.length} stations have no line mapping`,
    );
  if (DRY_RUN) {
    console.log(
      `  Dry run: ${ops.length} valid station operations with line mappings; no database writes`,
    );
    return ops.length;
  }

  let upserted = 0;
  for (let i = 0; i < ops.length; i += CHUNK) {
    const result = await MetroStationModel.bulkWrite(ops.slice(i, i + CHUNK), {
      ordered: false,
    });
    upserted += result.upsertedCount + result.modifiedCount;
  }
  return upserted;
}

async function main() {
  const dbUrl = process.env.DATABASE_URL;
  if (!DRY_RUN) {
    if (!dbUrl) throw new Error("DATABASE_URL env var is required");
    await mongoose.connect(dbUrl);
    console.log("Connected to MongoDB\n");
  }

  const systemArg = process.argv
    .find((a) => a.startsWith("--system="))
    ?.split("=")[1];
  if (systemArg && !METRO_STATION_SYSTEMS.some((s) => s === systemArg))
    throw new Error(`Unsupported station system: ${systemArg}`);
  const systems = systemArg ? [systemArg] : [...METRO_STATION_SYSTEMS];

  let total = 0;
  let failed = 0;
  for (const railSystem of systems) {
    console.log(`▶ Importing: ${railSystem}`);
    try {
      const count = await importSystem(railSystem);
      console.log(`  ${DRY_RUN ? "Validated" : "Upserted/updated"}: ${count}`);
      total += count;
    } catch (err) {
      failed++;
      console.error(`  Error: ${(err as Error).message}`);
    }
    if (railSystem !== systems[systems.length - 1])
      await sleep(DRY_RUN ? DRY_RUN_DELAY_MS : DELAY_MS);
  }

  console.log(
    `\n${failed ? "Failed" : "Done"}. Total ${DRY_RUN ? "validated" : "upserted/updated"}: ${total}; failed systems: ${failed}`,
  );
  if (!DRY_RUN) await mongoose.disconnect();
  if (failed) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
