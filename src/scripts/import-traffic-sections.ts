/**
 * Import script: fetches static road section metadata and centrelines (WKT)
 * from TDX Road/Traffic APIs and upserts them into MongoDB TrafficSection collection.
 *
 * Run: npx dotenvx run -- ts-node src/scripts/import-traffic-sections.ts
 * Or:  npm run import:traffic-sections -- --cities=Taipei
 */

import "dotenv/config";
import mongoose from "mongoose";
import { tdxFetch } from "../config/fetch";
import {
  TDX_SUPPORTED_CITIES,
  TRAFFIC_FETCH_TIMEOUT_MS,
  TRAFFIC_TARGET_CITIES,
  trafficUrl,
} from "../config/traffic";
import { bulkUpsertSections } from "../modules/traffic/traffic-section.repository";
import type { ITrafficSection } from "../types";
import type { TdxSectionRow, TdxSectionShapeRow } from "../types/traffic";
import { wktToGeoJson } from "../utils/wkt";

function parseCities(): readonly string[] {
  const arg = process.argv.find((a) => a.startsWith("--cities="));
  if (process.argv.includes("--all")) {
    return TDX_SUPPORTED_CITIES;
  }
  if (!arg) return TRAFFIC_TARGET_CITIES;
  return arg
    .slice("--cities=".length)
    .split(",")
    .map((c) => c.trim())
    .filter(Boolean);
}

async function fetchJsonRows<T>(url: string, rowsKey: string): Promise<T[]> {
  try {
    const res = await tdxFetch(`${url}?$format=JSON`, {
      signal: AbortSignal.timeout(TRAFFIC_FETCH_TIMEOUT_MS),
    });
    if (res.status === 400 || res.status === 404) {
      // 該縣市未在 TDX 開放 Section 幾何資料
      return [];
    }
    if (!res.ok) {
      throw new Error(`TDX HTTP ${res.status} for ${url}`);
    }
    const payload = await res.json();
    if (Array.isArray(payload)) {
      return payload as T[];
    }
    if (
      payload &&
      typeof payload === "object" &&
      Array.isArray((payload as Record<string, unknown>)[rowsKey])
    ) {
      return (payload as Record<string, unknown>)[rowsKey] as T[];
    }
    return [];
  } catch (err) {
    if (err instanceof Error && err.message.includes("TDX HTTP")) {
      throw err;
    }
    return [];
  }
}

function parseKm(raw?: string): number | undefined {
  if (!raw) return undefined;
  const m = /^(\d+)K\+(\d+)$/i.exec(raw.trim());
  if (!m) return undefined;
  return parseInt(m[1], 10) + parseInt(m[2], 10) / 1000;
}

async function importDataset(
  label: string,
  sectionUrl: string,
  shapeUrl: string,
  cityTag: string,
): Promise<{
  city: string;
  total: number;
  wktFailures: number;
  durationMs: number;
}> {
  const start = Date.now();
  console.log(
    `[import:traffic-sections] Fetching metadata and shapes for ${label}...`,
  );

  const [sections, shapes] = await Promise.all([
    fetchJsonRows<TdxSectionRow>(sectionUrl, "Sections"),
    fetchJsonRows<TdxSectionShapeRow>(shapeUrl, "SectionShapes"),
  ]);

  console.log(
    `[import:traffic-sections] ${label}: Got ${sections.length} sections, ${shapes.length} shapes`,
  );

  const sectionMap = new Map<string, TdxSectionRow>();
  for (const sec of sections) {
    if (sec.SectionID) {
      sectionMap.set(sec.SectionID, sec);
    }
  }

  const docsToUpsert: ITrafficSection[] = [];
  let wktFailures = 0;

  for (const shape of shapes) {
    if (!shape.SectionID || !shape.Geometry) {
      continue;
    }

    const parsedGeo = wktToGeoJson(shape.Geometry);
    if (!parsedGeo) {
      wktFailures++;
      continue;
    }

    if (
      parsedGeo.type !== "LineString" &&
      parsedGeo.type !== "MultiLineString"
    ) {
      wktFailures++;
      continue;
    }

    const meta = sectionMap.get(shape.SectionID);
    const startPoint: [number, number] | undefined =
      parsedGeo.type === "LineString" && parsedGeo.coordinates.length > 0
        ? parsedGeo.coordinates[0]
        : undefined;

    docsToUpsert.push({
      sectionId: shape.SectionID,
      city: cityTag,
      roadName: meta?.RoadName,
      roadClass: meta?.RoadClass,
      geometry: parsedGeo,
      lengthM: meta?.SectionLength,
      roadDirection: meta?.RoadDirection,
      startKm: parseKm(meta?.SectionMile?.StartKM),
      endKm: parseKm(meta?.SectionMile?.EndKM),
      startPoint,
      updatedAt: new Date(),
    });
  }

  if (docsToUpsert.length > 0) {
    const res = await bulkUpsertSections(docsToUpsert);
    console.log(
      `[import:traffic-sections] ${label}: Upserted ${res.upserted}, modified ${res.modified}`,
    );
  }

  return {
    city: label,
    total: docsToUpsert.length,
    wktFailures,
    durationMs: Date.now() - start,
  };
}

async function importCity(city: string) {
  return importDataset(
    city,
    trafficUrl.sectionUrl(city),
    trafficUrl.sectionShapeUrl(city),
    city,
  );
}

async function main() {
  const dbUrl =
    process.env.DATABASE_URL || "mongodb://localhost:27017/taipei-accessible";
  await mongoose.connect(dbUrl);
  console.log("[import:traffic-sections] Connected to MongoDB");

  const cities = parseCities();
  console.log(`[import:traffic-sections] Target cities: ${cities.join(", ")}`);

  for (const city of cities) {
    try {
      const summary = await importCity(city);
      console.log(
        `[import:traffic-sections] Completed ${summary.city}: ${summary.total} imported, ${summary.wktFailures} WKT failures, ${summary.durationMs}ms`,
      );
    } catch (err) {
      console.error(`[import:traffic-sections] Failed importing ${city}:`, err);
      process.exitCode = 1;
    }
  }

  // 自動匯入國道與省道路網線型
  if (process.argv.includes("--all") || process.argv.includes("--freeway")) {
    try {
      const fSummary = await importDataset(
        "國道 (Freeway)",
        trafficUrl.freewaySectionUrl(),
        trafficUrl.freewaySectionShapeUrl(),
        "Freeway",
      );
      console.log(
        `[import:traffic-sections] Completed ${fSummary.city}: ${fSummary.total} imported, ${fSummary.wktFailures} WKT failures, ${fSummary.durationMs}ms`,
      );
    } catch (fErr) {
      console.error(
        "[import:traffic-sections] Failed importing Freeway:",
        fErr,
      );
    }
  }

  if (process.argv.includes("--all") || process.argv.includes("--highway")) {
    try {
      const hSummary = await importDataset(
        "省道 (Highway)",
        trafficUrl.highwaySectionUrl(),
        trafficUrl.highwaySectionShapeUrl(),
        "Highway",
      );
      console.log(
        `[import:traffic-sections] Completed ${hSummary.city}: ${hSummary.total} imported, ${hSummary.wktFailures} WKT failures, ${hSummary.durationMs}ms`,
      );
    } catch (hErr) {
      console.error(
        "[import:traffic-sections] Failed importing Highway:",
        hErr,
      );
    }
  }

  await mongoose.disconnect();
  console.log("[import:traffic-sections] Disconnected from MongoDB");
}

if (require.main === module) {
  main().catch((err) => {
    console.error("[import:traffic-sections] Fatal error:", err);
    process.exit(1);
  });
}
