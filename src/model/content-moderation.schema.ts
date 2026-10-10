import { Schema } from "mongoose";

/** Internal recovery receipts: no actor, reason, email or user text. */
export interface ContentModeration {
  version: number;
  receipts: { key: string; caseId: string; at: Date }[];
}
export const contentModerationSchema = new Schema<ContentModeration>(
  {
    version: { type: Number, required: true },
    receipts: [{ _id: false, key: String, caseId: String, at: Date }],
  },
  { _id: false },
);
