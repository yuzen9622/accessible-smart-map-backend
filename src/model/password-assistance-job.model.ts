import { Schema, model } from "mongoose";
import type { IPasswordAssistanceJob } from "../types";

const passwordAssistanceJobSchema = new Schema<IPasswordAssistanceJob>(
  {
    email: { type: String, required: true },
    status: {
      type: String,
      enum: ["pending", "processing", "failed"],
      default: "pending",
      required: true,
    },
    attempts: { type: Number, default: 0, required: true },
    availableAt: { type: Date, default: Date.now, required: true },
    lockedAt: { type: Date, default: null },
    leaseToken: { type: String, default: null },
    tokenExpiresAt: { type: Date, default: null },
    lastError: { type: String },
    expiresAt: { type: Date, required: true },
  },
  { timestamps: true },
);

passwordAssistanceJobSchema.index({ status: 1, availableAt: 1, createdAt: 1 });
passwordAssistanceJobSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

const PasswordAssistanceJob = model<IPasswordAssistanceJob>(
  "PasswordAssistanceJob",
  passwordAssistanceJobSchema,
);

export default PasswordAssistanceJob;
