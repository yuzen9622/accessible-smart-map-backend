import { model, Schema } from "mongoose";
import { IOsmA11y } from "../types";

const osmA11ySchema = new Schema<IOsmA11y>({
  osmId: { type: String, required: true, unique: true },
  name: { type: String },
  category: {
    type: String,
    enum: ["wheelchair_accessible", "kerb_cut", "ramp", "elevator", "toilet"],
    required: true,
  },
  wheelchair: { type: String, enum: ["yes", "designated", "limited", "no"] },
  tags: { type: Schema.Types.Mixed },
  location: {
    type: { type: String, enum: ["Point"], required: true, default: "Point" },
    coordinates: { type: [Number], required: true },
  },
  importedAt: { type: Date, default: Date.now },
});

osmA11ySchema.index({ location: "2dsphere" });

const OsmA11y = model<IOsmA11y>("OsmA11y", osmA11ySchema);
export default OsmA11y;
