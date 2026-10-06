import { model, Schema } from "mongoose";

/**
 * A route's own stop behind a merged OTP stop: the OTP build merges
 * co-located duplicate bus stops, and this maps (GTFS route_id, merged
 * stop_id) back to the route's original TDX StopUID.
 */
export interface IGtfsStopAlias {
  routeId: string;
  stopId: string;
  originalStopId: string;
  builtAt: Date;
}

const gtfsStopAliasSchema = new Schema<IGtfsStopAlias>({
  routeId: { type: String, required: true },
  stopId: { type: String, required: true },
  originalStopId: { type: String, required: true },
  builtAt: { type: Date, required: true },
});

gtfsStopAliasSchema.index({ routeId: 1, stopId: 1 }, { unique: true });

const GtfsStopAliasModel = model<IGtfsStopAlias>(
  "GtfsStopAlias",
  gtfsStopAliasSchema,
);
export default GtfsStopAliasModel;
