/**
 * One-shot import: MOE Campus Accessibility Map (cam.moe.gov.tw) → MongoDB.
 *
 * MapInfo supplies public per-facility coordinates. The detailed list returns
 * server-rendered HTML (with base64-inlined photos, 20+ MB per campus), so the
 * crawl walks City → Institution → Branch, POSTs the facility search per
 * campus, and parses the HTML via campus-a11y-parse. POST endpoints require an
 * ASP.NET anti-forgery token + cookie pair captured from the index page; no
 * login is needed.
 *
 * Run: pnpm import:campus-a11y                (full crawl, upsert complete campuses)
 *      pnpm import:campus-a11y --limit 5      (first N schools)
 * Existing details are retained by facility UID; failed/unvisited campuses remain intact.
 */

import "dotenv/config";
import mongoose from "mongoose";
import { fetchCampusMapData } from "../adapters/campus-map.adapter";
import { syncCampusDocuments } from "./campus-a11y-sync";
import { ICampusA11y } from "../types";
import { parseFacilityResultHtml } from "./campus-a11y-parse";
import {
  buildAliasNames,
  buildSearchName,
} from "../modules/campus/campus.util";

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

interface IdName {
  ID: number;
  NAME: string;
}

function sleep(ms: number) {
  return new Promise<void>((r) => setTimeout(r, ms));
}

/**
 * Loads the facility index page to capture the anti-forgery token and the
 * session cookies required by the POST endpoints.
 * @returns token + cookie pair for subsequent requests
 */
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

