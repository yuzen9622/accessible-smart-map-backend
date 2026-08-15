import mongoose from "mongoose";
import Review from "../model/review.model";

const LEGACY_INDEXES = [
  "osmId_1_placeType_1_userId_1",
  "osmId_1_placeType_1_status_1",
] as const;

/**
 * Rename the review location key from `osmId` to `placeId`.
 *
 * The field held a place identifier all along — OSM ids like "node/123456" for
 * OSM places, Mongo ids for the other place types. Once Google-sourced places
 * became reviewable the `osmId` name was simply wrong, so this is a pure rename:
 * no stored value changes.
 *
 * Both compound indexes lead with the renamed field and Mongoose never alters an
 * existing index, so they are dropped here and recreated on the new field name.
 * Every step is idempotent — a second run finds nothing to rename and no legacy
 * index to drop.
 */
async function main() {
  const uri = process.env.DATABASE_URL;
  if (!uri) throw new Error("DATABASE_URL is not set");

  await mongoose.connect(uri);
  const collection = Review.collection;

  const indexes = await collection.indexes();
  for (const name of LEGACY_INDEXES) {
    if (indexes.some((index) => index.name === name)) {
      await collection.dropIndex(name);
      console.log(`dropped legacy index ${name}`);
    } else {
      console.log(`index ${name} not present, nothing to drop`);
    }
  }

  const renamed = await collection.updateMany(
    { osmId: { $exists: true } },
    { $rename: { osmId: "placeId" } },
  );
  console.log(`renamed osmId → placeId on ${renamed.modifiedCount} review(s)`);

  await collection.createIndex(
    { placeId: 1, placeType: 1, userId: 1 },
    { unique: true },
  );
  await collection.createIndex({ placeId: 1, placeType: 1, status: 1 });
  console.log("ensured placeId compound indexes");

  await mongoose.disconnect();
}

main().catch(async (error) => {
  console.error(error);
  await mongoose.disconnect().catch(() => undefined);
  process.exit(1);
});
