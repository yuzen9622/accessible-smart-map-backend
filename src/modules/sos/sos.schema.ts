import { extendZodWithOpenApi } from "@asteasolutions/zod-to-openapi";
import { z } from "zod";
import { registry } from "../../openapi/registry";

extendZodWithOpenApi(z);

export const CreateSosSchema = z
  .object({
    type: z.enum(["body", "trapped", "share_location"]),
    lat: z.coerce.number().min(-90).max(90),
    lng: z.coerce.number().min(-180).max(180),
    address: z.string().max(200).optional(),
  })
  .strict()
  .openapi("CreateSos");

export const UpdateSosLocationSchema = z
  .object({
    lat: z.coerce.number().min(-90).max(90),
    lng: z.coerce.number().min(-180).max(180),
    address: z.string().max(200).optional(),
  })
  .strict()
  .openapi("UpdateSosLocation");

export const SessionIdParamSchema = z.object({ id: z.string() }).strict();

export const ShareTokenParamSchema = z
  .object({ token: z.string().length(32) })
  .strict();

const ApiResponse = <T extends z.ZodTypeAny>(data: T, refName: string) =>
  z
    .object({
      ok: z.boolean().openapi({ example: true }),
      status: z.enum(["success", "error"]).openapi({ example: "success" }),
      code: z.number().openapi({ example: 200 }),
      message: z.string().openapi({ example: "OK" }),
      data: data.optional(),
      accessToken: z.string().optional(),
    })
    .openapi(refName);

export const SosCreateResponseSchema = ApiResponse(
  z.object({
    sessionId: z.string().openapi({ example: "66b0abc123def4567890abcd" }),
    shareToken: z
      .string()
      .openapi({ example: "9f8e7d6c5b4a39281706f5e4d3c2b1a0" }),
    notifiedCount: z.number().openapi({
      example: 2,
      description: "LINE 已接受通知的收件人數，不代表已送達或已讀",
    }),
    notificationStatus: z
      .enum(["queued", "accepted", "failed", "skipped"])
      .openapi({
        description:
          "queued：待送出或傳送中；accepted：LINE 已接受；failed：嘗試失敗（期限與次數內會重試）；skipped：沒有已綁定聯絡人",
      }),
  }),
  "SosCreateResponse",
);

export const SosLocationUpdatedResponseSchema = ApiResponse(
  z.object({
    sessionId: z.string().openapi({ example: "66b0abc123def4567890abcd" }),
  }),
  "SosLocationUpdatedResponse",
);

export const SosResolveResponseSchema = ApiResponse(
  z.object({
    sessionId: z.string().openapi({ example: "66b0abc123def4567890abcd" }),
    status: z.string().openapi({ example: "resolved" }),
  }),
  "SosResolveResponse",
);

export const SosPublicResponseSchema = ApiResponse(
  z.object({
    type: z
      .enum(["body", "trapped", "share_location"])
      .openapi({ example: "body" }),
    status: z.enum(["active", "resolved"]).openapi({ example: "active" }),
    lat: z
      .number()
      .optional()
      .openapi({ example: 25.033, description: "僅 active 時提供" }),
    lng: z
      .number()
      .optional()
      .openapi({ example: 121.5654, description: "僅 active 時提供" }),
    address: z.string().nullable().optional().openapi({
      example: "台北市信義區市府路1號",
      description: "僅 active 時提供",
    }),
    updatedAt: z.string().optional().openapi({
      example: "2026-07-19T08:30:00.000Z",
      description: "位置更新時間，僅 active 時提供",
    }),
    resolvedAt: z.string().optional().openapi({
      example: "2026-07-19T09:00:00.000Z",
      description: "僅 resolved 時提供",
    }),
    handlingStatus: z
      .enum([
        "pending",
        "notified",
        "acknowledged",
        "claimed",
        "en_route",
        "arrived",
        "resolved",
      ])
      .openapi({
        example: "en_route",
        description: "家人處理進度（不含任何聯絡人姓名）",
      }),
  }),
  "SosPublicResponse",
);

