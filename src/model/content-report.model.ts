import { Schema, model } from "mongoose";

export type MailRole = "team" | "reporter";
export interface ReportMail {
  state: "pending" | "sending" | "accepted" | "cancelled" | "manual_review";
  attempts: number;
  nextAttemptAt: Date;
  leaseToken?: string;
  leaseUntil?: Date;
  firstAttemptAt?: Date;
  acceptedAt?: Date;
  payload?: {
    from: string;
    to: string;
    subject: string;
    text: string;
    html: string;
  };
}
export interface ReportAdmission {
  state: "pending" | "admitted" | "rejected";
  hour: number;
  reason?: string;
  history: { state: string; hour: number; at: Date; reason?: string }[];
}
export interface ReportDecision {
  requestId: string;
  actorId: string;
  action: string;
  note: string;
  at: Date;
  state?: "pending" | "applied" | "superseded" | "failed";
  expectedVersion?: number;
  completedAt?: Date;
  reason?: string;
  attempts?: number;
  nextAttemptAt?: Date;
  receiptCleanupPending?: boolean;
}
export interface ContentReportRecord {
  _id: string;
  reporterId: string;
  reporterEmail?: string;
  targetType: "review" | "hazard_report";
  targetId: string;
  targetVersion: string;
  authorId: string;
  reason: string;
  details: string;
  language: "zh-TW" | "en";
  snapshot: string;
  status: "open" | "closed";
  createdAt: Date;
  purgeAt: Date;
  mails: { team: ReportMail; reporter: ReportMail };
  recoveryAt?: Date;
  admission?: ReportAdmission;
  decisions: ReportDecision[];
}
const mailSchema = new Schema<ReportMail>(
  {
    state: { type: String, required: true },
    attempts: { type: Number, default: 0 },
    nextAttemptAt: { type: Date, required: true },
    leaseToken: String,
    leaseUntil: Date,
    firstAttemptAt: Date,
    acceptedAt: Date,
    payload: {
      from: String,
      to: String,
      subject: String,
      text: String,
      html: String,
    },
  },
  { _id: false },
);
const schema = new Schema<ContentReportRecord>({
  reporterId: { type: String, required: true },
  reporterEmail: String,
  targetType: {
    type: String,
    enum: ["review", "hazard_report"],
    required: true,
  },
  targetId: { type: String, required: true },
  targetVersion: { type: String, required: true },
  authorId: { type: String, required: true },
  reason: { type: String, required: true },
  details: { type: String, default: "" },
  language: { type: String, required: true },
  snapshot: { type: String, default: "" },
  status: { type: String, default: "open" },
  createdAt: { type: Date, required: true },
  purgeAt: { type: Date, required: true },
  mails: {
    team: { type: mailSchema, required: true },
    reporter: { type: mailSchema, required: true },
  },
  recoveryAt: Date,
  admission: {
    type: new Schema<ReportAdmission>(
      {
        state: {
          type: String,
          enum: ["pending", "admitted", "rejected"],
          required: true,
        },
        hour: { type: Number, required: true },
        reason: String,
        history: [
          { _id: false, state: String, hour: Number, at: Date, reason: String },
        ],
      },
      { _id: false },
    ),
    default: undefined,
  },
  decisions: [
    {
      _id: false,
      requestId: String,
      actorId: String,
      action: String,
      note: String,
      at: Date,
      state: String,
      expectedVersion: Number,
      completedAt: Date,
      reason: String,
      attempts: Number,
      nextAttemptAt: Date,
      receiptCleanupPending: Boolean,
    },
  ],
});
schema.index(
  { reporterId: 1, targetType: 1, targetId: 1, targetVersion: 1 },
  { unique: true },
);
schema.index({ "admission.state": 1, createdAt: 1 });
schema.index({ "decisions.state": 1, "decisions.nextAttemptAt": 1 });
schema.index({ purgeAt: 1 }, { expireAfterSeconds: 0 });
for (const role of ["team", "reporter"])
  schema.index({
    [`mails.${role}.state`]: 1,
    [`mails.${role}.nextAttemptAt`]: 1,
  });
export default model<ContentReportRecord>("ContentReport", schema);
