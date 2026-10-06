import { model, Schema } from "mongoose";
import { IParkArea } from "../types";

const parkAreaSchema = new Schema<IParkArea>({
  parkName: { type: String, required: true, unique: true },
  source: { type: String, enum: ["osm", "entrance_hull"], required: true },
  osmId: { type: String, default: null },
  geometry: {
    type: { type: String, enum: ["Polygon"], required: true },
    coordinates: { type: [[[Number]]], required: true },
  },
  importedAt: { type: Date, default: Date.now },
});

parkAreaSchema.index({ geometry: "2dsphere" });

const ParkAreaModel = model<IParkArea>("ParkArea", parkAreaSchema);

export default ParkAreaModel;
