import { Request, Response } from "express";
import { ApiResponse } from "../../types/response";
import { ResponseCode, ResponseMessage } from "../../types/code";
import { AUTH_MSG } from "../../constants/messages";
import { sendResponse } from "../../config/lib";
import { createAccessToken, createRefreshToken, toPublicUser } from "../../config/jwt";
import { IConfig, IUser } from "../../types";
import { AuthError } from "./user.auth.service";
import * as authService from "./user.auth.service";

type SessionPayload = { user: IUser; config: IConfig | null };

function sendSession(
  res: Response<ApiResponse<SessionPayload>>,
  payload: SessionPayload,
  message: string
) {
  // Re-filter here rather than trusting the service: this is the only place a
  // user object reaches the client, so making the guarantee structural keeps a
  // future raw document from carrying passwordHash out with it.
  const user = toPublicUser(payload.user);
  return sendResponse(
    res,
    true,
    "success",
    ResponseCode.OK,
    message,
    { user, config: payload.config },
    createAccessToken(user),
    createRefreshToken(user)
  );
}

function sendAuthError(res: Response<any>, error: unknown) {
  if (error instanceof AuthError) {
    switch (error.reason) {
      case "EMAIL_TAKEN":
        return sendResponse(res, false, "error", ResponseCode.CONFLICT, AUTH_MSG.EMAIL_TAKEN, {
          reason: error.reason,
        });
      case "EMAIL_NOT_VERIFIED":
        return sendResponse(
          res,
          false,
          "error",
          ResponseCode.FORBIDDEN,
          AUTH_MSG.EMAIL_NOT_VERIFIED,
          { reason: error.reason }
        );
      case "INVALID_TOKEN":
        return sendResponse(
          res,
          false,
          "error",
          ResponseCode.UNAUTHORIZED,
          AUTH_MSG.INVALID_TOKEN,
          { reason: error.reason }
        );
      case "PASSWORD_REQUIRED":
        return sendResponse(
          res,
          false,
          "error",
          ResponseCode.INVALID_INPUT,
          AUTH_MSG.PASSWORD_REQUIRED,
          { reason: error.reason }
        );
      case "INVALID_CREDENTIALS":
      default:
        return sendResponse(
          res,
          false,
          "error",
          ResponseCode.UNAUTHORIZED,
          AUTH_MSG.INVALID_CREDENTIALS,
          { reason: "INVALID_CREDENTIALS" }
        );
    }
  }

  console.error(error);
  return sendResponse(
    res,
    false,
    "error",
    ResponseCode.INTERNAL_ERROR,
    ResponseMessage.INTERNAL_ERROR
  );
}

async function register(req: Request, res: Response) {
  try {
    const { name, email, password } = req.validated!.body as {
      name: string;
      email: string;
      password: string;
    };
    const { emailSent } = await authService.registerLocalUser({ name, email, password });
    return sendResponse(
      res,
      true,
      "success",
      ResponseCode.OK,
      emailSent ? AUTH_MSG.REGISTERED : AUTH_MSG.REGISTERED_EMAIL_FAILED,
      { emailSent }
    );
  } catch (error) {
    return sendAuthError(res, error);
  }
}

async function login(req: Request, res: Response<ApiResponse<SessionPayload>>) {
  try {
    const { email, password } = req.validated!.body as { email: string; password: string };
    const session = await authService.loginLocalUser({ email, password });
    return sendSession(res, session, ResponseMessage.OK);
  } catch (error) {
    return sendAuthError(res, error);
  }
}

async function googleAuth(req: Request, res: Response<ApiResponse<SessionPayload>>) {
  try {
    const { idToken } = req.validated!.body as { idToken: string };
    const session = await authService.authenticateWithGoogle(idToken);
    return sendSession(res, session, ResponseMessage.OK);
  } catch (error) {
    return sendAuthError(res, error);
  }
}

async function verifyEmail(req: Request, res: Response<ApiResponse<SessionPayload>>) {
  try {
    const { token } = req.validated!.body as { token: string };
    const session = await authService.verifyEmail(token);
    return sendSession(res, session, AUTH_MSG.EMAIL_VERIFIED);
  } catch (error) {
    return sendAuthError(res, error);
  }
}

async function resendVerification(req: Request, res: Response) {
  try {
    const { email } = req.validated!.body as { email: string };
    await authService.resendVerificationEmail(email);
    return sendResponse(res, true, "success", ResponseCode.OK, AUTH_MSG.VERIFICATION_SENT);
  } catch (error) {
    return sendAuthError(res, error);
  }
}

async function forgotPassword(req: Request, res: Response) {
  try {
    const { email } = req.validated!.body as { email: string };
    await authService.requestPasswordReset(email);
    return sendResponse(res, true, "success", ResponseCode.OK, AUTH_MSG.RESET_SENT);
  } catch (error) {
    if (error instanceof AuthError) return sendAuthError(res, error);
    console.error("[auth] 密碼重設信寄送失敗", error);
    return sendResponse(
      res,
      false,
      "error",
      ResponseCode.SERVICE_UNAVAILABLE,
      AUTH_MSG.RESET_EMAIL_FAILED
    );
  }
}

async function resetPassword(req: Request, res: Response<ApiResponse<SessionPayload>>) {
  try {
    const { token, password } = req.validated!.body as { token: string; password: string };
    const session = await authService.resetPassword({ token, password });
    return sendSession(res, session, AUTH_MSG.PASSWORD_RESET);
  } catch (error) {
    return sendAuthError(res, error);
  }
}

async function changePassword(req: Request, res: Response<ApiResponse<{ user: IUser }>>) {
  try {
    const userId = req.auth?.userId;
    if (!userId) {
      return sendResponse(res, false, "error", ResponseCode.FORBIDDEN, ResponseMessage.FORBIDDEN);
    }

    const { currentPassword, newPassword } = req.validated!.body as {
      currentPassword?: string;
      newPassword: string;
    };
    const result = await authService.changePassword({ userId, currentPassword, newPassword });
    const user = toPublicUser(result.user);

    return sendResponse(
      res,
      true,
      "success",
      ResponseCode.OK,
      AUTH_MSG.PASSWORD_CHANGED,
      { user },
      createAccessToken(user),
      createRefreshToken(user)
    );
  } catch (error) {
    return sendAuthError(res, error);
  }
}

export {
  register,
  login,
  googleAuth,
  verifyEmail,
  resendVerification,
  forgotPassword,
  resetPassword,
  changePassword,
};
