/**
 * One-shot import: fetches TDX V2 StopOfRoute (per city) and upserts each
 * sub-route + direction (with its ordered stops) into MongoDB, so the bus
 * query service can resolve a route number → stop sequence without a live
 * TDX call. Defaults to 六都; pass --city=Taipei for a single city.
 *
 * Run: npm run import:tdx-bus-routes
 * Or:  npm run import:tdx-bus-routes -- --city=Taipei
 */

import "dotenv/config";
import mongoose from "mongoose";
import BusRouteModel from "../model/bus-route.model";
import { busUrl } from "../config/transit";
import { tdxFetch } from "../config/fetch";
import { TaiwanCityEn } from "../types/transit";

const ALL_CITIES = [...Object.values(TaiwanCityEn), "InterCity"];

const CITY_DELAY_MS = 1000;
const PAGE_DELAY_MS = 1500;
const TOP = 5000;

type V2StopOfRoute = {
  RouteUID: string;
  RouteID?: string;
  RouteName: { Zh_tw: string; En?: string };
  SubRouteUID: string;
  SubRouteID?: string;
  SubRouteName?: { Zh_tw: string; En?: string };
  Direction: number;
  Operators?: { OperatorID?: string; OperatorName?: { Zh_tw?: string } }[];
  Stops?: {
    StopUID: string;
    StopID?: string;
    StopName?: { Zh_tw?: string; En?: string };
    StopSequence: number;
    StopPosition?: { PositionLon?: number; PositionLat?: number };
  }[];
};

function sleep(ms: number) {
  return new Promise<void>((r) => setTimeout(r, ms));
}

async function importCity(city: string): Promise<number> {
  const all: V2StopOfRoute[] = [];
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
    const page = (await resp.json()) as V2StopOfRoute[];
    all.push(...page);
    if (page.length < TOP) break;
    await sleep(PAGE_DELAY_MS);
  }

  if (!all.length) {
    console.log(`  No routes found for ${city}`);
    return 0;
  }

  const ops = all
    .filter((r) => r.SubRouteUID && r.RouteName?.Zh_tw)
    .map((r) => ({
      updateOne: {
        filter: { subRouteUid: r.SubRouteUID, direction: r.Direction },
        update: {
          $set: {
            subRouteUid: r.SubRouteUID,
            routeUid: r.RouteUID,
            routeId: r.RouteID,
            city,
            routeName: r.RouteName,
            subRouteName: r.SubRouteName,
            direction: r.Direction,
            operators: (r.Operators ?? []).map((o) => ({
              id: o.OperatorID,
              name: o.OperatorName?.Zh_tw,
            })),
            stops: (r.Stops ?? [])
              .filter((s) => s.StopUID)
              .map((s) => ({
                stopUID: s.StopUID,
                stopId: s.StopID,
                stopName: {
                  Zh_tw: s.StopName?.Zh_tw ?? "",
                  En: s.StopName?.En,
                },
                seq: s.StopSequence,
                lat: s.StopPosition?.PositionLat,
                lng: s.StopPosition?.PositionLon,
              })),
            importedAt: new Date(),
          },
        },
        upsert: true,
      },
    }));

  const CHUNK = 500;
  let upserted = 0;
  for (let i = 0; i < ops.length; i += CHUNK) {
    const result = await BusRouteModel.bulkWrite(ops.slice(i, i + CHUNK), {
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
    console.log(`▶ Importing routes: ${city}`);
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
