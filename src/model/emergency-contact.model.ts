import { Schema, model } from "mongoose";
import type { IEmergencyContact } from "../types";

const emergencyContactSchema = new Schema<IEmergencyContact>(
  {
    userId: { type: String, required: true, index: true },
    name: { type: String, required: true, maxlength: 50 },
    lineUserId: { type: String, default: null },
    bindStatus: {
      type: String,
      enum: ["pending", "bound"],
      default: "pending",
    },
    bindCode: { type: String, default: null },
    bindCodeExpiresAt: { type: Date, default: null },
    lastLineLat: { type: Number, default: null },
    lastLineLng: { type: Number, default: null },
    lastLineLocationUpdatedAt: { type: Date, default: null },
  },
  { timestamps: true },
);

emergencyContactSchema.index({ userId: 1, createdAt: -1 });
emergencyContactSchema.index({ bindCode: 1 }, { unique: true, sparse: true });
emergencyContactSchema.index({ lineUserId: 1 }, { sparse: true });

const EmergencyContact = model<IEmergencyContact>(
  "EmergencyContact",
  emergencyContactSchema,
);

export default EmergencyContact;