async function getJson<T>(session: Session, path: string): Promise<T> {
  await sleep(REQUEST_DELAY_MS);
  const res = await fetch(`${BASE_URL}${path}`, {
    headers: { "User-Agent": USER_AGENT, Cookie: session.cookie },
    signal: AbortSignal.timeout(GET_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`GET ${path} HTTP ${res.status}`);
  return (await res.json()) as T;
}

async function postFacilityResultList(
  session: Session,
  payload: Record<string, string>,
): Promise<string> {
  await sleep(REQUEST_DELAY_MS);
  const res = await fetch(`${BASE_URL}/Facility/FacilityResultList`, {
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
  if (!res.ok) throw new Error(`POST FacilityResultList HTTP ${res.status}`);
  return await res.text();
}

interface BranchCrawlOptions {
  school: IdName;
  branches: IdName[];
  city?: string;
  facTypeQuery: string;
  loadList: (payload: Record<string, string>) => Promise<string>;
  loadMap: typeof fetchCampusMapData;
}

/** A failed branch must not prevent the remaining branches from being visited. */
export async function crawlCampusBranches({
  school,
  branches,
  city,
  facTypeQuery,
  loadList,
  loadMap,
}: BranchCrawlOptions) {
  const docs: Omit<ICampusA11y, "_id">[] = [];
  let empty = 0;
  let failed = 0;
  for (const branch of branches) {
    try {
      const parsed = parseFacilityResultHtml(
        await loadList({
          INSTITUTION: String(school.ID),
          INSTITUTION_BRANCH_ID: String(branch.ID),
          CITY: "",
          FacType: facTypeQuery,
        }),
      );
      if (!parsed.noResult && !parsed.complete)
        throw new Error("Incomplete facility list");
      const { locations, facilityUids } = await loadMap(branch.ID);
      if (parsed.noResult || parsed.facilityCount === 0) {
        if (facilityUids.size > 0)
          throw new Error("Empty list conflicts with MapInfo");
        // Directory entries with no facilities have nothing to import; retain any stored data.
        empty++;
        continue;
      }

      const listedUids = new Set(parsed.facilities.map((f) => f.facUid));
      if ([...facilityUids].some((uid) => !listedUids.has(uid))) {
        throw new Error("MapInfo has facilities absent from the campus list");
      }
      docs.push({
        schoolId: school.ID,
        schoolName: school.NAME,
        branchId: branch.ID,
        branchName: branch.NAME,
        city,
        address: parsed.address ?? undefined,
        phone: parsed.phone ?? undefined,
        buildingCount: parsed.buildingCount,
        facilityCount: parsed.facilityCount,
        facilities: parsed.facilities.map((f) => ({
          facUid: f.facUid,
          facTypeId: f.facTypeId ?? undefined,
          facType: f.facType ?? undefined,
          name: f.name,
          building: f.building ?? undefined,
          buildingUid: f.buildingUid ?? undefined,
          floors: f.floors,
          floorIds: f.floorIds,
          location: locations.get(f.facUid),
        })),
        location: parsed.campusGeo
          ? {
              type: "Point",
              coordinates: [parsed.campusGeo.lng, parsed.campusGeo.lat],
            }
          : undefined,
        searchName: buildSearchName(school.NAME, branch.NAME),
        aliasNames: buildAliasNames(school.NAME),
        importedAt: new Date(),
      });
    } catch (error) {
      failed++;
      console.error(
        `Campus ${school.NAME} / ${branch.NAME} (${branch.ID}) failed:`,
        error,
      );
    }
  }
  return { docs, empty, failed };
}

async function main() {
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) throw new Error("DATABASE_URL env var is required");

  const limitFlag = process.argv.indexOf("--limit");
  const limit =
    limitFlag >= 0 ? parseInt(process.argv[limitFlag + 1], 10) : Infinity;
  if (limitFlag >= 0 && (!Number.isInteger(limit) || limit < 1)) {
    throw new Error("--limit requires a positive integer value");
  }

  let session = await createSession();

  const facTypes = await getJson<{ MAP_NAME: string }[]>(
    session,
    "/api/Base/FacType",
  );
  const facTypeQuery = facTypes.map((t) => t.MAP_NAME).join(",");
  console.log(`Facility types: ${facTypes.length}`);

  const cities = await getJson<IdName[]>(session, "/api/Base/City");
  const cityBySchool = new Map<number, string>();
  for (const city of cities) {
    const schools = await getJson<IdName[]>(
      session,
      `/api/Base/Institution?CITY_ID=${city.ID}`,
    );
    for (const s of schools) cityBySchool.set(s.ID, city.NAME);
  }

  const institutions = await getJson<IdName[]>(
    session,
    "/api/Base/Institution",
  );
  const targets = Number.isFinite(limit)
    ? institutions.slice(0, limit)
    : institutions;
  console.log(
    `Schools: ${institutions.length}` +
      (Number.isFinite(limit) ? ` (limited to first ${targets.length})` : ""),
  );

  const docs: Omit<ICampusA11y, "_id">[] = [];
  let emptyCampuses = 0;
  let failedSchools = 0;
  let failedBranches = 0;
  for (let i = 0; i < targets.length; i++) {
    const inst = targets[i];
    try {
      const branches = await getJson<IdName[]>(
        session,
        `/api/Base/InstitutionBranch?INSTITUTION_ID=${inst.ID}`,
      );
      const result = await crawlCampusBranches({
        school: inst,
        branches,
        city: cityBySchool.get(inst.ID),
        facTypeQuery,
        loadMap: fetchCampusMapData,
        loadList: async (payload) => {
          try {
            return await postFacilityResultList(session, payload);
          } catch {
            session = await createSession();
            return postFacilityResultList(session, payload);
          }
        },
      });
      docs.push(...result.docs);
      emptyCampuses += result.empty;
      failedBranches += result.failed;
      const facilityTotal = result.docs.reduce(
        (n, doc) => n + doc.facilities.length,
        0,
      );
      console.log(
        `[${i + 1}/${targets.length}] ${inst.NAME}: ${branches.length} campuses, ${facilityTotal} facilities`,
      );
    } catch (err) {
      failedSchools++;
      console.error(
        `[${i + 1}/${targets.length}] ${inst.NAME} failed:`,
        err instanceof Error ? err.message : err,
      );
    }
  }

  console.log("Failed campus requests:", failedBranches);
  const totalFacilities = docs.reduce((n, d) => n + d.facilities.length, 0);
  const locatedFacilities = docs.reduce(
    (n, d) => n + d.facilities.filter((f) => f.location !== undefined).length,
    0,
  );
  console.log("Facility coordinates:", {
    located: locatedFacilities,
    missing: totalFacilities - locatedFacilities,
  });
  console.log(
    `Crawl done — ${docs.length} campuses with data, ${emptyCampuses} empty, ` +
      `${failedSchools} schools failed, ${totalFacilities} facilities`,
  );

  if (docs.length === 0) throw new Error("No complete campus data to write");
  await mongoose.connect(dbUrl);
  try {
    const res = await syncCampusDocuments(docs);
    console.log(
      `✓ Wrote ${docs.length} campuses (${res.upsertedCount} inserted, ${res.modifiedCount} updated)`,
    );
  } finally {
    await mongoose.disconnect();
  }
  if (failedSchools > 0 || failedBranches > 0) {
    throw new Error(
      "Campus crawl incomplete: " +
        failedSchools +
        " school list failures, " +
        failedBranches +
        " campus failures; stored data retained",
    );
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}
