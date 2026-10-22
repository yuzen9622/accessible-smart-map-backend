import fs from "fs";
import { Readable } from "stream";
import { pipeline } from "stream/promises";
import type { ReadableStream as WebReadableStream } from "stream/web";
import { tdxFetch } from "../config/fetch";

/**
 * TDX national GTFS static feed (the same feed the OTP graph build fetches).
 * A ~470 MB zip, so it is streamed to disk rather than buffered.
 */

const TDX_NATIONAL_GTFS_URL =
  "https://tdx.transportdata.tw/api/gtfs/V3/Map/GTFS/Static";
/** Whole-transfer cap; a normal download takes about a minute. */
const TDX_GTFS_TIMEOUT_MS = 30 * 60_000;

/**
 * Download the national GTFS zip.
 *
 * @param destPath Where to write the zip; left partial on failure, so pass a
 *                 staging path.
 */
export async function downloadNationalGtfs(destPath: string): Promise<void> {
  const signal = AbortSignal.timeout(TDX_GTFS_TIMEOUT_MS);
  const res = await tdxFetch(TDX_NATIONAL_GTFS_URL, { signal });
  if (!res.ok || !res.body)
    throw new Error(`TDX GTFS download failed: HTTP ${res.status}`);
  await pipeline(
    Readable.fromWeb(res.body as WebReadableStream<Uint8Array>),
    fs.createWriteStream(destPath),
    { signal },
  );
}
