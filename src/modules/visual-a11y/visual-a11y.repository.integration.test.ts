import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import VisualA11yModel from "../../model/visual-a11y.model";
import {
  findNearbyVisualA11y,
  upsertVisualA11yBatch,
} from "./visual-a11y.repository";
import {
  clearMongoTestDatabase,
  startMongoTest,
  stopMongoTest,
  type MongoTestContext,
} from "../../../tests/helpers/mongo-test-harness";

describe("visual-a11y repository with real MongoDB", () => {
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

  it("upserts by OSM node/type and reads the changed feature back nearby", async () => {
    const location = {
      type: "Point" as const,
      coordinates: [121.565, 25.033] as [number, number],
    };
    const first = await upsertVisualA11yBatch([
      {
        osmNodeId: 123,
        type: "audio_signal",
        location,
        properties: { roadName: "Old Road", buttonOperated: true },
        updatedAt: new Date("2024-01-01T00:00:00.000Z"),
      },
    ]);
    expect(first).toEqual({ inserted: 1, updated: 0 });

    const second = await upsertVisualA11yBatch([
      {
        osmNodeId: 123,
        type: "audio_signal",
        location,
        properties: { roadName: "Updated Road", buttonOperated: false },
        updatedAt: new Date("2024-01-02T00:00:00.000Z"),
      },
    ]);
    expect(second).toEqual({ inserted: 0, updated: 1 });

    const nearby = await findNearbyVisualA11y(
      25.033,
      121.565,
      500,
      "audio_signal",
    );
    expect(nearby).toHaveLength(1);
    expect(nearby[0]).toMatchObject({
      osmNodeId: 123,
      type: "audio_signal",
      properties: { roadName: "Updated Road", buttonOperated: false },
    });
    await expect(VisualA11yModel.countDocuments()).resolves.toBe(1);
  });
});
