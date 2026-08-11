import { Schema, model } from "mongoose";
import { IConfig } from "../types";

const ConfigSchema = new Schema<IConfig>({
  language: { type: String, default: "zh-TW" },
  darkMode: { type: String, default: "system" },
  themeColor: { type: String, default: "default" },
  fontSize: { type: String, default: "medium" },
  notifications: { type: Boolean, default: true },
  accessibility: {
    mobilityAid: {
      type: String,
      enum: ["manual_wheelchair", "power_wheelchair", "walker", "none"],
      default: null,
    },
    canUseStairs: { type: Boolean, default: null },
    maxSlopePercent: { type: Number, default: null },
    needsAccessibleToilet: { type: Boolean, default: null },
    needsElevator: { type: Boolean, default: null },
    needsHandrail: { type: Boolean, default: null },
    visualAssistance: { type: Boolean, default: null },
    preferredFontScale: { type: Number, default: null },
  },
  user_id: { type: Schema.Types.ObjectId, ref: "User", required: true },
});

const Config = model<IConfig>("Config", ConfigSchema);
export default Config;
