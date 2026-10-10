import { Schema, model } from "mongoose";
import type { ISosSession } from "../types";

const acknowledgementSchema = new Schema(
  {
    contactId: {
      type: Schema.Types.ObjectId,
      ref: "EmergencyContact",
      default: null,
    },
    lineUserId: { type: String, required: true },
    name: { type: String, default: null },
    at: { type: Date, required: true },
  },
  { _id: false },
);

const timelineEntrySchema = new Schema(
  {
    type: {
      type: String,
      enum: [
        "created",
        "notified",
        "acknowledged",
        "claimed",
        "status_update",
        "resolved",
      ],
      required: true,
    },
    actorType: {
      type: String,
      enum: ["victim", "contact", "system"],
      required: true,
    },
    actorLineUserId: { type: String, default: null },
    actorName: { type: String, default: null },
    note: { type: String, default: null },
    at: { type: Date, required: true },
  },
  { _id: false },
);

// Delivery state of the "SOS ended" notice for system auto-resolves, which
// must reach contacts even when LINE is briefly down. Manual resolves notify
// best-effort inline and never set this.
const resolvedNoticeSchema = new Schema(
  {
    status: {
      type: String,
      enum: ["pending", "sent", "failed"],
      required: true,
    },
    attempts: { type: Number, default: 0 },
    nextAttemptAt: { type: Date, required: true },
    claimId: { type: String, default: null },
    retryKey: { type: String, required: true },
    lastError: { type: String, default: null },
  },
  { _id: false },
);

const initialNoticeSchema = new Schema(
  {
    status: {
      type: String,
      enum: ["queued", "accepted", "failed", "skipped"],
      required: true,
    },
    recipients: { type: [String], required: true },
    payload: {
      type: new Schema(
        {
          userName: String,
          type: {
            type: String,
            enum: ["body", "trapped", "share_location"],
            required: true,
          },
          trackingUrl: { type: String, required: true },
          address: String,
        },
        { _id: false },
      ),
      required: true,
    },
    retryKey: { type: String, required: true },
    attempts: { type: Number, default: 0 },
    nextAttemptAt: { type: Date, required: true },
    retryUntil: { type: Date, required: true },
    claimId: { type: String, default: null },
    leaseUntil: { type: Date, default: null },
    notifiedCount: { type: Number, default: 0 },
  },
  { _id: false },
);

const sosSessionSchema = new Schema<ISosSession>(
  {
    userId: { type: String, required: true },
    type: {
      type: String,
      enum: ["body", "trapped", "share_location"],
      required: true,
    },
    status: {
      type: String,
      enum: ["active", "resolved"],
      default: "active",
    },
    handlingStatus: {
      type: String,
      enum: [
        "pending",
        "notified",
        "acknowledged",
        "claimed",
        "en_route",
        "arrived",
        "resolved",
      ],
      default: "notified",
    },
    lat: { type: Number, required: true, min: -90, max: 90 },
    lng: { type: Number, required: true, min: -180, max: 180 },
    address: { type: String, default: null },
    shareToken: { type: String, required: true },
    locationUpdatedAt: { type: Date, required: true },
    resolvedAt: { type: Date, default: null },
    claimedBy: { type: String, default: null },
    claimedByName: { type: String, default: null },
    claimedByContactId: {
      type: Schema.Types.ObjectId,
      ref: "EmergencyContact",
      default: null,
    },
    claimedAt: { type: Date, default: null },
    acknowledgements: { type: [acknowledgementSchema], default: [] },
    timeline: { type: [timelineEntrySchema], default: [] },
    staleAlertSent: { type: Boolean, default: false },
    autoResolved: { type: Boolean, default: false },
    initialNotice: { type: initialNoticeSchema, default: undefined },
    resolvedNotice: { type: resolvedNoticeSchema, default: undefined },
  },
  { timestamps: true },
);

sosSessionSchema.index(
  { userId: 1 },
  { unique: true, partialFilterExpression: { status: "active" } },
);
sosSessionSchema.index({ shareToken: 1 }, { unique: true });
sosSessionSchema.index({ status: 1, createdAt: 1 });
sosSessionSchema.index({ userId: 1, createdAt: -1 });
sosSessionSchema.index({ status: 1, locationUpdatedAt: 1 });
// Retention: resolved sessions are deleted after the policy deadline.
sosSessionSchema.index({ status: 1, resolvedAt: 1 });
sosSessionSchema.index(
  { "resolvedNotice.status": 1, "resolvedNotice.nextAttemptAt": 1 },
  { partialFilterExpression: { "resolvedNotice.status": "pending" } },
);

sosSessionSchema.index({
  "initialNotice.status": 1,
  status: 1,
  "initialNotice.nextAttemptAt": 1,
});

const SosSession = model<ISosSession>("SosSession", sosSessionSchema);

export default SosSession;
