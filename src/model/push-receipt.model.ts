import { Schema, model } from "mongoose";
import type { IPushReceipt } from "../types/push-receipt";

const pushReceiptSchema = new Schema<IPushReceipt>(
  {
    attemptId: { type: String, required: true, unique: true },
    userId: { type: String, required: true, index: true },
    tokenId: { type: String, required: true },
    registrationVersion: { type: String, required: true },
    authSessionId: { type: String, required: true },
    state: {
      type: String,
      enum: [
        "awaiting_ticket",
        "pending",
        "cleanup_pending",
        "provider_accepted",
        "failed",
        "unknown",
      ],
      required: true,
    },
    ticketId: { type: String, default: null },
    attempts: { type: Number, default: 0 },
    nextAttemptAt: { type: Date, required: true },
    deadlineAt: { type: Date, required: true },
    leaseToken: { type: String, default: null },
    leaseExpiresAt: { type: Date, default: null },
    errorCode: { type: String, default: null },
    createdAt: { type: Date, required: true },
    // TTL is asynchronous; every query also bounds itself by deadlineAt/state.
    expiresAt: { type: Date, required: true, index: { expireAfterSeconds: 0 } },
  },
  { timestamps: false },
);

pushReceiptSchema.index({ state: 1, nextAttemptAt: 1 });
pushReceiptSchema.index({ state: 1, deadlineAt: 1 });
pushReceiptSchema.index({ state: 1, leaseExpiresAt: 1 });

const PushReceipt = model<IPushReceipt>("PushReceipt", pushReceiptSchema);

export default PushReceipt;
