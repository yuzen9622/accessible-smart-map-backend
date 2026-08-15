import { model, Schema } from "mongoose";
import type { IParkingLot } from "../types";

const parkingLotSchema = new Schema<IParkingLot>({
  carParkId: { type: String, required: true },
  name: { type: String, required: true },
  address: { type: String },
  city: { type: String, required: true },
  district: { type: String },
  carParkType: { type: Number },
  chargeTypes: { type: [Number], default: [] },
  wheelchairAccessible: { type: Boolean },
  disabledSpaces: { type: Number },
  totalCarSpaces: { type: Number },
  position: {
    type: { type: String, enum: ["Point"], required: true, default: "Point" },
    coordinates: { type: [Number], required: true },
  },
  importedAt: { type: Date, default: Date.now },
});
parkingLotSchema.index({ position: "2dsphere" });
parkingLotSchema.index({ carParkId: 1 }, { unique: true });
const ParkingLotModel = model<IParkingLot>("ParkingLot", parkingLotSchema);

export default ParkingLotModel;
