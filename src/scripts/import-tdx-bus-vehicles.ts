/**
 * One-shot import: fetches TDX V3 Vehicle (per city) and upserts each bus by
 * plate number into MongoDB, including IsLowFloor / HasLiftOrRamp. The bus
 * realtime tool joins live A1 plate numbers against this table to tell the
 * user whether the approaching bus is low-floor / wheelchair-accessible —
 * without ever needing a plate number from the user.
 * Defaults to 六都; pass --city=Taipei for a single city.
 *
 * Run: npm run import:tdx-bus-vehicles
 * Or:  npm run import:tdx-bus-vehicles -- --city=Taipei
 */

import "dotenv/config";
import mongoose from "mongoose";
import BusVehicleModel from "../model/bus-vehicle.model";
import { busUrl } from "../config/transit";
import { tdxFetch } from "../config/fetch";
import { TaiwanCityEn } from "../types/transit";

const ALL_CITIES = [...Object.values(TaiwanCityEn), "InterCity"];

const CITY_DELAY_MS = 1000;
const PAGE_DELAY_MS = 1500;
const TOP = 5000;

type V2Vehicle = {
  PlateNumb: string;
  OperatorID?: string;
  VehicleClass?: number;
  VehicleType?: number;
  IsElectric?: number;
  IsHybrid?: number;
  IsLowFloor?: number;
  HasLiftOrRamp?: number;
  HasWifi?: number;
};

function sleep(ms: number) {
  return new Promise<void>((r) => setTimeout(r, ms));
}

async function importCity(city: string): Promise<number> {
  const all: V2Vehicle[] = [];
  for (let skip = 0; ; skip += TOP) {
    const url =
      city === "InterCity"
        ? `https://tdx.transportdata.tw/api/basic/v2/Bus/Vehicle/InterCity?$format=JSON&$top=${TOP}&$skip=${skip}`
        : `${busUrl.cityVehicleUrl}/${city}?$format=JSON&$top=${TOP}&$skip=${skip}`;
    const resp = await tdxFetch(url);
    if (!resp.ok) {
      const body = await resp.text();
      console.warn(`  TDX ${resp.status} for ${city}: ${body.slice(0, 120)}`);
      break;
    }
    const page = (await resp.json()) as V2Vehicle[];
    all.push(...page);
    if (page.length < TOP) break;
    await sleep(PAGE_DELAY_MS);
  }

  if (!all.length) {
    console.log(`  No vehicles found for ${city}`);
    return 0;
  }

  const ops = all
    .filter((v) => v.PlateNumb)
    .map((v) => ({
      updateOne: {
        filter: { plateNumb: v.PlateNumb },
        update: {
          $set: {
            plateNumb: v.PlateNumb,
            city,
            operatorId: v.OperatorID,
            vehicleClass: v.VehicleClass,
            vehicleType: v.VehicleType,
            isLowFloor: v.IsLowFloor,
            hasLiftOrRamp: v.HasLiftOrRamp,
            isElectric: v.IsElectric,
            isHybrid: v.IsHybrid,
            hasWifi: v.HasWifi,
            importedAt: new Date(),
          },
        },
        upsert: true,
      },
    }));

  const CHUNK = 500;
  let upserted = 0;
  for (let i = 0; i < ops.length; i += CHUNK) {
    const result = await BusVehicleModel.bulkWrite(ops.slice(i, i + CHUNK), {
      ordered: false,
    });
    upserted += result.upsertedCount + result.modifiedCount;
  }
  return upserted;
}

async function main() {
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) throw new Error("DATABASE_URL env var is required");

  await mongoose.connect(dbUrl);
  console.log("Connected to MongoDB\n");

  const cityArg = process.argv
    .find((a) => a.startsWith("--city="))
    ?.split("=")[1];
  const cities = cityArg ? [cityArg] : ALL_CITIES;

  let total = 0;
  for (const city of cities) {
    console.log(`▶ Importing vehicles: ${city}`);
    try {
      const count = await importCity(city);
      console.log(`  Upserted/updated: ${count}`);
      total += count;
    } catch (err) {
      console.error(`  Error: ${(err as Error).message}`);
    }
    await sleep(CITY_DELAY_MS);
  }

  console.log(`\n✓ Done. Total upserted/updated: ${total}`);
  await mongoose.disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
