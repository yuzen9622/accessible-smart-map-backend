import { ResponseCode } from "../types/code";
import { Response } from "express";
import type { ApiResponse } from "../types/response";

function stripRedundancies(obj: any): any {
  if (!obj || typeof obj !== "object") {
    return obj;
  }

  if (Array.isArray(obj)) {
    return obj.map(stripRedundancies);
  }

  if (
    obj instanceof Date ||
    obj instanceof RegExp ||
    typeof obj.toHexString === "function"
  ) {
    return obj;
  }

  let cleanObj = obj;
  if (typeof obj.toObject === "function") {
    cleanObj = obj.toObject();
  } else {
    cleanObj = { ...obj };
  }

  if (Object.prototype.hasOwnProperty.call(cleanObj, "__v")) {
    delete cleanObj.__v;
  }

  const hasLocation =
    cleanObj.location &&
    typeof cleanObj.location === "object" &&
    cleanObj.location.type === "Point" &&
    Array.isArray(cleanObj.location.coordinates);

  if (hasLocation) {
    if (Object.prototype.hasOwnProperty.call(cleanObj, "經度")) {
      delete cleanObj["經度"];
    }
    if (Object.prototype.hasOwnProperty.call(cleanObj, "緯度")) {
      delete cleanObj["緯度"];
    }
    if (Object.prototype.hasOwnProperty.call(cleanObj, "latitude")) {
      delete cleanObj["latitude"];
    }
    if (Object.prototype.hasOwnProperty.call(cleanObj, "longitude")) {
      delete cleanObj["longitude"];
    }
  }

  for (const key of Object.keys(cleanObj)) {
    const val = cleanObj[key];
    if (val && typeof val === "object") {
      cleanObj[key] = stripRedundancies(val);
    }
  }

  return cleanObj;
}

export const sendResponse = <T = unknown>(
  res: Response<ApiResponse<T>>,
  ok: boolean,
  status: "success" | "error",
  code: ResponseCode,
  message: string,
  data?: T,
  accessToken?: string,
  refreshToken?: string,
) => {
  if (refreshToken) {
    res.cookie("refreshToken", refreshToken, {
      httpOnly: true,
      secure: process.env.SECURE_COOKIE === "true",
      maxAge: 24 * 60 * 60 * 1000 * 7,
      sameSite: process.env.SECURE_COOKIE === "true" ? "none" : "lax",
    });
  }

  const cleanedData = data !== undefined ? stripRedundancies(data) : undefined;

  res.status(code).json({
    ok,
    status,
    code,
    message,
    data: cleanedData,
    accessToken,
  });
};
