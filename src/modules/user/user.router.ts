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
  authCacheControl,
  csrfProtection,
  forgotLimiter,
  loginLimiter,
  logoutLimiter,
  passwordLimiter,
  refreshLimiter,
  registerLimiter,
  resendLimiter,
  resetLimiter,
  resolveClientMode,
  validateLogoutTransport,
  validateRefreshTransport,
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

  // Edge middlewares: cache headers and typed transport resolver
  router.use(authCacheControl);
  router.use(resolveClientMode);

  router.post(
    "/auth/google",
    loginLimiter,
    csrfProtection,
    validateRequest({ body: GoogleAuthBodySchema }),
    googleAuth,
  );
  router.post(
    "/auth/register",
    registerLimiter,
    validateRequest({ body: RegisterBodySchema }),
    register,
  );
  router.post(
    "/auth/login",
    loginLimiter,
    csrfProtection,
    validateRequest({ body: LoginBodySchema }),
    login,
  );
  router.post(
    "/auth/verify-email",
    csrfProtection,
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
    csrfProtection,
    validateRequest({ body: ResetPasswordBodySchema }),
    resetPassword,
  );
  router.post(
    "/auth/password",
    passwordLimiter,
    csrfProtection,
    validateRequest({ body: ChangePasswordBodySchema }),
    changePassword,
  );

  router.post(
    "/refresh",
    refreshLimiter,
    validateRefreshTransport,
    csrfProtection,
    refresh,
  );
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
  router.post(
    "/logout",
    logoutLimiter,
    validateLogoutTransport,
    csrfProtection,
    logout,
  );

  return router;
}
