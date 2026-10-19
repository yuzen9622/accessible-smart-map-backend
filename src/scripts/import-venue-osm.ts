/**
 * Import: a JOSM-authored venue `.osm` (OSM Simple Indoor Tagging +
 * `a11ymap:*`, rules in src/modules/venue/venue.compile.ts) → `venues`.
 *
 * The file is private campus data: it stays out of git (`data/` is ignored)
 * and is imported from the author's machine into the target MongoDB. The
 * whole venue is compiled and validated before anything is written; any error
 * aborts with the report and leaves the stored venue untouched. A successful
 * import replaces the venue document in one write and bumps its `version`,
 * which the API's venue graph cache keys on.
 *
 * Run: pnpm import:venue -- --file data/venues/nutc-sanmin.osm \
 *        --venue nutc-sanmin --name "國立臺中科技大學 三民校區" [--buildings info,zk,changming,hanying] [--dry-run]
 */

import "dotenv/config";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import mongoose from "mongoose";
import { compileVenue } from "../modules/venue/venue.compile";
import { parseOsmXml } from "../modules/venue/venue-osm.parse";
import { replaceVenue } from "../modules/venue/venue.repository";

export const DEFAULT_VENUE_FILE = "data/venues/nutc-sanmin.osm";
const DEFAULT_VENUE_ID = "nutc-sanmin";
const DEFAULT_VENUE_NAME = "國立臺中科技大學 三民校區";

/** The first NUTC publication; other source buildings stay in the private OSM. */
export const DEFAULT_NUTC_BUILDING_IDS = [
  "info",
  "zk",
  "changming",
  "hanying",
] as const;

/** Parse before reading data or opening a database connection. */
export function parseVenueImportArgs(argv: readonly string[]) {
  const arg = (name: string) => {
    const inline = argv.find((value) => value.startsWith(`--${name}=`));
    if (inline !== undefined) return inline.slice(name.length + 3);
    const i = argv.indexOf(`--${name}`);
    if (i < 0) return undefined;
    const value = argv[i + 1];
    if (!value || value.startsWith("--"))
      throw new Error(`--${name} requires a value`);
    return value;
  };
  const venueId = arg("venue") ?? DEFAULT_VENUE_ID;
  const rawBuildings = arg("buildings");
  const allBuildings = argv.includes("--all-buildings");
  if (allBuildings && rawBuildings !== undefined)
    throw new Error("--buildings and --all-buildings are mutually exclusive");
  const buildingIds =
    rawBuildings !== undefined
      ? rawBuildings.split(",").map((id) => id.trim())
      : !allBuildings && venueId === DEFAULT_VENUE_ID
        ? [...DEFAULT_NUTC_BUILDING_IDS]
        : undefined;
  if (
    buildingIds &&
    (!buildingIds.length ||
      new Set(buildingIds).size !== buildingIds.length ||
      buildingIds.some((id) => !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(id)))
  ) {
    throw new Error(
      "--buildings requires a non-empty, unique list of building ids",
    );
  }
  return {
    file: arg("file") ?? DEFAULT_VENUE_FILE,
    venueId,
    name: arg("name") ?? DEFAULT_VENUE_NAME,
    dryRun: argv.includes("--dry-run"),
    buildingIds,
  };
}

async function main() {
  const { file, venueId, name, dryRun, buildingIds } = parseVenueImportArgs(
    process.argv.slice(2),
  );

  const xml = await readFile(file, "utf8");
  const { venue, errors, warnings } = compileVenue(parseOsmXml(xml), {
    venueId,
    name,
    buildingIds,
  });

  console.log(
    `[venue] ${venueId} [${buildingIds?.join(",") ?? "all buildings"}]: ${venue.buildings.length} buildings, ${venue.places.length} places, ` +
      `${venue.nodes.length} nodes, ${venue.edges.length} edges, ${venue.features.length} features`,
  );
  for (const w of warnings) console.warn(`[venue] 警告：${w}`);
  if (errors.length) {
    for (const e of errors) console.error(`[venue] 錯誤：${e}`);
    throw new Error(`${errors.length} error(s); nothing was written`);
  }
  if (dryRun) {
    console.log("[venue] --dry-run: validation passed, nothing written");
    return;
  }

  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) throw new Error("DATABASE_URL env var is required");
  await mongoose.connect(dbUrl);
  try {
    const version = await replaceVenue({
      ...venue,
      importedAt: new Date(),
      source: {
        file: path.basename(file),
        sha256: createHash("sha256").update(xml).digest("hex"),
      },
      warnings,
    });
    console.log(`[venue] ${venueId} imported as version ${version}`);
  } finally {
    await mongoose.disconnect();
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
