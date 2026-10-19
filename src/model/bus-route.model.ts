import { model, Schema } from "mongoose";
import { ITdxBusRoute } from "../types";

const busRouteStopSchema = new Schema(
  {
    stopUID: { type: String, required: true },
    stopId: { type: String },
    stopName: {
      Zh_tw: { type: String, required: true },
      En: { type: String },
    },
    seq: { type: Number, required: true },
    lat: { type: Number },
    lng: { type: Number },
  },
  { _id: false },
);

const busRouteSchema = new Schema<ITdxBusRoute>({
  subRouteUid: { type: String, required: true },
  routeUid: { type: String, required: true },
  routeId: { type: String },
  city: { type: String, required: true },
  routeName: {
    Zh_tw: { type: String, required: true },
    En: { type: String },
  },
  subRouteName: {
    Zh_tw: { type: String },
    En: { type: String },
  },
  direction: { type: Number, required: true },
  operators: [{ id: String, name: String, _id: false }],
  stops: { type: [busRouteStopSchema], default: [] },
  importedAt: { type: Date, default: Date.now },
});

// One record per sub-route per direction (StopOfRoute granularity).
busRouteSchema.index({ subRouteUid: 1, direction: 1 }, { unique: true });
// Route lookup by city + name.
busRouteSchema.index({ city: 1, "routeName.Zh_tw": 1 });
busRouteSchema.index({ city: 1, "stops.stopUID": 1 });

const BusRouteModel = model<ITdxBusRoute>("BusRoute", busRouteSchema);
export default BusRouteModel;
