import { Schema, model } from "mongoose";
import type { ILineLinkCode } from "../types";

const lineLinkCodeSchema = new Schema<ILineLinkCode>(
  {
    userId: { type: String, required: true, unique: true },
    code: { type: String, required: true, unique: true },
    expiresAt: { type: Date, required: true, index: true },
  },
  { timestamps: true },
);

const LineLinkCode = model<ILineLinkCode>("LineLinkCode", lineLinkCodeSchema);

export default LineLinkCode;
