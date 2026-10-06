/**
 * Import: 臺北市公園處「公園無障礙出入口點位」→ park_entrances, plus one area
 * per park → park_areas (OpenStreetMap `leisure=park` outline, or the convex
 * hull of the park's entrances when no outline matches).
 *
 * The dataset's `ID` is a release-local row number, so each run mirrors the
 * release: every parsed row is upserted, then rows absent from the release are
 * deleted. Upsert-then-prune (rather than delete-then-insert) means readers
 * never see an empty collection mid-import, and a release that parses to
 * nothing aborts before touching the stored data. Both downloads finish before
 * the first write, so a failed Overpass request leaves both collections as
 * they were.
 *
 * Run: pnpm import:taipei-park-entrances [-- --file <csv>] [--osm-file <overpass json>]
 */

import "dotenv/config";
import { readFile } from "node:fs/promises";
import mongoose from "mongoose";
import { fetchOverpassElements } from "../adapters/overpass.adapter";
import { decodeCsv } from "../adapters/taipei-aps.adapter";
import { fetchTaipeiParkEntranceCsv } from "../adapters/taipei-park-entrance.adapter";
import ParkAreaModel from "../model/park-area.model";
import ParkEntranceModel from "../model/park-entrance.model";
import {
  buildParkAreas,
  type BuiltParkArea,
  type OverpassParkElement,
} from "./taipei-park-area-build";
import {
  parseParkEntranceCsv,
  TAIPEI_CITY_BBOX,
  type ParkEntranceDoc,
} from "./taipei-park-entrance-parse";

const [WEST, SOUTH, EAST, NORTH] = TAIPEI_CITY_BBOX;
const OVERPASS_PARK_QUERY =
  `[out:json][timeout:150];` +
  `(way["leisure"="park"](${SOUTH},${WEST},${NORTH},${EAST});` +
  `relation["leisure"="park"](${SOUTH},${WEST},${NORTH},${EAST}););` +
  `out geom;`;

/**
 * Mirror one release into `park_entrances`.
 *
 * @param entrances Every accepted entrance of the release.
 * @returns How many were upserted, newly inserted and pruned.
 */
export async function syncParkEntrances(
  entrances: readonly ParkEntranceDoc[],
): Promise<{ upserted: number; inserted: number; deleted: number }> {
  if (entrances.length === 0) {
    throw new Error("refusing to sync an empty park entrance release");
  }
  const importedAt = new Date();
  const write = await ParkEntranceModel.bulkWrite(
    entrances.map((doc) => ({
      updateOne: {
        filter: { sourceId: doc.sourceId },
        update: { $set: { ...doc, importedAt } },
        upsert: true,
      },
    })),
    { ordered: false },
  );
  const pruned = await ParkEntranceModel.deleteMany({
    sourceId: { $nin: entrances.map((doc) => doc.sourceId) },
  });
  return {
    upserted: entrances.length,
    inserted: write.upsertedCount,
    deleted: pruned.deletedCount,
  };
}

/**
 * Mirror the built areas into `park_areas`, one per park.
 *
 * Each area is written on its own so that an OSM outline MongoDB's 2dsphere
 * index rejects (a self-intersecting ring) falls back to that park's entrance
 * hull instead of failing the batch; a park with no acceptable area keeps none.
 *
 * @param built One preferred area (plus hull fallback) per park.
 * @returns How many parks were stored from each source, how many fell back, failed, and were pruned.
 */
