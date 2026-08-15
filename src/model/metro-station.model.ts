import { model, Schema } from "mongoose";
import { ITdxMetroStation } from "../types";

const metroStationSchema = new Schema<ITdxMetroStation>({
  stationUid: { type: String, required: true, unique: true },
  stationName: {
    Zh_tw: { type: String, required: true },
    En: { type: String },
  },
  railSystem: { type: String, required: true },
  lineIds: { type: [String], default: [] },
  location: {
    type: { type: String, enum: ["Point"], required: true, default: "Point" },
    coordinates: { type: [Number], required: true },
  },
  importedAt: { type: Date, default: Date.now },
});

metroStationSchema.index({ location: "2dsphere" });
metroStationSchema.index({ railSystem: 1 });

const MetroStationModel = model<ITdxMetroStation>(
  "MetroStation",
  metroStationSchema,
);
export default MetroStationModel;
