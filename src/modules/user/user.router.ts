import { Router } from "express";
import {
  refresh,
  info,
  lineLinkCode,
  config,
  updateConfig,
  logout,
  getA11yProfile,
  updateA11yProfile,
} from "./user.controller";
import {
  register,
  login,
  googleAuth,
  verifyEmail,
  resendVerification,
  forgotPassword,
  resetPassword,
  changePassword,
} from "./user.auth.controller";
import { validateRequest } from "../../middleware/validate-request.middleware";
import {
  loginLimiter,
  registerLimiter,
  resendLimiter,
  forgotLimiter,
  resetLimiter,
  passwordLimiter,
} from "./user.middleware";
import {
  GoogleAuthBodySchema,
  RegisterBodySchema,
  LoginBodySchema,
  EmailBodySchema,
  VerifyEmailBodySchema,
  ResetPasswordBodySchema,
  ChangePasswordBodySchema,
  ConfigBodySchema,
  UpdateConfigBodySchema,
  UpdateA11yProfileBodySchema,
} from "./user.schema";

export function createUserRouter(): Router {
  const router = Router();

  router.post(
    "/auth/google",
    loginLimiter,
    validateRequest({ body: GoogleAuthBodySchema }),
    googleAuth,
  );
  router.post(
    "/auth/register",
    registerLimiter,
    validateRequest({ body: RegisterBodySchema }),
    register,
  );
  router.post("/auth/login", loginLimiter, validateRequest({ body: LoginBodySchema }), login);
  router.post(
    "/auth/verify-email",
    validateRequest({ body: VerifyEmailBodySchema }),
    verifyEmail,
  );
  router.post(
    "/auth/verify-email/resend",
    resendLimiter,
    validateRequest({ body: EmailBodySchema }),
    resendVerification,
  );
  router.post(
    "/auth/password/forgot",
    forgotLimiter,
    validateRequest({ body: EmailBodySchema }),
    forgotPassword,
  );
  router.post(
    "/auth/password/reset",
    resetLimiter,
    validateRequest({ body: ResetPasswordBodySchema }),
    resetPassword,
  );
  router.post(
    "/auth/password",
    passwordLimiter,
    validateRequest({ body: ChangePasswordBodySchema }),
    changePassword,
  );

  router.post("/refresh", refresh);
  router.get("/info", info);
  router.post("/line-link-code", lineLinkCode);
  router.post("/config", validateRequest({ body: ConfigBodySchema }), config);
  router.post(
    "/config/update",
    validateRequest({ body: UpdateConfigBodySchema }),
    updateConfig,
  );
  router.get("/a11y-profile", getA11yProfile);
  router.put(
    "/a11y-profile",
    validateRequest({ body: UpdateA11yProfileBodySchema }),
    updateA11yProfile,
  );
  router.post("/logout", logout);

  return router;
}
