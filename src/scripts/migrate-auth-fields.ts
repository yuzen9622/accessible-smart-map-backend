import mongoose from "mongoose";
import User from "../model/user.model";

const LEGACY_INDEXES = [
  { name: "client_id_1", field: "client_id" },
  { name: "lineUserId_1", field: "lineUserId" },
] as const;

/**
 * Prepare the users collection for email + password authentication.
 *
 * Two unique indexes need replacing, and Mongoose never alters an existing one:
 *
 * - client_id_1 is a plain unique index, so it would reject every account after
 *   the first one that has no Google subject.
 * - lineUserId_1 is unique + sparse, and sparse only skips documents where the
 *   field is absent. Every account created since `default: null` was introduced
 *   stores an explicit null, so the second such account already collides — this
 *   is why new signups fail before this migration runs.
 *
 * Both become partial unique indexes filtered on $type: "string", which indexes
 * only accounts that actually carry the identifier.
 */
async function main() {
  const uri = process.env.DATABASE_URL;
  if (!uri) throw new Error("DATABASE_URL is not set");

  await mongoose.connect(uri);
  const collection = User.collection;

  const indexes = await collection.indexes();

  for (const { name, field } of LEGACY_INDEXES) {
    const existing = indexes.find((index) => index.name === name);

    if (existing && !existing.partialFilterExpression) {
      await collection.dropIndex(name);
      console.log(`dropped legacy index ${name}`);
    } else if (existing) {
      console.log(`index ${name} already partial, leaving as is`);
    } else {
      console.log(`index ${name} not present, nothing to drop`);
    }

    await collection.createIndex(
      { [field]: 1 },
      { unique: true, partialFilterExpression: { [field]: { $type: "string" } } },
    );
    console.log(`ensured partial unique index on ${field}`);
  }

  const backfill = await collection.updateMany(
    { authProviders: { $exists: false } },
    [
      {
        $set: {
          authProviders: {
            $cond: [{ $ifNull: ["$client_id", false] }, ["google"], []],
          },
          emailVerified: {
            $cond: [{ $ifNull: ["$client_id", false] }, true, false],
          },
          tokenVersion: 0,
        },
      },
    ],
  );
  console.log(`backfilled ${backfill.modifiedCount} user(s)`);

  const stripped = await collection.updateMany(
    { client_id: null },
    { $unset: { client_id: "" } },
  );
  console.log(`removed null client_id from ${stripped.modifiedCount} user(s)`);

  await mongoose.disconnect();
}

main().catch(async (error) => {
  console.error(error);
  await mongoose.disconnect().catch(() => undefined);
  process.exit(1);
});
