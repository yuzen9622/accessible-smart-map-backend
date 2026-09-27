import { Schema, model } from "mongoose";
import type { IAuthSession } from "../types";

const recentRefreshJtiSchema = new Schema(
  {
    jti: { type: String, required: true },
    rotatedAt: { type: Date, required: true },
  },
  { _id: false },
);

const authSessionSchema = new Schema<IAuthSession>(
  {
    userId: {
      type: String,
      ref: "User",
      required: true,
      index: true,
    },
    currentRefreshJti: { type: String, required: true },
    previousRefreshJti: { type: String, default: null },
    recentRefreshJtis: {
      type: [recentRefreshJtiSchema],
      default: [],
    },
    rotatedAt: { type: Date, default: null },
    expiresAt: { type: Date, required: true },
    revokedAt: { type: Date, default: null },
    revokedReason: { type: String, default: null },
  },
  { timestamps: true },
);

// TTL index on expiresAt allows MongoDB's background task to prune expired sessions
authSessionSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

const AuthSession = model<IAuthSession>("AuthSession", authSessionSchema);

export default AuthSession;
