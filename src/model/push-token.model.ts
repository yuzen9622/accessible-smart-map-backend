import { Schema, model } from "mongoose";
import type { IPushToken } from "../types";

const pushTokenSchema = new Schema<IPushToken>(
  {
    token: { type: String, required: true, unique: true },
    userId: { type: String, ref: "User", required: true, index: true },
    authSessionId: { type: String, ref: "AuthSession", required: true },
    platform: { type: String, enum: ["ios", "android"], required: true },
    locale: { type: String, required: true },
  },
  { timestamps: true },
);

const PushToken = model<IPushToken>("PushToken", pushTokenSchema);

export default PushToken;