export async function syncParkAreas(built: readonly BuiltParkArea[]): Promise<{
  osm: number;
  hull: number;
  fellBack: number;
  rejected: number;
  deleted: number;
}> {
  if (built.length === 0) {
    throw new Error("refusing to sync an empty park area build");
  }
  const importedAt = new Date();
  const stats = { osm: 0, hull: 0, fellBack: 0, rejected: 0, deleted: 0 };
  const stored: string[] = [];
  for (const { area, fallback } of built) {
    let written = null;
    for (const candidate of fallback ? [area, fallback] : [area]) {
      try {
        await ParkAreaModel.updateOne(
          { parkName: candidate.parkName },
          { $set: { ...candidate, importedAt } },
          { upsert: true },
        );
        written = candidate;
        break;
      } catch (err) {
        console.warn(
          `[import-taipei-park-entrances] ${candidate.parkName} ${candidate.source} area rejected: ${(err as Error).message}`,
        );
      }
    }
    if (!written) {
      stats.rejected += 1;
      continue;
    }
    stored.push(written.parkName);
    if (written.source === "osm") stats.osm += 1;
    else stats.hull += 1;
    if (written !== area) stats.fellBack += 1;
  }
  const pruned = await ParkAreaModel.deleteMany({
    parkName: { $nin: stored },
  });
  stats.deleted = pruned.deletedCount;
  return stats;
}

interface ImportArgs {
  csvFile?: string;
  osmFile?: string;
}

/**
 * @param argv Command-line arguments after the executable.
 * @returns Local file overrides; an omitted one is downloaded.
 */
export function parseImportArgs(argv: readonly string[]): ImportArgs {
  const args: ImportArgs = {};
  for (let i = 0; i < argv.length; i += 2) {
    const [flag, value] = [argv[i], argv[i + 1]];
    if (!value || value.startsWith("--")) {
      throw new Error(
        "usage: import-taipei-park-entrances [--file <csv>] [--osm-file <json>]",
      );
    }
    if (flag === "--file") args.csvFile = value;
    else if (flag === "--osm-file") args.osmFile = value;
    else {
      throw new Error(
        "usage: import-taipei-park-entrances [--file <csv>] [--osm-file <json>]",
      );
    }
  }
  return args;
}

async function loadOsmElements(
  osmFile: string | undefined,
): Promise<OverpassParkElement[]> {
  if (osmFile === undefined) {
    return fetchOverpassElements(OVERPASS_PARK_QUERY, { timeoutMs: 180_000 });
  }
  const parsed = JSON.parse(await readFile(osmFile, "utf-8")) as {
    elements?: OverpassParkElement[];
  };
  return parsed.elements ?? [];
}

async function main(): Promise<void> {
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) throw new Error("DATABASE_URL env var is required");

  const { csvFile, osmFile } = parseImportArgs(process.argv.slice(2));
  const csv =
    csvFile === undefined
      ? await fetchTaipeiParkEntranceCsv()
      : decodeCsv(new Uint8Array(await readFile(csvFile)));
  const parsed = parseParkEntranceCsv(csv);
  console.log(
    `[import-taipei-park-entrances] accepted=${parsed.entrances.length} ` +
      `malformed=${parsed.malformed} out_of_bounds=${parsed.outOfBounds} ` +
      `duplicate_ids=${parsed.duplicateIds}`,
  );
  const elements = await loadOsmElements(osmFile);
  const built = buildParkAreas(parsed.entrances, elements);
  const parkCount = new Set(parsed.entrances.map((e) => e.parkName)).size;
  console.log(
    `[import-taipei-park-entrances] osm_elements=${elements.length} ` +
      `parks=${parkCount} areas_built=${built.length}`,
  );

  await mongoose.connect(dbUrl);
  try {
    await ParkEntranceModel.syncIndexes();
    await ParkAreaModel.syncIndexes();
    const entrances = await syncParkEntrances(parsed.entrances);
    console.log(
      `[import-taipei-park-entrances] ✓ entrances upserted=${entrances.upserted} ` +
        `inserted=${entrances.inserted} deleted=${entrances.deleted}`,
    );
    const areas = await syncParkAreas(built);
    console.log(
      `[import-taipei-park-entrances] ✓ areas osm=${areas.osm} hull=${areas.hull} ` +
        `fell_back=${areas.fellBack} rejected=${areas.rejected} deleted=${areas.deleted}`,
    );
  } finally {
    await mongoose.disconnect();
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
