import { extendZodWithOpenApi } from "@asteasolutions/zod-to-openapi";
import { z } from "zod";
import { registry } from "../../openapi/registry";

extendZodWithOpenApi(z);

registry.registerComponent("securitySchemes", "bearerAuth", {
  type: "http",
  scheme: "bearer",
  bearerFormat: "JWT",
});

const PasswordSchema = z
  .string()
  .min(8, "密碼至少 8 個字元")
  .refine((value) => Buffer.byteLength(value, "utf8") <= 72, {
    message: "密碼不可超過 72 個位元組",
  })
  .refine((value) => /[A-Za-z]/.test(value) && /[0-9]/.test(value), {
    message: "密碼需同時包含英文字母與數字",
  })
  .openapi({
    description:
      "至少 8 字元、最多 72 位元組（bcrypt 上限），需含英文字母與數字",
    example: "taipei2026",
  });

export const GoogleAuthBodySchema = z
  .object({
    idToken: z.string().min(1).openapi({
      description: "Google Sign-In 發給前端的 ID token，由後端驗證",
    }),
  })
  .strict();

export const RegisterBodySchema = z
  .object({
    name: z.string().min(1).max(60).openapi({ example: "Jane Doe" }),
    email: z.string().email().openapi({ example: "jane@example.com" }),
    password: PasswordSchema,
  })
  .strict();

export const LoginBodySchema = z
  .object({
    email: z.string().email().openapi({ example: "jane@example.com" }),
    password: z.string().min(1),
  })
  .strict();

export const EmailBodySchema = z
  .object({
    email: z.string().email().openapi({ example: "jane@example.com" }),
  })
  .strict();

export const VerifyEmailBodySchema = z
  .object({
    token: z
      .string()
      .min(1)
      .openapi({ description: "驗證信連結中的一次性權杖" }),
  })
  .strict();

export const ResetPasswordBodySchema = z
  .object({
    token: z
      .string()
      .min(1)
      .openapi({ description: "重設信連結中的一次性權杖" }),
    password: PasswordSchema,
  })
  .strict();

export const ChangePasswordBodySchema = z
  .object({
    currentPassword: z
      .string()
      .min(1)
      .optional()
      .openapi({ description: "帳號尚無密碼（純 Google 登入）時可省略" }),
    newPassword: PasswordSchema,
  })
  .strict();

export const ConfigBodySchema = z.object({}).strict();

export const UpdateConfigBodySchema = z
  .object({
    language: z.string().optional().openapi({ example: "zh-TW" }),
    darkMode: z.enum(["light", "dark", "system"]).optional(),
    themeColor: z.string().optional().openapi({ example: "#3B82F6" }),
    fontSize: z.string().optional().openapi({ example: "md" }),
    notifications: z.boolean().optional(),
    memoryEnabled: z.boolean().optional(),
  })
  .strict();

const UserSchema = z
  .object({
    _id: z.string().openapi({ example: "665f1a2b3c4d5e6f7a8b9c0d" }),
    name: z.string().openapi({ example: "Jane Doe" }),
    avatar: z
      .string()
      .url()
      .optional()
      .openapi({ example: "https://example.com/avatar.png" }),
    email: z.string().email().openapi({ example: "jane@example.com" }),
    client_id: z.string().nullable().optional().openapi({
      description: "Google sub；純帳密註冊的帳號為 null",
      example: "10293847",
    }),
    authProviders: z
      .array(z.enum(["google", "local"]))
      .openapi({ description: "此帳號可用的登入方式", example: ["local"] }),
    emailVerified: z.boolean().openapi({ example: true }),
    tokenVersion: z
      .number()
      .openapi({ description: "改密碼時遞增，用於撤銷舊權杖", example: 0 }),
    lineUserId: z
      .string()
      .nullable()
      .optional()
      .openapi({ example: "U1234567890abcdef" }),
    createdAt: z.string().openapi({ example: "2026-01-15T08:30:00.000Z" }),
    updatedAt: z.string().openapi({ example: "2026-06-03T11:45:00.000Z" }),
  })
  .openapi("User");

