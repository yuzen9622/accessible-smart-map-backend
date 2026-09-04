import { model, Schema } from "mongoose";
import type { ITrafficSection } from "../types";

const trafficSectionSchema = new Schema<ITrafficSection>({
  sectionId: { type: String, required: true },
  city: { type: String, required: true },
  roadName: { type: String },
  roadClass: { type: Number },
  geometry: {
    type: {
      type: String,
      enum: ["LineString", "MultiLineString"],
      required: true,
    },
    coordinates: { type: Schema.Types.Mixed, required: true },
  },
  lengthM: { type: Number },
  roadDirection: { type: String },
  startKm: { type: Number },
  endKm: { type: Number },
  startPoint: { type: [Number] },
  updatedAt: { type: Date, default: Date.now },
});

trafficSectionSchema.index({ sectionId: 1 }, { unique: true });
trafficSectionSchema.index({ city: 1 });
trafficSectionSchema.index({ geometry: "2dsphere" });

const TrafficSectionModel = model<ITrafficSection>(
  "TrafficSection",
  trafficSectionSchema,
);

export default TrafficSectionModel;
