import mongoose from "mongoose";
import User from "../model/user.model";
import Config from "../model/config.model";

/**
 * Migration script: Migrate legacy `User.settings.memoryEnabled` to `Config.memoryEnabled`.
 *
 * This migration is idempotent:
 * 1. Queries all users in the `users` collection that have `settings.memoryEnabled`.
 * 2. Upserts or sets `memoryEnabled` on the corresponding `configs` document.
 * 3. Unsets the legacy `settings` field on the user document.
 */
async function main() {
  const uri = process.env.DATABASE_URL;
  if (!uri) throw new Error("DATABASE_URL is not set");

  await mongoose.connect(uri);
  console.log("Connected to database.");

  const userCollection = User.collection;
  const configCollection = Config.collection;

  // Find users with legacy settings field
  const legacyUsers = await userCollection
    .find({ "settings.memoryEnabled": { $exists: true } })
    .project({ _id: 1, settings: 1 })
    .toArray();

  console.log(`Found ${legacyUsers.length} user(s) with legacy settings.`);

  let migratedCount = 0;
  for (const user of legacyUsers) {
    const memoryEnabled = Boolean(user.settings?.memoryEnabled);

    // Upsert into configs collection
    await configCollection.updateOne(
      { user_id: user._id },
      {
        $set: { memoryEnabled },
        $setOnInsert: {
          language: "zh-TW",
          darkMode: "system",
          themeColor: "default",
          fontSize: "medium",
          notifications: true,
          accessibility: {
            mobilityAid: null,
            canUseStairs: null,
            maxSlopePercent: null,
            needsAccessibleToilet: null,
            needsElevator: null,
            needsHandrail: null,
            visualAssistance: null,
            preferredFontScale: null,
          },
        },
      },
      { upsert: true },
    );

    migratedCount++;
  }

  console.log(`Migrated ${migratedCount} config document(s).`);

  // Unset legacy settings on User collection
  const unsetResult = await userCollection.updateMany(
    { settings: { $exists: true } },
    { $unset: { settings: "" } },
  );

  console.log(
    `Removed legacy 'settings' from ${unsetResult.modifiedCount} user document(s).`,
  );

  await mongoose.disconnect();
  console.log("Migration completed successfully.");
}

main().catch((error) => {
  console.error("Migration failed:", error);
  process.exit(1);
});
