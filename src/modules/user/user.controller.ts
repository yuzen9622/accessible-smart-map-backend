import type { Request, Response } from "express";
import type { ApiResponse } from "../../types/response";
import { ResponseCode, ResponseMessage } from "../../types/code";
import { clearAuthCookie, sendResponse } from "../../config/lib";
import { toPublicUser } from "../../config/jwt";
import { ACCOUNT_MSG, AUTH_MSG, PUSH_MSG } from "../../constants/messages";
import type { IConfig, IUser } from "../../types";
import * as userService from "./user.service";
import * as authService from "./user.auth.service";
import * as pushService from "./user.push.service";
import * as accountService from "./user.account.service";

async function info(
  req: Request,
  res: Response<ApiResponse<{ user: IUser | null; config: IConfig | null }>>,
) {
  try {
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

    const { user, config } = await userService.getUserWithConfig(userId);
    if (!user) {
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
      true,
      "success",
      ResponseCode.OK,
      ResponseMessage.OK,
      { user: toPublicUser(user), config },
    );
  } catch (error) {
    console.error(error);
    return sendResponse(
      res,
      false,
      "error",
      ResponseCode.INTERNAL_ERROR,
      ResponseMessage.INTERNAL_ERROR,
    );
  }
}

async function lineLinkCode(
  req: Request,
  res: Response<
    ApiResponse<{
      bindCode: string;
      bindCodeExpiresAt: Date;
      bindUrl: string;
    }>
  >,
) {
  try {
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

    const payload = await userService.issueLineLinkCode(userId);
    return sendResponse(
      res,
      true,
      "success",
      ResponseCode.OK,
      ResponseMessage.OK,
      payload,
    );
  } catch (error) {
    console.error(error);
    return sendResponse(
      res,
      false,
      "error",
      ResponseCode.INTERNAL_ERROR,
      ResponseMessage.INTERNAL_ERROR,
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
        ResponseMessage.FORBIDDEN,
      );
    }
    const config = await userService.updateConfig(userId, req.body);

    if (!config) {
      return sendResponse(
        res,
        false,
        "error",
        ResponseCode.INVALID_INPUT,
        ResponseMessage.INVALID_INPUT,
      );
    }

    return sendResponse(
      res,
      true,
      "success",
      ResponseCode.OK,
      ResponseMessage.OK,
      config,
    );
  } catch (error) {
    console.error(error);
    return sendResponse(
      res,
      false,
      "error",
      ResponseCode.INTERNAL_ERROR,
      ResponseMessage.INTERNAL_ERROR,
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
        ResponseMessage.FORBIDDEN,
      );
    }
    const userConfig = await userService.getConfig(userId);

    return sendResponse(
      res,
      true,
      "success",
      ResponseCode.OK,
      ResponseMessage.OK,
      userConfig,
    );
  } catch (error) {
    console.error(error);
    return sendResponse(
      res,
      false,
      "error",
      ResponseCode.INTERNAL_ERROR,
      ResponseMessage.INTERNAL_ERROR,
    );
  }
}