const ConfigSchema = z
  .object({
    language: z.string().openapi({ example: "zh-TW" }),
    darkMode: z
      .enum(["light", "dark", "system"])
      .openapi({ example: "system" }),
    themeColor: z.string().openapi({ example: "#3B82F6" }),
    fontSize: z.string().openapi({ example: "md" }),
    notifications: z.boolean().openapi({ example: true }),
    memoryEnabled: z.boolean().openapi({ example: false }),
    user_id: z.string().openapi({ example: "665f1a2b3c4d5e6f7a8b9c0d" }),
  })
  .openapi("Config");

const apiResponse = <T extends z.ZodTypeAny>(data?: T) =>
  z.object({
    ok: z.boolean().openapi({ example: true }),
    status: z.enum(["success", "error"]).openapi({ example: "success" }),
    code: z.number().openapi({ example: 200 }),
    message: z.string().openapi({ example: "OK" }),
    ...(data ? { data: data.optional() } : {}),
    accessToken: z
      .string()
      .optional()
      .openapi({ description: "短期有效的 JWT 存取權杖" }),
  });

export const LoginResponseSchema = apiResponse(
  z.object({
    user: UserSchema,
    config: ConfigSchema,
  }),
).openapi("LoginResponse");

export const RegisterResponseSchema = apiResponse(
  z.object({
    emailSent: z.boolean().openapi({ description: "驗證信是否確實寄出" }),
  }),
).openapi("RegisterResponse");

export const ChangePasswordResponseSchema = apiResponse(
  z.object({ user: UserSchema }),
).openapi("ChangePasswordResponse");

export const MessageResponseSchema = apiResponse().openapi("MessageResponse");

export const RefreshResponseSchema = apiResponse(
  z.object({
    user: UserSchema,
  }),
).openapi("RefreshResponse");

export const UserInfoResponseSchema = apiResponse(
  z.object({
    user: UserSchema.nullable(),
    config: ConfigSchema.nullable(),
  }),
).openapi("UserInfoResponse");

export const ConfigResponseSchema = apiResponse(
  ConfigSchema.nullable(),
).openapi("ConfigResponse");

export const UpdateConfigResponseSchema = apiResponse(ConfigSchema).openapi(
  "UpdateConfigResponse",
);

const MOBILITY_AIDS = [
  "manual_wheelchair",
  "power_wheelchair",
  "walker",
  "none",
] as const;

const A11yProfileSchema = z
  .object({
    mobilityAid: z.enum(MOBILITY_AIDS).nullable().openapi({
      example: "manual_wheelchair",
      description: "行動輔具類型；null 表示尚未設定",
    }),
    canUseStairs: z
      .boolean()
      .nullable()
      .openapi({ example: false, description: "能否自行上下階梯" }),
    maxSlopePercent: z
      .number()
      .min(0)
      .max(100)
      .nullable()
      .openapi({ example: 5, description: "可接受的最大坡度百分比" }),
    needsAccessibleToilet: z.boolean().nullable().openapi({ example: true }),
    needsElevator: z.boolean().nullable().openapi({ example: true }),
    needsHandrail: z.boolean().nullable().openapi({ example: false }),
    visualAssistance: z.boolean().nullable().openapi({
      example: false,
      description: "是否需要視障相關輔助（導盲磚、語音號誌等）",
    }),
    preferredFontScale: z
      .number()
      .min(0.5)
      .max(3)
      .nullable()
      .openapi({ example: 1.25, description: "前端字體縮放倍率偏好" }),
  })
  .strict()
  .openapi("A11yProfile");

export const UpdateA11yProfileBodySchema = A11yProfileSchema.partial().openapi(
  "UpdateA11yProfileBody",
);

export const A11yProfileResponseSchema = apiResponse(A11yProfileSchema).openapi(
  "A11yProfileResponse",
);

