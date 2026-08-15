import { randomUUID } from "node:crypto";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import { join } from "node:path";
import { tmpdir } from "node:os";

/** One isolated in-memory MongoDB instance owned by an integration-test file. */
export interface MongoTestContext {
  server: MongoMemoryServer;
  dbName: string;
}

/**
 * Starts a fresh MongoDB process and connects Mongoose's default connection to
 * a unique database. Repository modules use the default connection, so the
 * harness deliberately exercises the same model instances as production.
 */
export async function startMongoTest(): Promise<MongoTestContext> {
  if (mongoose.connection.readyState !== 0) {
    await mongoose.disconnect();
  }

  process.env.MONGOMS_DOWNLOAD_DIR ??= join(
    tmpdir(),
    "accessible-smart-map-mongodb-binaries",
  );
  const server = await MongoMemoryServer.create();
  const dbName = `repository_integration_${randomUUID().replace(/-/g, "")}`;

  try {
    await mongoose.connect(server.getUri(), {
      dbName,
      serverSelectionTimeoutMS: 10_000,
    });
    await Promise.all(
      Object.values(mongoose.models).map((model) => model.init()),
    );
  } catch (error) {
    await server.stop();
    throw error;
  }

  return { server, dbName };
}

/** Clears every collection in the current test database. */
export async function clearMongoTestDatabase(): Promise<void> {
  if (mongoose.connection.readyState !== 1) return;
  await mongoose.connection.dropDatabase();
}

/** Drops the test database, closes Mongoose, and stops the Mongo process. */
export async function stopMongoTest(
  context: MongoTestContext | undefined,
): Promise<void> {
  if (!context) return;

  try {
    await clearMongoTestDatabase();
  } finally {
    await mongoose.disconnect();
    await context.server.stop();
  }
}