async function refresh(
  req: Request,
  res: Response<ApiResponse<{ user: IUser }>>,
) {
  try {
    const isMobile = req.clientMode === "mobile";

    // 1. Strict transport segregation
    if (isMobile) {
      if (req.cookies?.refreshToken) {
        return sendResponse(
          res,
          false,
          "error",
          ResponseCode.INVALID_INPUT,
          AUTH_MSG.MIXED_TOKEN_SOURCES,
        );
      }
    } else {
      if (
        req.body &&
        typeof req.body === "object" &&
        "refreshToken" in req.body
      ) {
        return sendResponse(
          res,
          false,
          "error",
          ResponseCode.INVALID_INPUT,
          AUTH_MSG.MIXED_TOKEN_SOURCES,
        );
      }
    }

    // 2. Extract refresh token based on resolved transport
    const rawToken = isMobile
      ? (
          (req.validated?.body ?? req.body) as {
            refreshToken?: string;
          }
        )?.refreshToken
      : req.cookies?.refreshToken;

    if (!rawToken || typeof rawToken !== "string") {
      // Missing or invalid token format -> 401 without clearing cookie (never clear winner's cookie)
      return sendResponse(
        res,
        false,
        "error",
        ResponseCode.UNAUTHORIZED,
        ResponseMessage.UNAUTHORIZED,
      );
    }

    // 3. Delegate rotation and session lifecycle to auth service
    const result = await authService.refreshSession(rawToken);
    if (!result.ok) {
      // 401 on invalid/expired/grace/reuse without clearing cookie
      return sendResponse(
        res,
        false,
        "error",
        ResponseCode.UNAUTHORIZED,
        ResponseMessage.UNAUTHORIZED,
      );
    }

    return sendResponse(
      res,
      true,
      "success",
      ResponseCode.OK,
      ResponseMessage.OK,
      { user: result.user },
      result.accessToken,
      result.refreshToken,
      isMobile ? "mobile" : "web",
    );
  } catch (error) {
    console.error("[user] refresh 失敗", error);
    return sendResponse(
      res,
      false,
      "error",
      ResponseCode.UNAUTHORIZED,
      ResponseMessage.UNAUTHORIZED,
    );
  }
}

async function logout(req: Request, res: Response) {
  try {
    // FROZEN USER DECISION: reject ANY Authorization header on logout with 400 and zero DB writes
    if (req.headers.authorization) {
      return sendResponse(
        res,
        false,
        "error",
        ResponseCode.INVALID_INPUT,
        AUTH_MSG.UNSUPPORTED_AUTH_HEADER,
      );
    }

    const isMobile = req.clientMode === "mobile";

    if (isMobile) {
      if (req.cookies?.refreshToken) {
        return sendResponse(
          res,
          false,
          "error",
          ResponseCode.INVALID_INPUT,
          AUTH_MSG.MIXED_TOKEN_SOURCES,
        );
      }

      const rawToken = (
        (req.validated?.body ?? req.body) as {
          refreshToken?: string;
        }
      )?.refreshToken;

      if (!rawToken || typeof rawToken !== "string") {
        return sendResponse(
          res,
          false,
          "error",
          ResponseCode.INVALID_INPUT,
          ResponseMessage.INVALID_INPUT,
        );
      }

      await authService.logoutSession(rawToken);
      return sendResponse(
        res,
        true,
        "success",
        ResponseCode.OK,
        AUTH_MSG.LOGOUT_SUCCESS,
      );
    }

    // Web mode: reject token in body, clear cookie, revoke if valid cookie present
    if (
      req.body &&
      typeof req.body === "object" &&
      "refreshToken" in req.body
    ) {
      return sendResponse(
        res,
        false,
        "error",
        ResponseCode.INVALID_INPUT,
        AUTH_MSG.MIXED_TOKEN_SOURCES,
      );
    }

    const rawToken = req.cookies?.refreshToken;
    clearAuthCookie(res);

    if (rawToken && typeof rawToken === "string") {
      await authService.logoutSession(rawToken);
    }

    return sendResponse(
      res,
      true,
      "success",
      ResponseCode.OK,
      AUTH_MSG.LOGOUT_SUCCESS,
    );
  } catch (error) {
    console.error("[user] logout 失敗", error);
    return sendResponse(
      res,
      false,
      "error",
      ResponseCode.INTERNAL_ERROR,
      AUTH_MSG.LOGOUT_FAILED,
    );
  }
}

async function getA11yProfile(req: Request, res: Response) {
  try {
    const profile = await userService.getA11yProfile(req.auth!.userId);
    return sendResponse(
      res,
      true,
      "success",
      ResponseCode.OK,
      ResponseMessage.OK,
      profile,
    );
  } catch (error) {
    console.error(error);
    return sendResponse(
      res,
      false,
      "error",
      ResponseCode.INTERNAL_ERROR,
      ResponseMessage.INTERNAL_ERROR,
    );
  }
}

