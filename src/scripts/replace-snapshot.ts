import { randomUUID } from "crypto";
import type { Model } from "mongoose";

const CHUNK_SIZE = 500;

/** Build and validate a complete staging collection before an atomic rename. */
export async function replaceSnapshot<T>(
  model: Model<T>,
  docs: object[],
): Promise<number> {
  if (!docs.length)
    throw new Error("Refusing to replace a snapshot with zero valid rows");
  const database = model.db.db;
  if (!database)
    throw new Error("Snapshot import requires a connected database");
  const name = `${model.collection.name}_staging_${randomUUID().replace(/-/g, "")}`;
  const schema = model.schema.clone();
  schema.set("autoCreate", false);
  schema.set("autoIndex", false);
  const staging = model.db.model<T>(name, schema, name);
  let promoted = false;
  try {
    await staging.createCollection();
    for (let start = 0; start < docs.length; start += CHUNK_SIZE) {
      // Ordered writes surface validation/write errors instead of silently
      // promoting a partial snapshot. Every write remains isolated from live data.
      await staging.insertMany(docs.slice(start, start + CHUNK_SIZE), {
        ordered: true,
      });
    }
    if ((await staging.countDocuments()) !== docs.length) {
      throw new Error("Snapshot row count mismatch");
    }
    await staging.createIndexes();
    // Preserve operational indexes added outside the schema as well.
    const exists = await database
      .listCollections({ name: model.collection.name })
      .hasNext();
    if (exists) {
      for (const index of await model.collection.indexes()) {
        const { key, v: _version, ns: _namespace, ...options } = index;
        if (options.name !== "_id_")
          await staging.collection.createIndex(key, options);
      }
    }
    await staging.collection.rename(model.collection.name, {
      dropTarget: true,
    });
    promoted = true;
    return docs.length;
  } finally {
    if (!promoted) {
      await staging.collection.drop().catch((error: { code?: number }) => {
        if (error.code !== 26)
          console.error("Snapshot staging cleanup failed", error);
      });
    }
    model.db.deleteModel(name);
  }
}
