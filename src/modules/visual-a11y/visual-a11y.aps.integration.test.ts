import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import VisualA11yModel from "../../model/visual-a11y.model";
import { migrateVisualA11ySource } from "../../scripts/migrate-visual-a11y-source";
import {
  findAudioSignalsInBbox,
  upsertVisualA11yBatch,
} from "./visual-a11y.repository";
import { syncTaipeiAps } from "./visual-a11y.service";
import {
  clearMongoTestDatabase,
  startMongoTest,
  stopMongoTest,
  type MongoTestContext,
} from "../../../tests/helpers/mongo-test-harness";

const CSV =
  "項次,路口,行政區,號誌編號,WGS84經度座標,WGS84緯度座標\n" +
  "1,八德路三段　　光復北路,松山區,SKWPX10,121.55782,25.048206\n" +
  "2,八德路三段　　延吉街,松山區,SKWP510,121.55333,25.048195\n";

describe("visual_a11ys source migration + Taipei APS (real MongoDB)", () => {
  let mongo: MongoTestContext | undefined;

  beforeAll(async () => {
    mongo = await startMongoTest();
  });

  afterEach(async () => {
    await clearMongoTestDatabase();
  });

  afterAll(async () => {
    await stopMongoTest(mongo);
  });

  async function seedLegacy(): Promise<void> {
    await VisualA11yModel.collection.dropIndexes().catch(() => undefined);
    await VisualA11yModel.collection.createIndex(
      { osmNodeId: 1, type: 1 },
      { unique: true, name: "osmNodeId_1_type_1" },
    );
    await VisualA11yModel.collection.createIndex({ location: "2dsphere" });
    await VisualA11yModel.collection.insertOne({
      osmNodeId: 42,
      type: "audio_signal",
      location: { type: "Point", coordinates: [121.5578, 25.0482] },
      properties: {},
      updatedAt: new Date(),
    });
  }

  it("backfills legacy OSM docs, swaps the index, and is idempotent", async () => {
    await seedLegacy();

    const first = await migrateVisualA11ySource();
    expect(first).toEqual({
      backfilled: 1,
      droppedLegacyIndex: true,
      missing: 0,
    });
    const doc = await VisualA11yModel.findOne({ osmNodeId: 42 }).lean();
    expect(doc).toMatchObject({ source: "osm", sourceId: "42" });

    const second = await migrateVisualA11ySource();
    expect(second).toEqual({
      backfilled: 0,
      droppedLegacyIndex: false,
      missing: 0,
    });

    const names = (await VisualA11yModel.collection.indexes()).map(
      (i) => i.name,
    );
    expect(names).not.toContain("osmNodeId_1_type_1");
    expect(names).toContain("source_1_sourceId_1_type_1");
  });

  it("imports several Taipei signals next to OSM ones after migrating", async () => {
    await seedLegacy();
    await migrateVisualA11ySource();

    const result = await syncTaipeiAps(CSV);
    expect(result).toEqual({ parsed: 2, inserted: 2, updated: 0 });
    expect(await syncTaipeiAps(CSV)).toMatchObject({ inserted: 0 });

    const inBox = await findAudioSignalsInBbox([121.55, 25.04, 121.56, 25.05]);
    expect(inBox.map((d) => d.source).sort()).toEqual([
      "osm",
      "taipei_tce",
      "taipei_tce",
    ]);
    const named = inBox.find((d) => d.sourceId === "SKWPX10");
    expect(named?.properties.name).toBe("八德路三段 光復北路");
  });

  it("keeps the OSM sync keyed by node id and writes the source fields", async () => {
    await VisualA11yModel.createIndexes();
    const doc = {
      osmNodeId: 7,
      type: "audio_signal" as const,
      location: {
        type: "Point" as const,
        coordinates: [121.5, 25.0] as [number, number],
      },
      properties: {},
      updatedAt: new Date(),
    };
    await upsertVisualA11yBatch([doc]);
    await upsertVisualA11yBatch([doc]);

    const docs = await VisualA11yModel.find({ osmNodeId: 7 }).lean();
    expect(docs).toHaveLength(1);
    expect(docs[0]).toMatchObject({ source: "osm", sourceId: "7" });
  });
});
