import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Client } from "pg";
import {
  acquireSidewalkArchive,
  SIDEWALK_COUNTIES,
} from "../adapters/sidewalk-source.adapter";
import { storeSidewalkSource } from "./sidewalk-source-store";

const container = `sidewalk-store-test-${process.pid}`;
let started = false;
let db: Client;
let dir: string;
let dbUrl: string;
function docker(...args: string[]) {
  return execFileSync("docker", args, {
    encoding: "utf8",
    timeout: 30_000,
  }).trim();
}
beforeAll(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "sidewalk-store-test-"));
  execFileSync("python3", [
    "-c",
    `
import zipfile,json,sys
from pathlib import Path
counties=json.loads(sys.argv[2])
for batch in ['202605','202606','202607']:
 with zipfile.ZipFile(Path(sys.argv[1])/(batch+'.zip'),'w',compression=zipfile.ZIP_DEFLATED) as z:
  for county in counties:
   ring=[[121,25],[121.001,25],[121.001,25.001],[121,25]]
   if batch=='202607' and county==counties[-1]:ring=[[121,25],[121.001,25.001],[121,25.001],[121.001,25],[121,25]]
   f={'type':'Feature','properties':{'COUNTY_NA':county,'SW_WTH':2,'SWW_WTH':1,'SW_RAMP':0},'geometry':{'type':'Polygon','coordinates':[ring]}}
   features=[f,f] if county==counties[0] else [f]
   z.writestr(f'SIDEWALK_{county}_{batch}_WGS84.geojson',json.dumps({'type':'FeatureCollection','features':features}))
`,
    dir,
    JSON.stringify(SIDEWALK_COUNTIES),
  ]);
  docker(
    "run",
    "-d",
    "--rm",
    "--name",
    container,
    "-e",
    "POSTGRES_PASSWORD=isolated-test",
    "-e",
    "POSTGRES_DB=sidewalk_test",
    "-p",
    "127.0.0.1::5432",
    "postgis/postgis:16-3.4-alpine",
  );
  started = true;
  const port = docker("port", container, "5432/tcp").split(":").at(-1);
  dbUrl = `postgres://postgres:isolated-test@127.0.0.1:${port}/sidewalk_test`;
  for (let attempt = 0; attempt < 60; attempt++) {
    const candidate = new Client({ connectionString: dbUrl });
    try {
      await candidate.connect();
      db = candidate;
      return;
    } catch (error) {
      await candidate.end();
      if (attempt === 59) throw error;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
}, 60_000);
afterAll(async () => {
  if (db) await db.end();
  if (started) docker("stop", "--time", "2", container);
  if (dir) await rm(dir, { recursive: true, force: true });
});
async function load(batch: string, dryRun = false) {
  const archive = await acquireSidewalkArchive({
    zip: path.join(dir, `${batch}.zip`),
  });
  try {
    return await storeSidewalkSource({
      dbUrl,
      file: archive.file,
      sha256: archive.sha256,
      sourceUrl: "test-only",
      dryRun,
    });
  } finally {
    await archive.cleanup();
  }
}
async function counts() {
  return (
    await db.query(
      "SELECT count(*)::int versions, count(*) FILTER (WHERE lifecycle_status='ACTIVE')::int active FROM ped_sidewalk_source_version",
    )
  ).rows[0];
}
describe("real isolated PostGIS source store", () => {
  it("rolls back dry-run schema and imports without a routing graph", async () => {
    const dry = await load("202605", true);
    expect(dry.report).toMatchObject({
      rawFeatureCount: 23,
      acceptedFeatureCount: 22,
      quarantinedFeatureCount: 1,
    });
    expect(
      (await db.query("SELECT to_regclass('ped_sidewalk_source_version') name"))
        .rows[0].name,
    ).toBeNull();
    await load("202605");
    expect(await counts()).toEqual({ versions: 1, active: 1 });
    expect(
      (await db.query("SELECT to_regclass('ped_graph_version') name")).rows[0]
        .name,
    ).toBeNull();
  });
  it("validates duplicate archives and serializes concurrent repeat imports", async () => {
    const results = await Promise.all([load("202605"), load("202605")]);
    expect(
      results.every((result) => result.idempotent && !result.published),
    ).toBe(true);
    expect(await counts()).toEqual({ versions: 1, active: 1 });
  });
  it("retains immutable history and does not publish a dry-run replacement", async () => {
    await load("202606", true);
    expect(await counts()).toEqual({ versions: 1, active: 1 });
    await load("202606");
    expect(await counts()).toEqual({ versions: 2, active: 1 });
    expect(
      (await db.query("SELECT count(*)::int n FROM ped_sidewalk_polygon"))
        .rows[0].n,
    ).toBe(44);
    expect(
      (
        await db.query(
          "SELECT source_batch FROM ped_sidewalk_source_version WHERE lifecycle_status='ACTIVE'",
        )
      ).rows[0].source_batch,
    ).toBe("202606");
  });
  it("reactivates the requested historical archive without duplicating its snapshot", async () => {
    const older = await load("202605");
    expect(older).toMatchObject({ idempotent: true, published: true });
    expect(await counts()).toEqual({ versions: 2, active: 1 });
    expect(
      (
        await db.query(
          "SELECT source_batch FROM ped_sidewalk_source_version WHERE lifecycle_status='ACTIVE'",
        )
      ).rows[0].source_batch,
    ).toBe("202605");
    const newer = await load("202606");
    expect(newer).toMatchObject({ idempotent: true, published: true });
    expect(await counts()).toEqual({ versions: 2, active: 1 });
    expect(
      (await db.query("SELECT count(*)::int n FROM ped_sidewalk_polygon"))
        .rows[0].n,
    ).toBe(44);
  });
  it("rejects PostGIS-invalid last-county geometry atomically without replacing ACTIVE", async () => {
    await expect(load("202607")).rejects.toThrow(/no accepted polygons/);
    expect(await counts()).toEqual({ versions: 2, active: 1 });
    expect(
      (
        await db.query(
          "SELECT source_batch FROM ped_sidewalk_source_version WHERE lifecycle_status='ACTIVE'",
        )
      ).rows[0].source_batch,
    ).toBe("202606");
  });
});
