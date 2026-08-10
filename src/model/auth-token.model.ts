import { Schema, model } from "mongoose";
import type { IAuthToken } from "../types";

const authTokenSchema = new Schema<IAuthToken>(
  {
    userId: { type: String, required: true },
    type: {
      type: String,
      enum: ["email_verify", "password_reset"],
      required: true,
    },
    tokenHash: { type: String, required: true, unique: true },
    expiresAt: { type: Date, required: true },
    usedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

authTokenSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
// Token rotation uses an atomic upsert on this identity. Uniqueness guarantees
// concurrent issuers cannot leave two valid tokens for the same user and flow.
authTokenSchema.index({ userId: 1, type: 1 }, { unique: true });

const AuthToken = model<IAuthToken>("AuthToken", authTokenSchema);

export default AuthToken;
