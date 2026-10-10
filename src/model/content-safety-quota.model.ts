import { Schema, model } from "mongoose";

/** Shared across API processes; atomic ceiling on new report email fan-out. */
const schema = new Schema<{
  _id: string;
  count: number;
  expiresAt: Date;
  caseIds: string[];
}>({
  _id: { type: String, required: true },
  count: { type: Number, required: true },
  caseIds: { type: [String], default: [] },
  expiresAt: { type: Date, required: true },
});
schema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
export default model("ContentSafetyQuota", schema);
