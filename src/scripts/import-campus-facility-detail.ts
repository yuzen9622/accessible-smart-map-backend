/**
 * Backfill each facility's own coordinates from MOE MapInfo (one request per campus).
 * Only facilities with valid coordinates are skipped. FacilityResult HTML is used
 * when a point is absent from MapInfo; it can also supply accessibility specs.
 * Existing details and valid locations are retained when a source has no point.
 *
 * Run: pnpm import:campus-facility-detail [--limit 1] [--force]
 */

import "dotenv/config";
import mongoose from "mongoose";
import { fetchCampusMapLocations } from "../adapters/campus-map.adapter";
import { enrichCampusFacilities } from "./campus-a11y-sync";

const BASE_URL = "https://cam.moe.gov.tw";
const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36";
const REQUEST_DELAY_MS = 300;
const GET_TIMEOUT_MS = 60_000;
const POST_TIMEOUT_MS = 300_000;

interface Session {
  token: string;
  cookie: string;
}

function sleep(ms: number) {
  return new Promise<void>((r) => setTimeout(r, ms));
}

/** Loads the index page to capture the anti-forgery token + session cookie. */
async function createSession(): Promise<Session> {
  const res = await fetch(`${BASE_URL}/Facility/Index`, {
    headers: { "User-Agent": USER_AGENT },
    signal: AbortSignal.timeout(GET_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`GET /Facility/Index HTTP ${res.status}`);
  const cookie = res.headers
    .getSetCookie()
    .map((c) => c.split(";")[0])
    .join("; ");
  const html = await res.text();
  const m = /id="RequestVerificationToken"[^>]*value="([^"]+)"/.exec(html);
  if (!m) throw new Error("RequestVerificationToken not found on index page");
  return { token: m[1], cookie };
}

async function postFacilityResult(
  session: Session,
  payload: Record<string, string>,
): Promise<string> {
  await sleep(REQUEST_DELAY_MS);
  const res = await fetch(`${BASE_URL}/Facility/FacilityResult`, {
    method: "POST",
    headers: {
      "User-Agent": USER_AGENT,
      Cookie: session.cookie,
      "Content-Type": "application/json",
      RequestVerificationToken: session.token,
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(POST_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`POST FacilityResult HTTP ${res.status}`);
  return await res.text();
}

async function main() {
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) throw new Error("DATABASE_URL env var is required");

  const force = process.argv.includes("--force");
  const limitFlag = process.argv.indexOf("--limit");
  const limit =
    limitFlag >= 0 ? parseInt(process.argv[limitFlag + 1], 10) : Infinity;
  if (limitFlag >= 0 && (!Number.isInteger(limit) || limit < 1)) {
    throw new Error("--limit requires a positive integer value");
  }

  await mongoose.connect(dbUrl);
  try {
    let session: Session | undefined;
    const stats = await enrichCampusFacilities({
      force,
      limit,
      loadMap: async (branchId) => {
        await sleep(REQUEST_DELAY_MS);
        return fetchCampusMapLocations(branchId);
      },
      loadDetail: async (payload) => {
        session ??= await createSession();
        try {
          return await postFacilityResult(session, payload);
        } catch {
          session = await createSession();
          return postFacilityResult(session, payload);
        }
      },
    });
    console.log(
      `Done — ${stats.located} facilities located, ${stats.skipped} already located, ` +
        `${stats.missingCoordinates} without source coordinates, ${stats.failed} failed requests`,
    );
    if (stats.failed > 0)
      throw new Error("Campus coordinate enrichment had failed requests");
  } finally {
    await mongoose.disconnect();
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}