export const SosSnapshotResponseSchema = ApiResponse(
  z.object({
    sessionId: z.string().openapi({ example: "66b0abc123def4567890abcd" }),
    status: z.enum(["active", "resolved"]).openapi({ example: "active" }),
    handlingStatus: z.string().openapi({ example: "acknowledged" }),
    notificationStatus: z.enum([
      "queued",
      "accepted",
      "failed",
      "skipped",
      "unknown",
    ]),
    notifiedCount: z.number(),
    claimedBy: z.string().nullable().openapi({ example: null }),
    claimedByName: z.string().nullable().openapi({ example: "王小明" }),
    claimedAt: z.string().nullable().openapi({ example: null }),
    acknowledgements: z
      .array(
        z.object({
          lineUserId: z.string(),
          name: z.string().nullable(),
          at: z.string(),
        }),
      )
      .openapi({ example: [] }),
    timeline: z
      .array(
        z.object({
          type: z.string(),
          actorType: z.string(),
          actorName: z.string().nullable(),
          note: z.string().nullable(),
          at: z.string(),
        }),
      )
      .openapi({ example: [] }),
    location: z.object({
      lat: z.number().openapi({ example: 25.033 }),
      lng: z.number().openapi({ example: 121.5654 }),
      address: z
        .string()
        .nullable()
        .openapi({ example: "台北市信義區市府路1號" }),
      updatedAt: z.string().openapi({ example: "2026-07-19T08:30:00.000Z" }),
    }),
    viewers: z
      .array(
        z.object({
          firstSeenAt: z.string(),
          lastSeenAt: z.string(),
        }),
      )
      .openapi({
        example: [],
        description:
          "讀取過公開追蹤連結的裝置（以 IP+UA 的雜湊估算，非精確人數；最多記 50 筆）",
      }),
    activeViewerCount: z.number().openapi({
      example: 2,
      description: "快照產生時，最近 viewerActiveWindowSeconds 內讀取過的數量",
    }),
    viewerActiveWindowSeconds: z.number().openapi({ example: 180 }),
    resolvedAt: z.string().nullable().openapi({ example: null }),
    updatedAt: z.string().openapi({ example: "2026-07-19T08:30:00.000Z" }),
  }),
  "SosSnapshotResponse",
);

export const SosShareTokenResponseSchema = ApiResponse(
  z.object({
    sessionId: z.string().openapi({ example: "66b0abc123def4567890abcd" }),
    shareToken: z
      .string()
      .openapi({ example: "0a1b2c3d4e5f60718293a4b5c6d7e8f9" }),
  }),
  "SosShareTokenResponse",
);

export const SosErrorResponseSchema = z
  .object({
    ok: z.boolean().openapi({ example: false }),
    status: z.enum(["success", "error"]).openapi({ example: "error" }),
    code: z.number().openapi({ example: 404 }),
    message: z.string().openapi({ example: "找不到該求救紀錄" }),
    data: z
      .object({
        reason: z
          .enum([
            "NOT_SESSION_OWNER",
            "SESSION_NOT_ACTIVE",
            "SESSION_NOT_FOUND",
            "TRACKING_EXPIRED",
            "ALREADY_CLAIMED",
            "ALREADY_RESOLVED",
            "NOT_AUTHORIZED_CONTACT",
          ])
          .openapi({ example: "SESSION_NOT_FOUND" }),
      })
      .optional(),
  })
  .openapi("SosErrorResponse");

registry.registerPath({
  method: "post",
  path: "/sos/sessions",
  tags: ["SOS"],
  summary: "建立 SOS 求救",
  security: [{ bearerAuth: [] }],
  request: {
    body: { content: { "application/json": { schema: CreateSosSchema } } },
  },
  responses: {
    201: {
      description: "已建立並發出通知",
      content: { "application/json": { schema: SosCreateResponseSchema } },
    },
    200: {
      description: "已有進行中的求救，回傳既有紀錄",
      content: { "application/json": { schema: SosCreateResponseSchema } },
    },
    401: {
      description: "Token 過期",
      content: { "application/json": { schema: SosErrorResponseSchema } },
    },
    403: {
      description: "未帶或無效 Token",
      content: { "application/json": { schema: SosErrorResponseSchema } },
    },
  },
});

registry.registerPath({
  method: "patch",
  path: "/sos/sessions/{id}/location",
  tags: ["SOS"],
  summary: "更新求救中位置",
  security: [{ bearerAuth: [] }],
  request: {
    params: SessionIdParamSchema,
    body: {
      content: { "application/json": { schema: UpdateSosLocationSchema } },
    },
  },
  responses: {
    200: {
      description: "已更新",
      content: {
        "application/json": { schema: SosLocationUpdatedResponseSchema },
      },
    },
    400: {
      description: "求救已結束",
      content: { "application/json": { schema: SosErrorResponseSchema } },
    },
    401: {
      description: "Token 過期",
      content: { "application/json": { schema: SosErrorResponseSchema } },
    },
    403: {
      description: "非本人或無效 Token",
      content: { "application/json": { schema: SosErrorResponseSchema } },
    },
    404: {
      description: "找不到求救紀錄",
      content: { "application/json": { schema: SosErrorResponseSchema } },
    },
  },
});

