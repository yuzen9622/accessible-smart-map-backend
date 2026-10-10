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
    // Not `required` at the DB layer: retention removes both once the photo is
    // deleted. Every new report supplies them.
    photoUrl: { type: String },
    photoStoragePath: { type: String },

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

    // v2 review (public). Legacy reports have none.
    aiReview: {
      type: new Schema(
        {
          version: { type: Number, enum: [2], required: true },
          state: {
            type: String,
            enum: ["queued", "processing", "completed", "failed", "cancelled"],
            required: true,
          },
          decision: {
            type: String,
            enum: ["supported", "needs_evidence", "unsupported"],
          },
          reasonCode: { type: String, required: true },
          reason: { type: String, required: true },
          observations: { type: [String], default: undefined },
          limitations: { type: [String], default: undefined },
          requiredEvidence: { type: [String], default: undefined },
          visibleHazards: { type: [String], default: undefined },
          queuedAt: Date,
          startedAt: Date,
          completedAt: Date,
        },
        { _id: false },
      ),
      default: undefined,
    },
    // Internal work metadata: only the job repository selects it explicitly.
    aiReviewJob: {
      type: new Schema(
        {
          generation: { type: Number, required: true },
          attempts: { type: Number, required: true },
          nextAttemptAt: { type: Date, required: true },
          deadlineAt: { type: Date, required: true },
          leaseToken: String,
          leaseExpiresAt: Date,
          model: { type: String, required: true },
          policyVersion: { type: String, required: true },
          imageHash: { type: String, required: true },
          mimeType: { type: String, enum: ["image/jpeg", "image/png"] },
          errorCode: String,
          invalidOutputAttempts: Number,
        },
        { _id: false },
      ),
      default: undefined,
      select: false,
    },
    reviewNotification: {
      type: new Schema(
        {
          revision: { type: Number, required: true },
          result: { type: String, required: true },
          state: {
            type: String,
            enum: ["pending", "processing", "sent", "skipped", "expired"],
            required: true,
          },
          createdAt: { type: Date, required: true },
          deadlineAt: { type: Date, required: true },
          nextAttemptAt: { type: Date, required: true },
          attempts: { type: Number, required: true },
          leaseToken: String,
          leaseExpiresAt: Date,
          delivered: { type: [String], default: [] },
        },
        { _id: false },
      ),
      default: undefined,
      select: false,
    },
    // Private upload intake / cleanup tombstone. Never public.
    photoIntake: {
      type: new Schema(
        {
          state: {
            type: String,
            enum: ["uploading", "ready", "cleanup"],
            required: true,
          },
          uploadToken: { type: String, required: true },
          deadlineAt: { type: Date, required: true },
          storagePath: { type: String, required: true },
          nextCleanupAt: Date,
          cleanupAttempts: Number,
          cleanupUntil: Date,
        },
        { _id: false },
      ),
      default: undefined,
      select: false,
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

    manualReview: {
      reviewerId: { type: String },
      decision: { type: String, enum: ["verified", "rejected"] },
      note: { type: String, maxlength: 500 },
      reviewedAt: { type: Date },
    },

    expiredAt: { type: Date, required: true },

    // Retention (docs/PRIVACY_DATA_RETENTION.md). closedAt is set when the
    // report becomes rejected or expired and cleared if a review reopens it.
    closedAt: { type: Date, default: undefined },
    contentScrubbedAt: { type: Date, default: undefined },
    deidentifiedAt: { type: Date, default: undefined },
    photoDelete: {
      type: new Schema(
        { attempts: { type: Number, default: 0 }, nextAttemptAt: Date },
        { _id: false },
      ),
      default: undefined,
    },
  },
  // Feature operations must fail while disconnected, not wait in Mongoose's
  // buffering queue outside the driver's per-operation timeout.
  { timestamps: true, bufferCommands: false },
);

hazardReportSchema.index({ reportedLocation: "2dsphere" });
hazardReportSchema.index({ status: 1, createdAt: -1 });
hazardReportSchema.index({ hazardType: 1, status: 1 });
hazardReportSchema.index({ reporterId: 1, createdAt: -1 });
hazardReportSchema.index({ expiredAt: 1, status: 1 });
// Retention phase A (content scrub) candidates by either clock, and phase B
// (photo delete) candidates by backoff time.
hazardReportSchema.index({ contentScrubbedAt: 1, expiredAt: 1 });
hazardReportSchema.index({ contentScrubbedAt: 1, closedAt: 1 });
hazardReportSchema.index({
  contentScrubbedAt: 1,
  deidentifiedAt: 1,
  "photoDelete.nextAttemptAt": 1,
});

// AI worker claims: queued-due and processing-expired-lease.
hazardReportSchema.index({
  "aiReview.state": 1,
  "aiReviewJob.nextAttemptAt": 1,
});
hazardReportSchema.index({
  "aiReview.state": 1,
  "aiReviewJob.leaseExpiresAt": 1,
});
hazardReportSchema.index({
  "aiReview.state": 1,
  "aiReviewJob.deadlineAt": 1,
});
// Intake maintenance: overdue uploads and due tombstone cleanup.
hazardReportSchema.index({
  "photoIntake.state": 1,
  "photoIntake.deadlineAt": 1,
});
hazardReportSchema.index({
  "photoIntake.state": 1,
  "photoIntake.nextCleanupAt": 1,
});

hazardReportSchema.index({
  "reviewNotification.state": 1,
  "reviewNotification.nextAttemptAt": 1,
});
hazardReportSchema.index({
  "reviewNotification.state": 1,
  "reviewNotification.leaseExpiresAt": 1,
});
hazardReportSchema.index({
  "reviewNotification.state": 1,
  "reviewNotification.deadlineAt": 1,
});

const HazardReport = model<IHazardReport>("HazardReport", hazardReportSchema);

export default HazardReport;
