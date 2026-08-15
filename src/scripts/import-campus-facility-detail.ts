/**
 * Stage-2 enrichment: fetch each campus facility's own coordinate + accessibility
 * specs from MOE `POST /Facility/FacilityResult` and store them on the facility
 * subdocument. The main import (`import:campus-a11y`) only captures campus-level
 * geo + building/floor; this backfills per-facility `location` / `specs`.
 *
 * Resumable & idempotent: by default skips facilities that already have
 * `location`. One request per deduplicated facility (~2 MB each, base64 photos
 * stripped by the parser), throttled by REQUEST_DELAY_MS.
 *
 * Run: npm run import:campus-facility-detail                 (all campuses)
 *      npm run import:campus-facility-detail -- --limit 1    (first N campuses)
 *      npm run import:campus-facility-detail -- --force      (re-fetch all)
 */

import "dotenv/config";
import mongoose from "mongoose";
import CampusA11yModel from "../model/campus-a11y.model";
import { ICampusA11y } from "../types";
import { parseFacilityDetailHtml } from "./campus-a11y-parse";

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
  if (limitFlag >= 0 && !Number.isInteger(limit)) {
    throw new Error("--limit requires an integer value");
  }

  await mongoose.connect(dbUrl);
  console.log("Connected to MongoDB");

  let session = await createSession();

  const campuses = (await CampusA11yModel.find({}).lean()) as ICampusA11y[];
  const targets = Number.isFinite(limit) ? campuses.slice(0, limit) : campuses;
  console.log(
    `Campuses: ${campuses.length}` +
      (Number.isFinite(limit) ? ` (limited to first ${targets.length})` : ""),
  );

  let enriched = 0;
  let skipped = 0;
  let failed = 0;

  for (let i = 0; i < targets.length; i++) {
    const campus = targets[i];
    let changed = 0;
    for (const fac of campus.facilities ?? []) {
      if (fac.location && !force) {
        skipped++;
        continue;
      }
      const floorId = fac.floorIds?.[0];
      if (!fac.buildingUid || !floorId) {
        skipped++;
        continue;
      }
      const payload = {
        INSTITUTION_ID: String(campus.schoolId),
        INSTITUTION_BRANCH_ID: String(campus.branchId),
        BUILDING_UID: fac.buildingUid,
        FACILITY_UID: fac.facUid,
        FLOOR_ID: floorId,
      };
      try {
        let html: string;
        try {
          html = await postFacilityResult(session, payload);
        } catch {
          session = await createSession();
          html = await postFacilityResult(session, payload);
        }
        const parsed = parseFacilityDetailHtml(html);
        if (parsed.geo) {
          fac.location = {
            type: "Point",
            coordinates: [parsed.geo.lng, parsed.geo.lat],
          };
        }
        fac.specs = parsed.specs;
        fac.detailFetchedAt = new Date();
        enriched++;
        changed++;
      } catch (err) {
        failed++;
        console.error(
          `  ${campus.schoolName} ${campus.branchName} / ${fac.facUid}:`,
          err instanceof Error ? err.message : err,
        );
      }
    }

    if (changed > 0) {
      await CampusA11yModel.updateOne(
        { _id: campus._id },
        { $set: { facilities: campus.facilities } },
      );
    }
    console.log(
      `[${i + 1}/${targets.length}] ${campus.schoolName} ${campus.branchName}: ${changed} enriched`,
    );
  }

  console.log(
    `Done — ${enriched} facilities enriched, ${skipped} skipped, ${failed} failed`,
  );
  await mongoose.disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
