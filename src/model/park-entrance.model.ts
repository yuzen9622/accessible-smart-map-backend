import { model, Schema } from "mongoose";
import { IParkEntrance } from "../types";

const parkEntranceSchema = new Schema<IParkEntrance>({
  sourceId: { type: String, required: true, unique: true },
  district: { type: String, default: null },
  parkName: { type: String, required: true },
  entranceName: { type: String, required: true },
  location: {
    type: { type: String, enum: ["Point"], required: true, default: "Point" },
    coordinates: { type: [Number], required: true },
  },
  minClearWidthM: { type: Number, default: null },
  slopePercent: { type: Number, default: null },
  importedAt: { type: Date, default: Date.now },
});

parkEntranceSchema.index({ location: "2dsphere" });

const ParkEntranceModel = model<IParkEntrance>(
  "ParkEntrance",
  parkEntranceSchema,
);

export default ParkEntranceModel;
