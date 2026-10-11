import { afterAll, beforeAll, expect, it } from "vitest";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { safetyTransaction } from "./content-safety.transaction";
let server: MongoMemoryServer;
beforeAll(async () => {
  process.env.MONGOMS_DOWNLOAD_DIR ??= join(
    tmpdir(),
    "accessible-smart-map-mongodb-binaries",
  );
  server = await MongoMemoryServer.create();
  await mongoose.connect(server.getUri(), { dbName: "standalone_rejection" });
}, 60000);
afterAll(async () => {
  await mongoose.disconnect();
  await server?.stop();
});
it("fails closed on standalone without writing a partial case or quota", async () => {
  const db = mongoose.connection.db;
  if (!db) throw new Error("Test database is not connected");
  await db.createCollection("cases");
  await db.createCollection("quota");
  await expect(
    safetyTransaction(async (session) => {
      await db.collection("cases").insertOne({ fixture: true }, { session });
      await db.collection("quota").insertOne({ fixture: true }, { session });
    }),
  ).rejects.toMatchObject({ originalError: { code: 20 } });
  expect(await db.collection("cases").countDocuments()).toBe(0);
  expect(await db.collection("quota").countDocuments()).toBe(0);
});
