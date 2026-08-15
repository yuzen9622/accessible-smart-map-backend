/**
 * One-shot import script: fetches all city bus stops from TDX and upserts
 * into MongoDB for fast geospatial ($near) queries in the route planner.
 *
 * Run: npm run import:tdx-stops
 * Or for a single city: npm run import:tdx-stops -- --city=Taipei
 *
 * Expected import time: ~15-20 minutes for all 22 cities.
 */

import "dotenv/config";
import mongoose from "mongoose";
import type { AnyBulkWriteOperation } from "mongoose";
import BusStopModel from "../model/bus-stop.model";
import { busUrl } from "../config/transit";
import { tdxFetch } from "../config/fetch";
import { TaiwanCityEn } from "../types/transit";
import { BusRoute } from "../types/transit";
import type { ITdxBusStop } from "../types";

const DELAY_MS = 60000;
const TOP = 10000;

const ALL_CITIES = [...Object.values(TaiwanCityEn), "InterCity"];

function sleep(ms: number) {
  return new Promise<void>((r) => setTimeout(r, ms));
}

async function importCity(city: string): Promise<number> {
  const routes: BusRoute[] = [];
  const PAGE_DELAY_MS = 1500;
  for (let skip = 0; ; skip += TOP) {
    const url =
      city === "InterCity"
        ? `${busUrl.interCityStopOfRouteUrl}?$format=JSON&$top=${TOP}&$skip=${skip}`
        : `${busUrl.stopOfRouteUrl}/${city}?$format=JSON&$top=${TOP}&$skip=${skip}`;
    const resp = await tdxFetch(url);

    if (!resp.ok) {
      const body = await resp.text();
      console.warn(`  TDX ${resp.status} for ${city}: ${body.slice(0, 120)}`);
      break;
    }

    const page = (await resp.json()) as BusRoute[];
    routes.push(...page);
    if (page.length < TOP) break;
    await sleep(PAGE_DELAY_MS);
  }

  if (!routes.length) {
    console.log(`  No routes found for ${city}`);
    return 0;
  }

  const stopMap = new Map<
    string,
    {
      Zh_tw: string;
      En?: string;
      lon: number;
      lat: number;
      subRouteIds: Set<string>;
    }
  >();

  for (const route of routes) {
    const subRouteId = route.SubRouteName?.Zh_tw;
    if (!subRouteId) continue;

    for (const stop of route.Stops ?? []) {
      if (!stop.StopUID || stop.StopPosition == null) continue;
      const { PositionLon: lon, PositionLat: lat } = stop.StopPosition;
      if (!lon || !lat) continue;

      if (!stopMap.has(stop.StopUID)) {
        stopMap.set(stop.StopUID, {
          Zh_tw: stop.StopName?.Zh_tw ?? "",
          En: stop.StopName?.En,
          lon,
          lat,
          subRouteIds: new Set(),
        });
      }
      stopMap.get(stop.StopUID)!.subRouteIds.add(subRouteId);
    }
  }

  if (!stopMap.size) return 0;

  const ops: AnyBulkWriteOperation<ITdxBusStop>[] = [...stopMap.entries()].map(
    ([stopUid, info]) => ({
      updateOne: {
        filter: { stopUid },
        update: {
          $set: {
            stopUid,
            stopName: { Zh_tw: info.Zh_tw, En: info.En },
            city,
            subRouteIds: [...info.subRouteIds],
            location: { type: "Point", coordinates: [info.lon, info.lat] },
            importedAt: new Date(),
          },
        },
        upsert: true,
      },
    }),
  );

  const CHUNK = 500;
  let upserted = 0;
  for (let i = 0; i < ops.length; i += CHUNK) {
    const result = await BusStopModel.bulkWrite(ops.slice(i, i + CHUNK), {
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
    console.log(`▶ Importing: ${city}`);
    try {
      const count = await importCity(city);
      console.log(`  Upserted/updated: ${count}`);
      total += count;
    } catch (err) {
      console.error(`  Error: ${(err as Error).message}`);
    }
    await sleep(DELAY_MS);
  }

  console.log(`\n✓ Done. Total upserted/updated: ${total}`);
  await mongoose.disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