export const LineLinkCodeResponseSchema = apiResponse(
  z.object({
    bindCode: z.string().openapi({ example: "A1B2C3" }),
    bindCodeExpiresAt: z
      .string()
      .openapi({ example: "2026-07-09T08:30:00.000Z" }),
    bindUrl: z.string().openapi({ example: "https://line.me/R/ti/p/@xxxxxxx" }),
  }),
).openapi("LineLinkCodeResponse");

export const LogoutResponseSchema = apiResponse().openapi("LogoutResponse");

export const ErrorResponseSchema = apiResponse().openapi("ErrorResponse");

const errorResponse = (description: string) => ({
  description,
  content: { "application/json": { schema: ErrorResponseSchema } },
});

registry.registerPath({
  method: "post",
  path: "/user/auth/google",
  tags: ["User"],
  summary: "Google 登入",
  description:
    "後端以 GOOGLE_CLIENT_ID 驗證前端傳來的 Google ID token，身分僅取自驗證後的 payload。" +
    "同 email 的既有帳號會自動連結；若該帳號原為未驗證的帳密帳號，其密碼會被移除並撤銷既有權杖。",
  request: {
    body: {
      content: { "application/json": { schema: GoogleAuthBodySchema } },
      required: true,
    },
  },
  responses: {
    200: {
      description: "存取權杖於 body，refresh 權杖於 cookie",
      content: { "application/json": { schema: LoginResponseSchema } },
    },
    400: errorResponse("缺少 idToken"),
    401: errorResponse("ID token 無效"),
    500: errorResponse("伺服器錯誤或未設定 GOOGLE_CLIENT_ID"),
  },
});

registry.registerPath({
  method: "post",
  path: "/user/auth/register",
  tags: ["User"],
  summary: "帳密註冊",
  description:
    "建立帳密帳號並寄出驗證信。**不會回傳權杖**：必須先完成信箱驗證才能登入。",
  request: {
    body: {
      content: { "application/json": { schema: RegisterBodySchema } },
      required: true,
    },
  },
  responses: {
    200: {
      description: "註冊成功，驗證信已寄出（emailSent 表示是否確實寄出）",
      content: { "application/json": { schema: RegisterResponseSchema } },
    },
    400: errorResponse("欄位格式錯誤或密碼不符規則"),
    409: errorResponse("此電子郵件已被註冊"),
    429: errorResponse("註冊請求過於頻繁"),
    500: errorResponse("伺服器錯誤"),
  },
});

registry.registerPath({
  method: "post",
  path: "/user/auth/login",
  tags: ["User"],
  summary: "帳密登入",
  description:
    "以電子郵件與密碼登入。帳號不存在與密碼錯誤回傳完全相同的 401，以避免洩漏哪些信箱已註冊。",
  request: {
    body: {
      content: { "application/json": { schema: LoginBodySchema } },
      required: true,
    },
  },
  responses: {
    200: {
      description: "存取權杖於 body，refresh 權杖於 cookie",
      content: { "application/json": { schema: LoginResponseSchema } },
    },
    400: errorResponse("欄位格式錯誤"),
    401: errorResponse(
      "電子郵件或密碼錯誤（data.reason = INVALID_CREDENTIALS）",
    ),
    403: errorResponse("信箱尚未驗證（data.reason = EMAIL_NOT_VERIFIED）"),
    429: errorResponse("登入請求過於頻繁"),
  },
});

registry.registerPath({
  method: "post",
  path: "/user/auth/verify-email",
  tags: ["User"],
  summary: "驗證電子郵件",
  description: "以驗證信中的一次性權杖完成驗證，並直接回傳登入權杖。",
  request: {
    body: {
      content: { "application/json": { schema: VerifyEmailBodySchema } },
      required: true,
    },
  },
  responses: {
    200: {
      description: "驗證成功並登入",
      content: { "application/json": { schema: LoginResponseSchema } },
    },
    401: errorResponse("連結無效或已過期"),
  },
});

