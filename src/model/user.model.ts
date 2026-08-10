import { Schema, model } from "mongoose";
import type { IUser } from "../types";
const userSchema = new Schema<IUser>(
  {
    name: { type: String, required: true },
    avatar: { type: String },
    email: { type: String, required: true, unique: true },
    client_id: { type: String },
    passwordHash: { type: String, select: false },
    authProviders: {
      type: [String],
      enum: ["google", "local"],
      default: [],
    },
    emailVerified: { type: Boolean, default: false },
    tokenVersion: { type: Number, default: 0 },
    passwordResetTokens: {
      type: [
        new Schema(
          {
            jobId: { type: String, required: true },
            tokenHash: { type: String, required: true },
            expiresAt: { type: Date, required: true },
            consumedAt: { type: Date },
          },
          { _id: false },
        ),
      ],
      select: false,
      default: [],
    },
    lineUserId: { type: String, default: null },
    settings: {
      memoryEnabled: { type: Boolean, default: false },
    },
  },
  { timestamps: true }
);

// Both of these are partial rather than sparse on purpose. A sparse index only
// skips documents where the field is absent, so the explicit nulls these fields
// default to would all be indexed and collide on the second account. Filtering
// on $type: "string" indexes only accounts that actually have the identifier.
userSchema.index(
  { lineUserId: 1 },
  { unique: true, partialFilterExpression: { lineUserId: { $type: "string" } } }
);
userSchema.index(
  { client_id: 1 },
  { unique: true, partialFilterExpression: { client_id: { $type: "string" } } }
);

const User = model<IUser>("User", userSchema);

export default User;
