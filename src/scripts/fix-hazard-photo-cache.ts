/**
 * Rewrites Cache-Control on every existing hazard photo to the current policy
 * value (HAZARD_PHOTO_CACHE_MAX_AGE_SEC). Photos uploaded before the change
 * carried a one-year max-age, which lets cached copies outlive deletion.
 * Copies already cached under the old header cannot be recalled.
 *   pnpm retention:fix-photo-cache [--dry-run]
 */

import "dotenv/config";
import {
  hazardPhotoCacheControl,
  listHazardPhotoPage,
  setHazardPhotoCacheControl,
} from "../adapters/gcs.adapter";

async function main() {
  const dryRun = process.argv.includes("--dry-run");
  let pageToken: string | undefined;
  let updated = 0;
  let failed = 0;
  do {
    const page = await listHazardPhotoPage(pageToken);
    for (const name of page.names) {
      if (dryRun) {
        updated++;
        continue;
      }
      try {
        await setHazardPhotoCacheControl(name);
        updated++;
      } catch (error) {
        failed++;
        console.error(`Failed: ${name}`, error);
      }
    }
    pageToken = page.nextPageToken;
  } while (pageToken);

  console.log(
    `${dryRun ? "Would set" : "Set"} "${hazardPhotoCacheControl()}" on ${updated} object(s); ${failed} failed`,
  );
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
