/**
 * Store the stop aliases written by merge-gtfs-duplicate-stops.py, mapping
 * (GTFS route_id, merged stop_id) back to each route's original TDX StopUID.
 * Runs inside build-otp-graph.sh before the merged graph is promoted. Aliases
 * not refreshed for ALIAS_RETENTION_DAYS are dropped; older entries are kept
 * meanwhile so a rolled-back graph still resolves.
 *
 * Run: npx dotenvx run -- ts-node src/scripts/import-gtfs-stop-aliases.ts ALIASES.json
 */
import "dotenv/config";
import fs from "fs";
import mongoose from "mongoose";
import GtfsStopAliasModel from "../model/gtfs-stop-alias.model";

const BATCH_SIZE = 5_000;
const ALIAS_RETENTION_DAYS = 30;

interface AliasRow {
  routeId: string;
  stopId: string;
  originalStopId: string;
}

async function main() {
  const file = process.argv[2];
  if (!file) throw new Error("usage: import-gtfs-stop-aliases.ts ALIASES.json");
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) throw new Error("DATABASE_URL env var is required");

  const rows = JSON.parse(fs.readFileSync(file, "utf8")) as AliasRow[];
  await mongoose.connect(dbUrl);
  await GtfsStopAliasModel.syncIndexes();
  const builtAt = new Date();
  let written = 0;
  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const result = await GtfsStopAliasModel.bulkWrite(
      rows.slice(i, i + BATCH_SIZE).map((row) => ({
        updateOne: {
          filter: { routeId: row.routeId, stopId: row.stopId },
          update: { $set: { originalStopId: row.originalStopId, builtAt } },
          upsert: true,
        },
      })),
      { ordered: false },
    );
    written += result.upsertedCount + result.matchedCount;
  }
  const cutoff = new Date(
    builtAt.getTime() - ALIAS_RETENTION_DAYS * 24 * 60 * 60 * 1000,
  );
  const { deletedCount } = await GtfsStopAliasModel.deleteMany({
    builtAt: { $lt: cutoff },
  });
  console.log(
    `stop aliases: ${rows.length} in file, ${written} stored, ${deletedCount} expired removed`,
  );
  await mongoose.disconnect();
}

main().catch(async (err) => {
  console.error(err);
  await mongoose.disconnect().catch(() => undefined);
  process.exit(1);
});
