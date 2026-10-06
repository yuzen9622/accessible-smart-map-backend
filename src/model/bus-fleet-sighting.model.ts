import { model, Schema } from "mongoose";
import { IBusFleetSighting } from "../types";

const busFleetSightingSchema = new Schema<IBusFleetSighting>({
  plateNumb: { type: String, required: true },
  routeUid: { type: String, required: true },
  source: { type: String, required: true },
  seenOn: { type: String, required: true },
  seenAt: { type: Date, required: true },
  expiresAt: { type: Date, required: true },
});

// One record per plate, route and service day, so repeated sightings of the
// same bus never inflate a route's sample.
busFleetSightingSchema.index(
  { routeUid: 1, plateNumb: 1, seenOn: 1 },
  { unique: true },
);
// Each record carries its own expiry, so changing the retention setting never
// conflicts with an existing TTL index.
busFleetSightingSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

const BusFleetSightingModel = model<IBusFleetSighting>(
  "BusFleetSighting",
  busFleetSightingSchema,
);
export default BusFleetSightingModel;
