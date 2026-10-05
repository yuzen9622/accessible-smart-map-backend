import { model, Schema } from "mongoose";
import { ITdxBusVehicle } from "../types";

const busVehicleSchema = new Schema<ITdxBusVehicle>({
  plateNumb: { type: String, required: true, unique: true },
  city: { type: String, required: true },
  operatorId: { type: String },
  vehicleClass: { type: Number },
  vehicleType: { type: Number },
  isLowFloor: { type: Number },
  hasLiftOrRamp: { type: Number },
  isElectric: { type: Number },
  isHybrid: { type: Number },
  hasWifi: { type: Number },
  source: { type: String },
  importedAt: { type: Date, default: Date.now },
});

const BusVehicleModel = model<ITdxBusVehicle>("BusVehicle", busVehicleSchema);
export default BusVehicleModel;
