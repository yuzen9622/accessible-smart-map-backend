/**
 * Import: plate-level low-floor status from city bus systems TDX does not
 * carry (臺中 ebus, 基隆 9284, 新竹 ibus) → busvehicles. Same sync the server
 * runs every BUS_FLEET_SYNC_INTERVAL_MS; Taichung is complete in one run from
 * the day's dispatch, while Keelung and Hsinchu only expose buses in service
 * at that moment and fill in over repeated runs.
 *
 * Run: pnpm import:city-bus-vehicles
 */

import "dotenv/config";
import mongoose from "mongoose";
import { syncBusFleet } from "../modules/transit/bus-fleet-sync.worker";

async function main() {
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) throw new Error("DATABASE_URL env var is required");

  await mongoose.connect(dbUrl);
  const results = await syncBusFleet();
  for (const [source, result] of Object.entries(results)) {
    console.log(
      "error" in result
        ? `✗ ${source}: ${result.error}`
        : `✓ ${source}: ${result.seen} plates seen, ${result.written} records written`,
    );
  }
  await mongoose.disconnect();
  if (Object.values(results).every((r) => "error" in r)) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