async function updateA11yProfile(req: Request, res: Response) {
  try {
    const profile = await userService.updateA11yProfile(
      req.auth!.userId,
      req.body,
    );
    return sendResponse(
      res,
      true,
      "success",
      ResponseCode.OK,
      ResponseMessage.OK,
      profile,
    );
  } catch (error) {
    console.error(error);
    return sendResponse(
      res,
      false,
      "error",
      ResponseCode.INTERNAL_ERROR,
      ResponseMessage.INTERNAL_ERROR,
    );
  }
}

async function registerPushToken(req: Request, res: Response) {
  try {
    const sessionId = req.auth?.sessionId;
    if (!sessionId) {
      return sendResponse(
        res,
        false,
        "error",
        ResponseCode.FORBIDDEN,
        ResponseMessage.FORBIDDEN,
      );
    }
    const registration = await pushService.registerPushToken({
      userId: req.auth!.userId,
      authSessionId: sessionId,
      ...req.body,
    });
    return sendResponse(
      res,
      true,
      "success",
      ResponseCode.OK,
      PUSH_MSG.REGISTERED,
      registration,
    );
  } catch (error) {
    console.error(error);
    return sendResponse(
      res,
      false,
      "error",
      ResponseCode.INTERNAL_ERROR,
      ResponseMessage.INTERNAL_ERROR,
    );
  }
}

async function unregisterPushToken(req: Request, res: Response) {
  try {
    const removed = await pushService.unregisterPushToken(
      req.auth!.userId,
      req.body.token,
    );
    return sendResponse(
      res,
      true,
      "success",
      ResponseCode.OK,
      PUSH_MSG.UNREGISTERED,
      { removed },
    );
  } catch (error) {
    console.error(error);
    return sendResponse(
      res,
      false,
      "error",
      ResponseCode.INTERNAL_ERROR,
      ResponseMessage.INTERNAL_ERROR,
    );
  }
}

const DELETE_ACCOUNT_FAILURES: Record<
  accountService.DeleteAccountFailure,
  [ResponseCode, string]
> = {
  REAUTH_REQUIRED: [ResponseCode.FORBIDDEN, ACCOUNT_MSG.REAUTH_REQUIRED],
  NOT_FOUND: [ResponseCode.NOT_FOUND, ResponseMessage.NOT_FOUND],
  APPLE_AUTHORIZATION_REQUIRED: [
    ResponseCode.FORBIDDEN,
    ACCOUNT_MSG.APPLE_AUTHORIZATION_REQUIRED,
  ],
  APPLE_AUTHORIZATION_INVALID: [
    ResponseCode.FORBIDDEN,
    ACCOUNT_MSG.APPLE_AUTHORIZATION_INVALID,
  ],
  APPLE_REVOKE_UNAVAILABLE: [
    ResponseCode.SERVICE_UNAVAILABLE,
    ACCOUNT_MSG.APPLE_REVOKE_UNAVAILABLE,
  ],
};

async function deleteAccount(req: Request, res: Response) {
  try {
    const sessionId = req.auth?.sessionId;
    if (!sessionId) {
      return sendResponse(
        res,
        false,
        "error",
        ResponseCode.FORBIDDEN,
        ResponseMessage.FORBIDDEN,
      );
    }

    const { appleAuthorizationCode } = req.validated!.body as {
      appleAuthorizationCode?: string;
    };
    const result = await accountService.deleteAccount({
      userId: req.auth!.userId,
      sessionId,
      appleAuthorizationCode,
    });
    if (!result.ok) {
      const [code, message] = DELETE_ACCOUNT_FAILURES[result.reason];
      return sendResponse(res, false, "error", code, message, {
        reason: result.reason,
      });
    }

    if (req.clientMode !== "mobile") clearAuthCookie(res);
    return sendResponse(
      res,
      true,
      "success",
      ResponseCode.OK,
      ACCOUNT_MSG.DELETED,
    );
  } catch (error) {
    console.error("[user] 刪除帳號失敗", error);
    return sendResponse(
      res,
      false,
      "error",
      ResponseCode.INTERNAL_ERROR,
      ResponseMessage.INTERNAL_ERROR,
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
  registerPushToken,
  unregisterPushToken,
  deleteAccount,
};