registry.registerPath({
  method: "post",
  path: "/user/auth/verify-email/resend",
  tags: ["User"],
  summary: "重寄驗證信",
  description: "無論該信箱是否存在或已驗證，一律回傳 200，以避免信箱列舉。",
  request: {
    body: {
      content: { "application/json": { schema: EmailBodySchema } },
      required: true,
    },
  },
  responses: {
    200: {
      description: "已受理",
      content: { "application/json": { schema: MessageResponseSchema } },
    },
    429: errorResponse("請求過於頻繁"),
  },
});

registry.registerPath({
  method: "post",
  path: "/user/auth/password/forgot",
  tags: ["User"],
  summary: "申請密碼重設",
  description:
    "所有格式正確的信箱都先寫入同一個 durable queue，成功受理回傳相同的 202，以避免信箱列舉。" +
    "Queue 無法寫入時，無論帳號是否存在都回 503。背景 worker 對本地密碼帳號寄重設連結；" +
    "Google-only 帳號只寄 Google 登入與帳戶救援說明，不簽發本站重設權杖。",
  request: {
    body: {
      content: { "application/json": { schema: EmailBodySchema } },
      required: true,
    },
  },
  responses: {
    202: {
      description: "已寫入帳號協助 queue",
      content: { "application/json": { schema: MessageResponseSchema } },
    },
    429: errorResponse("請求過於頻繁"),
    503: errorResponse("帳號協助 queue 暫時無法受理"),
  },
});

registry.registerPath({
  method: "post",
  path: "/user/auth/password/reset",
  tags: ["User"],
  summary: "重設密碼",
  description:
    "以本地密碼帳號重設信中的一次性權杖設定新密碼。Google-only 帳號不能透過此流程新增本站密碼。" +
    "成功後信箱一併標記為已驗證，並撤銷所有既有權杖。",
  request: {
    body: {
      content: { "application/json": { schema: ResetPasswordBodySchema } },
      required: true,
    },
  },
  responses: {
    200: {
      description: "密碼已重設並登入",
      content: { "application/json": { schema: LoginResponseSchema } },
    },
    400: errorResponse("新密碼不符規則"),
    401: errorResponse("連結無效或已過期"),
    429: errorResponse("密碼重設嘗試過於頻繁"),
  },
});

registry.registerPath({
  method: "post",
  path: "/user/auth/password",
  tags: ["User"],
  summary: "變更密碼",
  description:
    "變更已登入帳號的密碼並撤銷其他既有權杖（回應會附上新的權杖）。" +
    "帳號尚無密碼（純 Google 登入）時可省略 currentPassword，即為新增密碼登入方式。",
  security: [{ bearerAuth: [] }],
  request: {
    body: {
      content: { "application/json": { schema: ChangePasswordBodySchema } },
      required: true,
    },
  },
  responses: {
    200: {
      description: "密碼已更新，並回傳新權杖",
      content: { "application/json": { schema: ChangePasswordResponseSchema } },
    },
    400: errorResponse("新密碼不符規則或缺少 currentPassword"),
    401: errorResponse("目前密碼錯誤"),
    403: errorResponse("未授權"),
    429: errorResponse("請求過於頻繁"),
  },
});

