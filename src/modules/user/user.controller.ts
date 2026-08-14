import type { Request, Response } from "express";
import type { ApiResponse } from "../../types/response";
import { ResponseCode, ResponseMessage } from "../../types/code";
import { sendResponse } from "../../config/lib";
import type { IConfig, IUser } from "../../types";
import { createAccessToken, createRefreshToken, verifyRefreshToken } from "../../config/jwt";
import * as userService from "./user.service";

async function info(req: Request, res: Response<ApiResponse<{ user: IUser | null; config: IConfig | null }>>) {
  try {
    const userId = req.auth?.userId;
    if (!userId) {
      return sendResponse(res, false, "error", ResponseCode.FORBIDDEN, ResponseMessage.FORBIDDEN);
    }

    const { user, config } = await userService.getUserWithConfig(userId);
    if (!user) {
      return sendResponse(res, false, "error", ResponseCode.NOT_FOUND, ResponseMessage.NOT_FOUND);
    }

    return sendResponse(res, true, "success", ResponseCode.OK, ResponseMessage.OK, { user, config });
  } catch (error) {
    console.error(error);
    return sendResponse(
      res,
      false,
      "error",
      ResponseCode.INTERNAL_ERROR,
      ResponseMessage.INTERNAL_ERROR
    );
  }
}

async function lineLinkCode(req: Request, res: Response<ApiResponse<{
  bindCode: string;
  bindCodeExpiresAt: Date;
  bindUrl: string;
}>>) {
  try {
    const userId = req.auth?.userId;
    if (!userId) {
      return sendResponse(
        res,
        false,
        "error",
        ResponseCode.FORBIDDEN,
        ResponseMessage.FORBIDDEN
      );
    }

    const payload = await userService.issueLineLinkCode(userId);
    return sendResponse(
      res,
      true,
      "success",
      ResponseCode.OK,
      ResponseMessage.OK,
      payload
    );
  } catch (error) {
    console.error(error);
    return sendResponse(
      res,
      false,
      "error",
      ResponseCode.INTERNAL_ERROR,
      ResponseMessage.INTERNAL_ERROR
    );
  }
}

async function updateConfig(req: Request, res: Response<ApiResponse<IConfig>>) {
  try {
    const userId = req.auth?.userId;
    if (!userId) {
      return sendResponse(
        res,
        false,
        "error",
        ResponseCode.FORBIDDEN,
        ResponseMessage.FORBIDDEN
      );
    }
    const config = await userService.updateConfig(userId, req.body);

    if (!config) {
      return sendResponse(
        res,
        false,
        "error",
        ResponseCode.INVALID_INPUT,
        ResponseMessage.INVALID_INPUT
      );
    }

    return sendResponse(
      res,
      true,
      "success",
      ResponseCode.OK,
      ResponseMessage.OK,
      config
    );
  } catch (error) {
    console.error(error);
    return sendResponse(
      res,
      false,
      "error",
      ResponseCode.INTERNAL_ERROR,
      ResponseMessage.INTERNAL_ERROR
    );
  }
}

async function config(req: Request, res: Response) {
  try {
    const userId = req.auth?.userId;
    if (!userId) {
      return sendResponse(
        res,
        false,
        "error",
        ResponseCode.FORBIDDEN,
        ResponseMessage.FORBIDDEN
      );
    }
    const userConfig = await userService.getConfig(userId);

    return sendResponse(
      res,
      true,
      "success",
      ResponseCode.OK,
      ResponseMessage.OK,
      userConfig
    );
  } catch (error) {
    console.error(error);
    return sendResponse(
      res,
      false,
      "error",
      ResponseCode.INTERNAL_ERROR,
      ResponseMessage.INTERNAL_ERROR
    );
  }
}

async function refresh(req: Request, res: Response<ApiResponse<{ user: IUser }>>) {
  try {
    const { refreshToken } = req.cookies ?? {};

    const verify = verifyRefreshToken(refreshToken ?? "");
    if (!verify.success || !verify.decoded) {
      res.cookie("refreshToken", "", { maxAge: 0 });
      throw new Error("Invalid refresh token");
    }

    const claimed = verify.decoded.user as IUser | undefined;
    const user = claimed?._id ? await userService.getUserById(String(claimed._id)) : null;
    if (!user || Number(user.tokenVersion ?? 0) !== Number(claimed?.tokenVersion ?? -1)) {
      res.cookie("refreshToken", "", { maxAge: 0 });
      throw new Error("Revoked refresh token");
    }

    return sendResponse(
      res,
      true,
      "success",
      ResponseCode.OK,
      ResponseMessage.OK,
      { user },
      createAccessToken(user),
      createRefreshToken(user)
    );
  } catch (error) {
    console.error("[user] refresh 失敗", error);
    return sendResponse(
      res,
      false,
      "error",
      ResponseCode.UNAUTHORIZED,
      ResponseMessage.UNAUTHORIZED
    );
  }
}

async function logout(_req: Request, res: Response) {
  try {
    res.cookie("refreshToken", "", { maxAge: 0 });
    return sendResponse(res, true, "success", ResponseCode.OK, "Logout successful");
  } catch (error) {
    return sendResponse(res, false, "error", ResponseCode.INTERNAL_ERROR, "Logout failed");
  }
}

async function getA11yProfile(req: Request, res: Response) {
  try {
    const profile = await userService.getA11yProfile(req.auth!.userId);
    return sendResponse(res, true, "success", ResponseCode.OK, ResponseMessage.OK, profile);
  } catch (error) {
    console.error(error);
    return sendResponse(
      res,
      false,
      "error",
      ResponseCode.INTERNAL_ERROR,
      ResponseMessage.INTERNAL_ERROR
    );
  }
}

async function updateA11yProfile(req: Request, res: Response) {
  try {
    const profile = await userService.updateA11yProfile(req.auth!.userId, req.body);
    return sendResponse(res, true, "success", ResponseCode.OK, ResponseMessage.OK, profile);
  } catch (error) {
    console.error(error);
    return sendResponse(
      res,
      false,
      "error",
      ResponseCode.INTERNAL_ERROR,
      ResponseMessage.INTERNAL_ERROR
    );
  }
}

export {
  refresh,
  info,
  lineLinkCode,
  config,
  updateConfig,
  logout,
  getA11yProfile,
  updateA11yProfile,
};
