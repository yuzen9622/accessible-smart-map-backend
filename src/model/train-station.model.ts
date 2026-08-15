import { model, Schema } from "mongoose";
import { ITdxTrainStation } from "../types";

const trainStationSchema = new Schema<ITdxTrainStation>({
  stationUID: { type: String, required: true, unique: true },
  stationID: { type: String, required: true },
  stationName: {
    Zh_tw: { type: String, required: true },
    En: { type: String },
  },
  railSystem: { type: String, required: true },
  location: {
    type: { type: String, enum: ["Point"], required: true, default: "Point" },
    coordinates: { type: [Number], required: true },
  },
  importedAt: { type: Date, default: Date.now },
});

trainStationSchema.index({ location: "2dsphere" });
trainStationSchema.index({ railSystem: 1 });

const TrainStationModel = model<ITdxTrainStation>(
  "TrainStation",
  trainStationSchema,
);
export default TrainStationModel;
