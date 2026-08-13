import { model, Schema } from "mongoose";
import type { IParkingSpace } from "../types";

const parkingSpaceSchema = new Schema<IParkingSpace>({
	city: { type: String, required: true },
	segmentId: { type: String, required: true },
	spaceType: { type: Number, required: true },
	hasChargingPoint: { type: Boolean, default: false },
	isDisabled: { type: Boolean, default: false },
	externalId: { type: String, required: true },
	location: {
		type: { type: String, enum: ["Point"], required: true, default: "Point" },
		coordinates: { type: [Number], required: true },
	},
	importedAt: { type: Date, default: Date.now },
});
parkingSpaceSchema.index({ location: "2dsphere" });
parkingSpaceSchema.index({ city: 1, externalId: 1 }, { unique: true });
const ParkingSpaceModel = model<IParkingSpace>(
	"ParkingSpace",
	parkingSpaceSchema,
);

export default ParkingSpaceModel;
