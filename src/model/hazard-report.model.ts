import { Schema, model } from "mongoose";
import type { IHazardReport } from "../types";

const GeoPoint = {
  type: { type: String, enum: ["Point"], required: true, default: "Point" },
  coordinates: { type: [Number], required: true },
};

const hazardReportSchema = new Schema<IHazardReport>(
  {
    reporterId: { type: String, required: true, index: true },

    reportedLocation: GeoPoint,

    hazardType: {
      type: String,
      enum: ["obstacle", "construction", "data_error"],
      required: true,
    },
    // Not `required` at the DB layer: the create-report Zod schema already
    // requires it for every new submission, but reports created before this
    // field existed have no value, and a hard-required path would throw on
    // their next confirm/deny save(). The default only protects those legacy
    // documents; every path that creates a report always supplies one.
    severity: {
      type: String,
      enum: ["blocking", "difficult", "minor"],
      default: "difficult",
    },
    expectedUntil: { type: Date, default: null },
    description: { type: String, maxlength: 500, default: null },
    photoUrl: { type: String, required: true },
    photoStoragePath: { type: String, required: true },

    exifValidation: {
      timestampFresh: { type: Boolean, required: true },
      gpsPresent: { type: Boolean, required: true },
      gpsMatchesClaimed: { type: Boolean, required: true },
      rawExifTime: String,
      rawExifLat: Number,
      rawExifLng: Number,
    },

    aiVerification: {
      verdict: {
        type: String,
        enum: ["verified", "suspicious", "rejected", "skipped"],
        required: true,
      },
      confidence: { type: Number, min: 0, max: 1, required: true },
      reason: { type: String, required: true },
      prefilter: {
        passed: Boolean,
        detectedLabels: { type: [String], default: undefined },
        safeSearchBlocked: Boolean,
      },
      attemptedAt: Date,
    },

    status: {
      type: String,
      enum: ["pending", "verified", "rejected", "expired"],
      default: "pending",
    },

    confirmCount: { type: Number, default: 0 },
    denyCount: { type: Number, default: 0 },
    confirmedBy: { type: [String], default: [] },
    deniedBy: { type: [String], default: [] },

    expiredAt: { type: Date, required: true },
  },
  { timestamps: true },
);

hazardReportSchema.index({ reportedLocation: "2dsphere" });
hazardReportSchema.index({ status: 1, createdAt: -1 });
hazardReportSchema.index({ hazardType: 1, status: 1 });
hazardReportSchema.index({ reporterId: 1, createdAt: -1 });
hazardReportSchema.index({ expiredAt: 1, status: 1 });

const HazardReport = model<IHazardReport>("HazardReport", hazardReportSchema);

export default HazardReport;
