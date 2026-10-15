import { readFileSync } from "node:fs";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  clearMongoTestDatabase,
  startMongoTest,
  stopMongoTest,
  type MongoTestContext,
} from "../../../tests/helpers/mongo-test-harness";
import VenueModel from "../../model/venue.model";
import { compileVenue } from "./venue.compile";
import { parseOsmXml } from "./venue-osm.parse";
import {
  findVenue,
  findVenueVersion,
  listVenueSummaries,
  replaceVenue,
} from "./venue.repository";
import { clearVenueCache, planVenueRoute } from "./venue.service";

const { venue } = compileVenue(
  parseOsmXml(
    readFileSync(path.join(__dirname, "__fixtures__/mini-campus.osm"), "utf8"),
  ),
  { venueId: "mini", name: "Mini Campus" },
);
const importDoc = () => ({
  ...venue,
  importedAt: new Date("2026-10-14T00:00:00Z"),
  source: { file: "mini-campus.osm", sha256: "abc" },
  warnings: ["w"],
});

describe("venue repository with real MongoDB", () => {
  let mongo: MongoTestContext | undefined;

  beforeAll(async () => {
    mongo = await startMongoTest();
  });

  afterEach(async () => {
    await clearMongoTestDatabase();
    clearVenueCache();
  });

  afterAll(async () => {
    await stopMongoTest(mongo);
  });

  it("stores the whole compiled venue and bumps the version on every import", async () => {
    expect(await findVenueVersion("mini")).toBeNull();
    expect(await replaceVenue(importDoc())).toBe(1);
    expect(await replaceVenue(importDoc())).toBe(2);
    const stored = await findVenue("mini");
    expect(stored?.version).toBe(2);
    expect(stored?.edges).toHaveLength(venue.edges.length);
    expect(stored?.places.map((p) => p.id).sort()).toEqual(
      venue.places.map((p) => p.id).sort(),
    );
    const [summary] = await listVenueSummaries();
    expect(summary).toMatchObject({ venueId: "mini", version: 2 });
    expect(summary.buildings.map((b) => b.id).sort()).toEqual([
      "bldg-a",
      "bldg-b",
    ]);
  });

  it("gives concurrent imports distinct, increasing versions", async () => {
    // the harness drops the database between tests, indexes included
    await VenueModel.createIndexes();
    const versions = await Promise.all(
      Array.from({ length: 5 }, () => replaceVenue(importDoc())),
    );
    expect([...versions].sort()).toEqual([1, 2, 3, 4, 5]);
    expect(await findVenueVersion("mini")).toBe(5);
  });

  it("plans a route from the stored document", async () => {
    await replaceVenue(importDoc());
    const result = await planVenueRoute({
      venueId: "mini",
      fromPlaceId: "gate-main",
      toPlaceId: "a-room06@3F",
      mode: "wheelchair",
      lang: "zh-TW",
    });
    expect(result.ok && result.route.steps.map((s) => s.type)).toContain(
      "elevator",
    );
    expect(result.ok && result.route.venueVersion).toBe(1);
  });
});
