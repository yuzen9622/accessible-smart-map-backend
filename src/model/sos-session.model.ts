import { Schema, model } from "mongoose";
import type { ISosSession } from "../types";

const acknowledgementSchema = new Schema(
  {
    contactId: { type: Schema.Types.ObjectId, ref: "EmergencyContact", default: null },
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
      enum: ["created", "notified", "acknowledged", "claimed", "status_update", "resolved"],
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
      enum: ["notified", "acknowledged", "claimed", "en_route", "arrived", "resolved"],
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
    claimedByContactId: { type: Schema.Types.ObjectId, ref: "EmergencyContact", default: null },
    claimedAt: { type: Date, default: null },
    acknowledgements: { type: [acknowledgementSchema], default: [] },
    timeline: { type: [timelineEntrySchema], default: [] },
    staleAlertSent: { type: Boolean, default: false },
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

const SosSession = model<ISosSession>("SosSession", sosSessionSchema);

export default SosSession;
