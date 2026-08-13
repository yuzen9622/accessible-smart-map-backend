import { model, Schema } from "mongoose";
import type { IDisabledParking } from "../types";

const disabledParkingSchema = new Schema<IDisabledParking>({
	city: { type: String, required: true },
	district: { type: String, required: true },
	areacode: { type: String },
	quantity: { type: Number, required: true, default: 1 },
	placeName: { type: String, required: true },
	chargeType: { type: String },
	spaceLabel: { type: String },
	isMarked: { type: Boolean, default: true },
	source: { type: String },
	externalId: { type: String },
	latitude: { type: Number, required: true },
	longitude: { type: Number, required: true },
	location: {
		type: { type: String, enum: ["Point"], required: true, default: "Point" },
		coordinates: { type: [Number], required: true },
	},
	importedAt: { type: Date, default: Date.now },
});
disabledParkingSchema.index({ location: "2dsphere" });
disabledParkingSchema.index({ source: 1, externalId: 1 });
const DisabledParkingModel = model<IDisabledParking>(
	"DisabledParking",
	disabledParkingSchema,
);

export default DisabledParkingModel;
