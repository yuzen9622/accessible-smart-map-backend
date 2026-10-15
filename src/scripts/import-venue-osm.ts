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
 *        --venue nutc-sanmin --name "國立臺中科技大學 三民校區" [--dry-run]
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

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main() {
  const file = arg("file") ?? DEFAULT_VENUE_FILE;
  const venueId = arg("venue") ?? DEFAULT_VENUE_ID;
  const name = arg("name") ?? DEFAULT_VENUE_NAME;
  const dryRun = process.argv.includes("--dry-run");

  const xml = await readFile(file, "utf8");
  const { venue, errors, warnings } = compileVenue(parseOsmXml(xml), {
    venueId,
    name,
  });

  console.log(
    `[venue] ${venueId}: ${venue.buildings.length} buildings, ${venue.places.length} places, ` +
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