registry.registerPath({
  method: "post",
  path: "/user/refresh",
  tags: ["User"],
  summary: "Cookie 換發權杖",
  description:
    "讀取 refreshToken cookie，簽發新的存取與 refresh 權杖，免請求內容。",
  responses: {
    200: {
      description: "新的存取與 refresh 權杖",
      content: { "application/json": { schema: RefreshResponseSchema } },
    },
    401: {
      description: "refresh cookie 無效或不存在",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
  },
});

registry.registerPath({
  method: "get",
  path: "/user/info",
  tags: ["User"],
  summary: "目前使用者資料",
  description: "回傳已驗證使用者的個資與偏好設定，需有效 Bearer 權杖。",
  security: [{ bearerAuth: [] }],
  responses: {
    200: {
      description: "使用者與設定物件",
      content: { "application/json": { schema: UserInfoResponseSchema } },
    },
    401: {
      description: "未授權",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
    403: {
      description: "禁止存取",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
    500: {
      description: "伺服器錯誤",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
  },
});

registry.registerPath({
  method: "post",
  path: "/user/line-link-code",
  tags: ["User"],
  summary: "取得 LINE 帳號綁定碼",
  description:
    "由已登入使用者產生一次性 LINE 綁定碼，供使用者在 LINE Bot 中傳送綁定。",
  security: [{ bearerAuth: [] }],
  responses: {
    200: {
      description: "綁定碼與官方加好友連結",
      content: { "application/json": { schema: LineLinkCodeResponseSchema } },
    },
    403: {
      description: "未授權",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
    500: {
      description: "伺服器錯誤",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
  },
});

registry.registerPath({
  method: "post",
  path: "/user/config",
  tags: ["User"],
  summary: "取得使用者設定",
  description: "依 user_id 取得偏好設定，需有效 Bearer 權杖。",
  security: [{ bearerAuth: [] }],
  request: {
    body: {
      content: { "application/json": { schema: ConfigBodySchema } },
      required: true,
    },
  },
  responses: {
    200: {
      description: "使用者設定物件",
      content: { "application/json": { schema: ConfigResponseSchema } },
    },
    400: {
      description: "缺少 user_id",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
    500: {
      description: "伺服器錯誤",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
  },
});

registry.registerPath({
  method: "post",
  path: "/user/config/update",
  tags: ["User"],
  summary: "更新使用者偏好",
  description: "部分更新使用者設定，除 user_id 外皆選填，只改傳入欄位。",
  security: [{ bearerAuth: [] }],
  request: {
    body: {
      content: { "application/json": { schema: UpdateConfigBodySchema } },
      required: true,
    },
  },
  responses: {
    200: {
      description: "更新後的設定",
      content: { "application/json": { schema: UpdateConfigResponseSchema } },
    },
    400: {
      description: "缺少 user_id 或查無設定",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
    500: {
      description: "伺服器錯誤",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
  },
});

registry.registerPath({
  method: "get",
  path: "/user/a11y-profile",
  tags: ["User"],
  summary: "取得使用者無障礙偏好",
  description:
    "首次呼叫時若尚無設定，會自動建立一筆欄位皆為 null 的空白設定；不會因此要求使用者重新填寫一次。",
  security: [{ bearerAuth: [] }],
  responses: {
    200: {
      description: "無障礙偏好（未設定的欄位為 null）",
      content: { "application/json": { schema: A11yProfileResponseSchema } },
    },
    401: { description: "未提供或已過期的 token" },
    403: { description: "token 無效" },
    500: { description: "伺服器錯誤" },
  },
});

registry.registerPath({
  method: "put",
  path: "/user/a11y-profile",
  tags: ["User"],
  summary: "更新使用者無障礙偏好",
  description: "部分更新，只改傳入的欄位；未包含在 body 裡的欄位保持不變。",
  security: [{ bearerAuth: [] }],
  request: {
    body: {
      content: { "application/json": { schema: UpdateA11yProfileBodySchema } },
      required: true,
    },
  },
  responses: {
    200: {
      description: "更新後的完整偏好",
      content: { "application/json": { schema: A11yProfileResponseSchema } },
    },
    400: { description: "參數不合法" },
    401: { description: "未提供或已過期的 token" },
    403: { description: "token 無效" },
    500: { description: "伺服器錯誤" },
  },
});

registry.registerPath({
  method: "post",
  path: "/user/logout",
  tags: ["User"],
  summary: "使用者登出",
  description: "清除 refreshToken cookie，用戶端須自行捨棄存取權杖。",
  responses: {
    200: {
      description: "登出成功",
      content: { "application/json": { schema: LogoutResponseSchema } },
    },
    500: {
      description: "伺服器錯誤",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
  },
});
