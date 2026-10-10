import { Schema, model } from "mongoose";

export interface UserBlockRecord {
  _id: string;
  ownerId: string;
  blockedUserId: string;
  sourceType: "review" | "hazard_report";
  createdAt: Date;
}
const schema = new Schema<UserBlockRecord>({
  ownerId: { type: String, required: true },
  blockedUserId: { type: String, required: true },
  sourceType: {
    type: String,
    enum: ["review", "hazard_report"],
    required: true,
  },
  createdAt: { type: Date, required: true },
});
schema.index({ ownerId: 1, blockedUserId: 1 }, { unique: true });
schema.index({ blockedUserId: 1 });
export default model<UserBlockRecord>("UserBlock", schema);
