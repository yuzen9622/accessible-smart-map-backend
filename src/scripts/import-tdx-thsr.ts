/**
 * One-shot import: fetches THSR station data from TDX and upserts into MongoDB
 * for geospatial ($near) queries used by the accessible route service.
 *
 * Run: npm run import:tdx-thsr
 */

import "dotenv/config";
import mongoose from "mongoose";
import type { AnyBulkWriteOperation } from "mongoose";
import TrainStationModel from "../model/train-station.model";
import { thsrUrl } from "../config/transit";
import { tdxFetch } from "../config/fetch";
import { TdxThsrStation } from "../types/transit";
import type { ITdxTrainStation } from "../types";

const CHUNK = 500;

async function main() {
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) throw new Error("DATABASE_URL env var is required");

  await mongoose.connect(dbUrl);
  console.log("Connected to MongoDB\n");

  console.log("▶ Importing: THSR stations");

  const resp = await tdxFetch(`${thsrUrl.stationUrl}?$format=JSON`);
  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(
      `TDX ${resp.status} for THSR stations: ${body.slice(0, 200)}`,
    );
  }
  const stations = (await resp.json()) as TdxThsrStation[];
  if (!stations.length) {
    console.log("  No THSR stations returned");
    await mongoose.disconnect();
    return;
  }
  console.log(`  Fetched ${stations.length} stations from TDX`);

  const ops: AnyBulkWriteOperation<ITdxTrainStation>[] = stations
    .filter(
      (s) =>
        s.StationUID &&
        s.StationPosition?.PositionLon &&
        s.StationPosition?.PositionLat,
    )
    .map((s) => ({
      updateOne: {
        filter: { stationUID: s.StationUID },
        update: {
          $set: {
            stationUID: s.StationUID,
            stationID: s.StationID,
            stationName: { Zh_tw: s.StationName.Zh_tw, En: s.StationName.En },
            railSystem: "THSR",
            location: {
              type: "Point",
              coordinates: [
                s.StationPosition.PositionLon,
                s.StationPosition.PositionLat,
              ],
            },
          },
        },
        upsert: true,
      },
    }));

  if (!ops.length) {
    console.log("  No valid stations to upsert (missing coordinates?)");
    await mongoose.disconnect();
    return;
  }

  let upserted = 0;
  for (let i = 0; i < ops.length; i += CHUNK) {
    const result = await TrainStationModel.bulkWrite(ops.slice(i, i + CHUNK), {
      ordered: false,
    });
    upserted += result.upsertedCount + result.modifiedCount;
  }

  console.log(`  Upserted/updated: ${upserted}`);
  console.log(`\n✓ Done. THSR stations imported: ${upserted}`);
  await mongoose.disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
