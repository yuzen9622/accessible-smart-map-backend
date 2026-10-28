import type { Request, Response } from "express";
import { sendResponse } from "../../config/lib";
import { AVATAR_MSG } from "../../constants/messages";
import { ResponseCode, ResponseMessage } from "../../types/code";
import * as avatarService from "./user.avatar.service";

export async function updateAvatar(req: Request, res: Response) {
  const userId = req.auth?.userId;
  if (!userId) {
    return sendResponse(
      res,
      false,
      "error",
      ResponseCode.FORBIDDEN,
      ResponseMessage.FORBIDDEN,
    );
  }
  if (!req.file) {
    return sendResponse(
      res,
      false,
      "error",
      ResponseCode.INVALID_INPUT,
      AVATAR_MSG.MISSING,
      { reason: "AVATAR_MISSING" },
    );
  }
  try {
    const result = await avatarService.updateAvatar(userId, req.file.buffer);
    if (result.ok) {
      return sendResponse(
        res,
        true,
        "success",
        ResponseCode.OK,
        AVATAR_MSG.UPDATED,
        { avatarUrl: result.avatarUrl },
      );
    }
    if (result.reason === "NOT_FOUND") {
      return sendResponse(
        res,
        false,
        "error",
        ResponseCode.NOT_FOUND,
        ResponseMessage.NOT_FOUND,
      );
    }
    return sendResponse(
      res,
      false,
      "error",
      ResponseCode.INVALID_INPUT,
      AVATAR_MSG.INVALID,
      { reason: result.reason },
    );
  } catch (error) {
    console.error("[avatar] update failed", error);
    return sendResponse(
      res,
      false,
      "error",
      ResponseCode.SERVICE_UNAVAILABLE,
      AVATAR_MSG.UNAVAILABLE,
      { reason: "AVATAR_UNAVAILABLE" },
    );
  }
}

/** Binary success deliberately bypasses the JSON envelope; errors retain it. */
export async function getAvatar(req: Request, res: Response) {
  const { userId, file } = req.validated?.params as {
    userId: string;
    file: string;
  };
  try {
    const bytes = await avatarService.readCurrentAvatar(
      userId,
      file.slice(0, -".jpg".length),
    );
    if (!bytes) {
      return sendResponse(
        res,
        false,
        "error",
        ResponseCode.NOT_FOUND,
        ResponseMessage.NOT_FOUND,
      );
    }
    // Short-lived: a replaced or deleted avatar must stop being served by
    // client and CDN caches soon, even though its URL never changes content.
    res.setHeader("Cache-Control", "public, max-age=3600");
    res.status(ResponseCode.OK).setHeader("Content-Type", "image/jpeg");
    res.setHeader("Content-Length", bytes.length);
    return res.end(bytes);
  } catch (error) {
    console.error("[avatar] read failed", error);
    return sendResponse(
      res,
      false,
      "error",
      ResponseCode.SERVICE_UNAVAILABLE,
      ResponseMessage.SERVICE_UNAVAILABLE,
    );
  }
}
