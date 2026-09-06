/**
 * Grant or revoke the hazard-report manual-review admin role for a user.
 * Usage:
 *   npx dotenvx run -- ts-node src/scripts/set-user-role.ts <email> <user|admin>
 */

import "dotenv/config";
import mongoose from "mongoose";
import User from "../model/user.model";

const VALID_ROLES = ["user", "admin"];

async function main() {
  const [, , email, role] = process.argv;
  if (!email || !role) {
    throw new Error(
      "Usage: ts-node src/scripts/set-user-role.ts <email> <user|admin>",
    );
  }
  if (!VALID_ROLES.includes(role)) {
    throw new Error(`role must be one of: ${VALID_ROLES.join(", ")}`);
  }

  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) throw new Error("DATABASE_URL is required");
  await mongoose.connect(dbUrl);
  console.log("Connected to MongoDB");

  const user = await User.findOneAndUpdate(
    { email },
    { $set: { role } },
    { returnDocument: "after" },
  );

  if (!user) {
    console.error(`No user found with email: ${email}`);
    process.exitCode = 1;
  } else {
    console.log(`Updated ${user.email} → role=${user.role}`);
  }

  await mongoose.disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
