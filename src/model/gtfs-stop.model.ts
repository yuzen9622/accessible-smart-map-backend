import { model, Schema } from "mongoose";
import type { IGtfsStop } from "../types";

const gtfsStopSchema = new Schema<IGtfsStop>({
  stopId: { type: String, required: true },
  stopName: { type: String, required: true },
  stopLat: { type: Number, required: true },
  stopLon: { type: Number, required: true },
  zoneId: { type: String },
  locationType: { type: Number, enum: [0, 1, 2, 3], default: 0 },
  parentStation: { type: String },
  levelId: { type: String },
  location: {
    type: { type: String, enum: ["Point"], required: true, default: "Point" },
    coordinates: { type: [Number], required: true },
  },
});

gtfsStopSchema.index({ stopId: 1 }, { unique: true });
gtfsStopSchema.index(
  { location: "2dsphere" },
  { partialFilterExpression: { locationType: { $in: [0, 2] } } },
);
gtfsStopSchema.index({ parentStation: 1 });

export const GtfsStop = model<IGtfsStop>("GtfsStop", gtfsStopSchema);
