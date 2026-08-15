import { model, Schema } from "mongoose";
import type { IGtfsPathway } from "../types";

const gtfsPathwaySchema = new Schema<IGtfsPathway>({
  pathwayId: { type: String, required: true },
  fromStopId: { type: String, required: true },
  toStopId: { type: String, required: true },
  pathwayMode: { type: Number, enum: [1, 2, 3, 4, 5, 6, 7], required: true },
  isBidirectional: { type: Number, enum: [0, 1], required: true },
  traversalTime: { type: Number },
  stairCount: { type: Number },
});

gtfsPathwaySchema.index({ pathwayId: 1 }, { unique: true });
gtfsPathwaySchema.index({ fromStopId: 1, pathwayMode: 1 });
gtfsPathwaySchema.index({ toStopId: 1 });

export const GtfsPathway = model<IGtfsPathway>(
  "GtfsPathway",
  gtfsPathwaySchema,
);
