import { model, Schema } from "mongoose";
import { IVisualA11y } from "../types";

const visualA11ySchema = new Schema<IVisualA11y>({
  source: {
    type: String,
    enum: ["osm", "taipei_tce"],
    required: true,
    default: "osm",
  },
  sourceId: { type: String, required: true },
  osmNodeId: { type: Number },
  type: {
    type: String,
    enum: ["audio_signal", "tactile_paving"],
    required: true,
  },
  location: {
    type: { type: String, enum: ["Point"], required: true, default: "Point" },
    coordinates: { type: [Number], required: true },
  },
  properties: {
    buttonOperated: { type: Boolean, default: null },
    vibration: { type: Boolean, default: null },
    roadName: { type: String, default: null },
    subType: { type: String, default: null },
    name: { type: String, default: null },
    nameEn: { type: String, default: null },
    wheelchair: { type: String, default: null },
  },
  updatedAt: { type: Date, default: Date.now },
});

visualA11ySchema.index({ location: "2dsphere" });
visualA11ySchema.index({ source: 1, sourceId: 1, type: 1 }, { unique: true });

const VisualA11yModel = model<IVisualA11y>("VisualA11y", visualA11ySchema);

export default VisualA11yModel;