registry.registerPath({
  method: "patch",
  path: "/sos/sessions/{id}/resolve",
  tags: ["SOS"],
  summary: "解除求救",
  security: [{ bearerAuth: [] }],
  request: { params: SessionIdParamSchema },
  responses: {
    200: {
      description: "已解除",
      content: { "application/json": { schema: SosResolveResponseSchema } },
    },
    400: {
      description: "求救已結束",
      content: { "application/json": { schema: SosErrorResponseSchema } },
    },
    401: {
      description: "Token 過期",
      content: { "application/json": { schema: SosErrorResponseSchema } },
    },
    403: {
      description: "非本人或無效 Token",
      content: { "application/json": { schema: SosErrorResponseSchema } },
    },
    404: {
      description: "找不到求救紀錄",
      content: { "application/json": { schema: SosErrorResponseSchema } },
    },
  },
});

registry.registerPath({
  method: "post",
  path: "/sos/sessions/{id}/share-token",
  tags: ["SOS"],
  summary: "重設分享連結（限本人）",
  description:
    "換發新的 shareToken，舊連結立即失效（包含已寄給 LINE 聯絡人的通知連結），查看紀錄一併清除。",
  security: [{ bearerAuth: [] }],
  request: { params: SessionIdParamSchema },
  responses: {
    200: {
      description: "已換發，回傳新的 shareToken",
      content: { "application/json": { schema: SosShareTokenResponseSchema } },
    },
    400: {
      description: "求救已結束",
      content: { "application/json": { schema: SosErrorResponseSchema } },
    },
    401: {
      description: "Token 過期",
      content: { "application/json": { schema: SosErrorResponseSchema } },
    },
    403: {
      description: "非本人或無效 Token",
      content: { "application/json": { schema: SosErrorResponseSchema } },
    },
    404: {
      description: "找不到求救紀錄",
      content: { "application/json": { schema: SosErrorResponseSchema } },
    },
  },
});

registry.registerPath({
  method: "get",
  path: "/sos/sessions/{id}",
  tags: ["SOS"],
  summary: "查詢求救事件快照（限本人）",
  security: [{ bearerAuth: [] }],
  request: { params: SessionIdParamSchema },
  responses: {
    200: {
      description: "事件快照（含處理狀態、承接人、確認清單與時間軸）",
      content: { "application/json": { schema: SosSnapshotResponseSchema } },
    },
    401: {
      description: "Token 過期",
      content: { "application/json": { schema: SosErrorResponseSchema } },
    },
    403: {
      description: "非本人或無效 Token",
      content: { "application/json": { schema: SosErrorResponseSchema } },
    },
    404: {
      description: "找不到求救紀錄",
      content: { "application/json": { schema: SosErrorResponseSchema } },
    },
  },
});

registry.registerPath({
  method: "get",
  path: "/sos/sessions/{id}/stream",
  tags: ["SOS"],
  summary: "訂閱求救事件即時更新（SSE，限本人）",
  security: [{ bearerAuth: [] }],
  request: { params: SessionIdParamSchema },
  responses: {
    200: {
      description:
        "text/event-stream：每次事件推送 `event: update` 與 JSON 快照",
      content: { "text/event-stream": { schema: z.string() } },
    },
    401: {
      description: "Token 過期",
      content: { "application/json": { schema: SosErrorResponseSchema } },
    },
    403: {
      description: "非本人或無效 Token",
      content: { "application/json": { schema: SosErrorResponseSchema } },
    },
    404: {
      description: "找不到求救紀錄",
      content: { "application/json": { schema: SosErrorResponseSchema } },
    },
  },
});

registry.registerPath({
  method: "get",
  path: "/sos/sessions/{token}/public",
  tags: ["SOS"],
  summary: "公開追蹤頁查詢（無需登入）",
  description:
    "以高熵 shareToken（建立事件時回傳，非 session id）查詢，避免可被猜測/列舉的 ObjectId 暴露即時位置。僅 active 回傳位置；解除後 24 小時內只回狀態，之後 410。每次讀取以 IP+UA 的雜湊估算查看裝置數供求救者檢視。回應不可快取（Cache-Control: no-store）。",
  request: { params: ShareTokenParamSchema },
  responses: {
    200: {
      description: "即時位置",
      content: { "application/json": { schema: SosPublicResponseSchema } },
    },
    404: {
      description: "找不到此追蹤連結",
      content: { "application/json": { schema: SosErrorResponseSchema } },
    },
    410: {
      description: "此追蹤連結已失效",
      content: { "application/json": { schema: SosErrorResponseSchema } },
    },
    429: {
      description: "請求過於頻繁",
      content: { "application/json": { schema: SosErrorResponseSchema } },
    },
  },
});
