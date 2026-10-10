import { extendZodWithOpenApi } from "@asteasolutions/zod-to-openapi";
import { z } from "zod";
import { registry } from "../../openapi/registry";
import { HAZARD_AI_ALERT_CODES } from "../../config/hazard-ai";

extendZodWithOpenApi(z);

const HAZARD_TYPES = ["obstacle", "construction", "data_error"] as const;
const SEVERITIES = ["blocking", "difficult", "minor"] as const;
const STATUSES = ["pending", "verified", "rejected", "expired"] as const;
const MAX_EXPECTED_UNTIL_DAYS = 180;

export const CreateHazardReportSchema = z
  .object({
    canBlockAuthor: z.boolean().optional().openapi({
      description:
        "是否存在可封鎖作者的提示；公開回應不暴露作者 ID，實際封鎖仍由後端驗證。",
    }),
    moderationHiddenAt: z.string().optional().openapi({
      description: "平台下架時間；僅本人歷史或管理者授權內容會出現。",
    }),
    hazardType: z.enum(HAZARD_TYPES).openapi({ example: "obstacle" }),
    severity: z.enum(SEVERITIES).openapi({
      example: "difficult",
      description:
        "blocking=完全無法通行, difficult=可通行但困難, minor=輕微影響",
    }),
    latitude: z.coerce.number().min(-90).max(90).openapi({ example: 25.033 }),
    longitude: z.coerce
      .number()
      .min(-180)
      .max(180)
      .openapi({ example: 121.5654 }),
    description: z
      .string()
      .max(500)
      .optional()
      .openapi({ example: "人行道上有施工鐵板未固定" }),
    expectedUntil: z
      .string()
      .datetime()
      .optional()
      .refine(
        (value) => {
          if (!value) return true;
          const date = new Date(value);
          const now = Date.now();
          return (
            date.getTime() > now &&
            date.getTime() <= now + MAX_EXPECTED_UNTIL_DAYS * 86_400_000
          );
        },
        {
          message: `expectedUntil 必須在未來且不超過 ${MAX_EXPECTED_UNTIL_DAYS} 天`,
        },
      )
      .openapi({
        example: "2026-09-30T00:00:00.000Z",
        description:
          "預計此障礙持續到何時；未提供時依 hazardType 使用預設有效期",
      }),
  })
  .strict();

export const NearbyReportsQuerySchema = z
  .object({
    lat: z.coerce.number().min(-90).max(90).openapi({ example: 25.033 }),
    lng: z.coerce.number().min(-180).max(180).openapi({ example: 121.5654 }),
    radius: z.coerce
      .number()
      .min(1)
      .max(5000)
      .optional()
      .openapi({ example: 500 }),
    hazardType: z.enum(HAZARD_TYPES).optional(),
    status: z.string().optional().openapi({ example: "pending,verified" }),
    limit: z.coerce.number().min(1).max(50).optional().openapi({ example: 20 }),
  })
  .strict();

export const MyReportsQuerySchema = z
  .object({
    status: z
      .string()
      .optional()
      .openapi({ example: "pending,verified,expired" }),
    hazardType: z.enum(HAZARD_TYPES).optional(),
    limit: z.coerce.number().min(1).max(50).optional().openapi({ example: 20 }),
    cursor: z
      .string()
      .optional()
      .openapi({ example: "6670abc123def4567890abcd" }),
  })
  .strict();

export const ReportIdParamSchema = z
  .object({
    id: z.string().min(1).openapi({ example: "6670abc123def4567890abcd" }),
  })
  .strict();

export const PhotoReportIdParamSchema = z
  .object({
    id: z.string().regex(/^[0-9a-fA-F]{24}$/),
  })
  .strict();

export const ConfirmSchema = z
  .object({
    action: z.enum(["confirm", "deny"]).openapi({ example: "confirm" }),
  })
  .strict();

export const ReviewQueueQuerySchema = z
  .object({
    limit: z.coerce.number().min(1).max(50).optional().openapi({ example: 20 }),
    cursor: z
      .string()
      .optional()
      .openapi({ example: "6670abc123def4567890abcd" }),
  })
  .strict();

export const ReviewDecisionSchema = z
  .object({
    decision: z.enum(["verified", "rejected"]).openapi({ example: "verified" }),
    note: z
      .string()
      .max(500)
      .optional()
      .openapi({ example: "現場已確認施工鐵板仍在" }),
  })
  .strict();

export const AiMetricsQuerySchema = z.object({}).strict();

const GeoPointSchema = z
  .object({
    type: z.literal("Point").openapi({ example: "Point" }),
    coordinates: z
      .tuple([z.number(), z.number()])
      .openapi({ example: [121.5654, 25.033] }),
  })
  .openapi("HazardGeoPoint");

const AI_STATES = [
  "queued",
  "processing",
  "completed",
  "failed",
  "cancelled",
] as const;
const AI_DECISIONS = ["supported", "needs_evidence", "unsupported"] as const;
const REQUIRED_EVIDENCE = [
  "wider_view",
  "clearer_image",
  "matching_hazard",
  "map_reference",
] as const;
const VISIBLE_HAZARDS = [
  "vehicle",
  "construction",
  "steps",
  "debris",
  "blocked_path",
  "other_obstacle",
] as const;

const AiReviewSchema = z
  .object({
    version: z.literal(2),
    state: z.enum(AI_STATES).openapi({ example: "queued" }),
    decision: z.enum(AI_DECISIONS).optional().openapi({
      description:
        "僅 completed 才有。supported 代表照片支持回報，不等同現地已獨立核實。",
    }),
    reasonCode: z.string().openapi({ example: "QUEUED" }),
    reason: z.string().openapi({ example: "影像辨識排隊中" }),
    observations: z.array(z.string()).optional(),
    limitations: z.array(z.string()).optional(),
    requiredEvidence: z.array(z.enum(REQUIRED_EVIDENCE)).optional(),
    visibleHazards: z.array(z.enum(VISIBLE_HAZARDS)).optional(),
    queuedAt: z.string().optional(),
    startedAt: z.string().optional(),
    completedAt: z.string().optional(),
    delayed: z.boolean().optional().openapi({
      description:
        "queued/processing 已超過工作期限（worker 或資料庫不可用）；請手動刷新或重新提交。",
    }),
  })
  .openapi("HazardAiReview", {
    description:
      "v2 AI 審核狀態（舊回報沒有此欄位）。以純文字顯示 reason／observations。",
  });

const HazardReportSchema = z
  .object({
    _id: z.string().openapi({ example: "6670abc123def4567890abcd" }),
    reporterId: z
      .string()
      .optional()
      .openapi({ example: "665f0011aa22bb33cc44dd55" }),
    hazardType: z.enum(HAZARD_TYPES).openapi({ example: "obstacle" }),
    severity: z.enum(SEVERITIES).openapi({ example: "difficult" }),
    expectedUntil: z.string().nullable().openapi({
      example: null,
      description: "預計此障礙持續到何時；null 表示依預設有效期自動過期",
    }),
    reportedLocation: GeoPointSchema,
    description: z
      .string()
      .optional()
      .openapi({ example: "人行道上有施工鐵板未固定" }),
    hasPhoto: z.boolean().openapi({
      example: true,
      description: "照片是否仍保留；讀取照片仍須本人或管理員授權。",
    }),
    status: z.enum(STATUSES).openapi({ example: "pending" }),
    exifValidation: z
      .object({
        timestampFresh: z.boolean(),
        gpsPresent: z.boolean(),
        gpsMatchesClaimed: z.boolean(),
      })
      .optional(),
    aiVerification: z
      .object({
        verdict: z
          .enum(["verified", "suspicious", "rejected", "skipped"])
          .openapi({ example: "skipped" }),
        confidence: z.number().openapi({ example: 0 }),
        reason: z.string().openapi({ example: "影像辨識進行中" }),
      })
      .optional(),
    aiReview: AiReviewSchema.optional(),
    confirmCount: z.number().openapi({ example: 0 }),
    denyCount: z.number().openapi({ example: 0 }),
    manualReview: z
      .object({
        reviewerId: z.string(),
        decision: z.enum(["verified", "rejected"]),
        note: z.string().optional(),
        reviewedAt: z.string(),
      })
      .optional(),
    createdAt: z.string().openapi({ example: "2026-06-17T08:30:00.000Z" }),
    expiredAt: z.string().openapi({ example: "2026-06-17T14:30:00.000Z" }),
    deidentifiedAt: z.string().optional().openapi({
      example: "2026-09-16T00:00:00.000Z",
      description:
        "已依隱私政策去識別化的時間（照片、描述、回報者與投票者身分皆已移除）；未去識別化時不出現。",
    }),
  })
  .openapi("HazardReport");

const ApiResponseSchema = <T extends z.ZodTypeAny>(data: T, refName: string) =>
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

export const CreateReportResponseSchema = ApiResponseSchema(
  z.object({ report: HazardReportSchema }),
  "CreateHazardReportResponse",
);

export const NearbyReportsResponseSchema = ApiResponseSchema(
  z.object({
    reports: z.array(HazardReportSchema),
    total: z.number(),
    queryCenter: z.object({ lat: z.number(), lng: z.number() }),
    radiusM: z.number(),
  }),
  "NearbyHazardReportsResponse",
);

export const SingleReportResponseSchema = ApiResponseSchema(
  z.object({ report: HazardReportSchema }),
  "SingleHazardReportResponse",
);

export const MyReportsResponseSchema = ApiResponseSchema(
  z.object({
    reports: z.array(HazardReportSchema),
    total: z.number(),
    nextCursor: z.string().nullable(),
  }),
  "MyHazardReportsResponse",
);

export const ConfirmResponseSchema = ApiResponseSchema(
  z.object({
    reportId: z.string(),
    action: z.enum(["confirm", "deny"]),
    confirmCount: z.number(),
    denyCount: z.number(),
  }),
  "ConfirmHazardReportResponse",
);

export const ReviewQueueResponseSchema = ApiResponseSchema(
  z.object({
    reports: z.array(HazardReportSchema),
    total: z.number(),
    nextCursor: z.string().nullable(),
  }),
  "HazardReviewQueueResponse",
);

export const ReviewDecisionResponseSchema = ApiResponseSchema(
  z.object({ report: HazardReportSchema }),
  "HazardReviewDecisionResponse",
);

export const HazardAiMetricsDataSchema = z
  .object({
    checkedAt: z.string().datetime(),
    mongoAvailable: z.boolean(),
    health: z
      .object({
        running: z.boolean(),
        paused: z.boolean(),
        active: z.number().int().nonnegative(),
        circuitOpen: z.boolean(),
        lastPollAt: z.string().datetime().nullable(),
        lastMaintenanceAt: z.string().datetime().nullable(),
        lastCleanupAt: z.string().datetime().nullable(),
        lastConvergenceAt: z.string().datetime().nullable(),
        counters: z
          .object({
            claimed: z.number().int().nonnegative(),
            completed: z.number().int().nonnegative(),
            retried: z.number().int().nonnegative(),
            failed: z.number().int().nonnegative(),
            dropped: z.number().int().nonnegative(),
            aborted: z.number().int().nonnegative(),
          })
          .strict(),
      })
      .strict()
      .nullable(),
    queue: z
      .object({
        queued: z.number().int().nonnegative(),
        processing: z.number().int().nonnegative(),
        expiredLease: z.number().int().nonnegative(),
        oldestQueuedAgeMs: z.number().nonnegative().nullable(),
      })
      .strict()
      .nullable(),
    intake: z
      .object({
        uploading: z.number().int().nonnegative(),
        cleanupPending: z.number().int().nonnegative(),
        cleanupOverdue: z.number().int().nonnegative(),
      })
      .strict()
      .nullable(),
    alerts: z.array(z.enum(HAZARD_AI_ALERT_CODES)),
  })
  .strict()
  .openapi("HazardAiMetrics");

registry.registerPath({
  method: "get",
  path: "/a11y/reports/ops/metrics",
  tags: ["Hazard Report"],
  summary: "影像審核維運指標（管理員）",
  description:
    "僅 role=admin；no-store、single-flight、五秒硬期限。回傳本 process worker 的健康狀態及共享 Mongo 佇列／intake 聚合計數，不含照片、個資、ID、路徑或原始錯誤。AI_PAUSED 為明確設定資訊；其他 alerts 應送維運告警。公開 /health 保留 HTTP 200 liveness，只顯示粗粒度狀態，不提供詳細指標。",
  security: [{ bearerAuth: [] }],
  request: { query: AiMetricsQuerySchema },
  responses: {
    200: {
      description: "監測可用（可能有 paused／aging 等 alerts）",
      content: {
        "application/json": {
          schema: ApiResponseSchema(
            HazardAiMetricsDataSchema,
            "HazardAiMetricsResponse",
          ),
        },
      },
    },
    400: { description: "不接受額外查詢參數" },
    401: { description: "token 過期" },
    403: { description: "未提供 token、token 無效或非管理員" },
    429: { description: "查詢過於頻繁（與 nearby 共用 30/min 配額）" },
    503: {
      description:
        "Mongo 不可用／逾時或 worker 尚未啟動／已停止；data 仍含受控 alerts，queue／intake 在 Mongo 失敗時為 null",
      content: {
        "application/json": {
          schema: ApiResponseSchema(
            HazardAiMetricsDataSchema,
            "HazardAiMetricsUnavailableResponse",
          ),
        },
      },
    },
  },
});

registry.registerPath({
  method: "post",
  path: "/a11y/reports",
  tags: ["Hazard Report"],
  summary: "提交路況回報",
  description:
    "以即時拍攝照片提交路況回報（免登入）。`latitude`/`longitude` 為使用者當下位置，同時作為回報地點。後端執行 EXIF 時間/GPS 驗證、GCS 上傳並建立回報；AI 影像辨識於回應後非同步進行。Content-Type 為 multipart/form-data。",
  request: {
    body: {
      content: {
        "multipart/form-data": {
          schema: z.object({
            photo: z.string().openapi({
              type: "string",
              format: "binary",
              description: "路況照片（支援 JPEG、PNG、WebP、HEIC、HEIF）",
            }),
            hazardType: z.enum(HAZARD_TYPES),
            severity: z.enum(SEVERITIES),
            latitude: z.number(),
            longitude: z.number(),
            description: z.string().optional(),
            expectedUntil: z.string().datetime().optional(),
          }),
        },
      },
    },
  },
  responses: {
    201: {
      description: "回報已建立（pending），含 _id 供輪詢",
      content: { "application/json": { schema: CreateReportResponseSchema } },
    },
    200: {
      description:
        "已合併至附近既有回報（data.merged=true，data.photoReviewed=false）",
      content: { "application/json": { schema: CreateReportResponseSchema } },
    },
    400: {
      description:
        "驗證失敗：EXIF_TOO_OLD、EXIF_GPS_MISMATCH、IMAGE_INVALID、IMAGE_UNSUPPORTED、IMAGE_TOO_LARGE 等",
    },
    429: { description: "回報過於頻繁" },
    500: { description: "照片上傳失敗（UPLOAD_FAILED）" },
    503: {
      description:
        "PHOTO_PROCESSING_UNAVAILABLE（照片處理忙碌）或 REPORT_COMMIT_UNCERTAIN（儲存結果未確認，data.reportId 可供稍後查詢；GET 在就緒前回 404）",
    },
  },
});

registry.registerPath({
  method: "get",
  path: "/a11y/reports",
  tags: ["Hazard Report"],
  summary: "查詢附近路況回報",
  description:
    "以 $near 回傳指定座標半徑內的回報，依距離排序。預設只回傳「有效且已核可」的回報（AI 判定 supported 或人工核可、未過期；舊版 verified 維持原行為）；排隊中、辨識中、證據不足、失敗或已取消的待審回報不在預設清單內，請改用 GET /a11y/reports/{id}、/a11y/reports/mine，或明確指定 status=pending（回傳未核實資料，請依 aiReview 呈現）。行為變更：先前預設含 pending。",
  request: { query: NearbyReportsQuerySchema },
  responses: {
    200: {
      description: "附近回報清單",
      content: { "application/json": { schema: NearbyReportsResponseSchema } },
    },
    400: { description: "缺少或無效的查詢參數" },
  },
});

registry.registerPath({
  method: "get",
  path: "/a11y/reports/mine",
  tags: ["Hazard Report"],
  summary: "查詢我的回報紀錄",
  description:
    "回傳目前登入使用者的回報（依 reporterId，預設含 expired），以 createdAt 由新到舊游標分頁。過期或被拒絕滿 90 天的回報會依隱私政策去識別化（回報者身分移除），之後不再出現在此清單。",
  security: [{ bearerAuth: [] }],
  request: { query: MyReportsQuerySchema },
  responses: {
    200: {
      description: "我的回報清單",
      content: { "application/json": { schema: MyReportsResponseSchema } },
    },
    401: { description: "未登入或 token 過期" },
    403: { description: "token 無效" },
  },
});

registry.registerPath({
  method: "get",
  path: "/a11y/reports/{id}",
  tags: ["Hazard Report"],
  summary: "取得單一回報",
  description:
    "依 ID 回傳單筆回報，供前端輪詢最新 status、aiVerification 與 aiReview（queued/processing 才需輪詢）。尚未完成照片接收的私有回報回 404。",
  request: { params: ReportIdParamSchema },
  responses: {
    200: {
      description: "回報文件",
      content: { "application/json": { schema: SingleReportResponseSchema } },
    },
    400: { description: "無效的回報 ID 格式" },
    404: { description: "找不到對應的回報" },
  },
});

registry.registerPath({
  method: "post",
  path: "/a11y/reports/{id}/confirm",
  tags: ["Hazard Report"],
  summary: "社群二次確認／否認",
  description:
    "其他使用者對既有回報投下確認或否認票（帶 JWT 以 userId 記錄，否則以 IP hash 匿名識別，皆防重複投票）。",
  request: {
    params: ReportIdParamSchema,
    body: { content: { "application/json": { schema: ConfirmSchema } } },
  },
  responses: {
    200: {
      description: "更新後的票數",
      content: { "application/json": { schema: ConfirmResponseSchema } },
    },
    400: { description: "無效 ID 或重複投票" },
    404: { description: "找不到對應的回報" },
    410: { description: "回報已過期或已依隱私政策去識別化，無法投票" },
  },
});

registry.registerPath({
  method: "get",
  path: "/a11y/reports/review-queue",
  tags: ["Hazard Report"],
  summary: "待人工審核回報清單（管理員）",
  description:
    "回傳需要人工審核的舊版（無 aiReview）回報：AI 判定 suspicious，或 AI 判定 skipped 且建立時間已超過設定的逾時門檻（預設 10 分鐘），以建立時間由舊到新排序。v2 的 failed／needs_evidence 不進例行佇列，管理員仍可依 ID 審核。僅限 role=admin。",
  security: [{ bearerAuth: [] }],
  request: { query: ReviewQueueQuerySchema },
  responses: {
    200: {
      description: "待審核清單",
      content: { "application/json": { schema: ReviewQueueResponseSchema } },
    },
    401: { description: "未登入或 token 過期" },
    403: { description: "非管理員" },
  },
});

registry.registerPath({
  method: "post",
  path: "/a11y/reports/{id}/review",
  tags: ["Hazard Report"],
  summary: "人工審核回報（管理員）",
  description:
    "管理員直接核定回報為 verified 或 rejected，略過 AI/社群流程，並留下審核紀錄（manualReview）。僅限 role=admin。",
  security: [{ bearerAuth: [] }],
  request: {
    params: ReportIdParamSchema,
    body: { content: { "application/json": { schema: ReviewDecisionSchema } } },
  },
  responses: {
    200: {
      description: "審核結果",
      content: { "application/json": { schema: ReviewDecisionResponseSchema } },
    },
    400: { description: "無效的回報 ID 格式" },
    401: { description: "未登入或 token 過期" },
    403: { description: "非管理員" },
    404: { description: "找不到對應的回報" },
    410: { description: "回報已依隱私政策去識別化，無法再審核" },
  },
});

registry.registerPath({
  method: "get",
  path: "/a11y/reports/{id}/photo",
  tags: ["Hazard Report"],
  summary: "取得私人回報照片（本人或管理員）",
  description:
    "先驗證授權再讀私人 bucket；含過期回報。回傳 JPEG bytes，不重新導向。Cache-Control: private, no-store。",
  security: [{ bearerAuth: [] }],
  request: { params: PhotoReportIdParamSchema },
  responses: {
    200: {
      description: "可解碼圖片",
      content: {
        "image/jpeg": {
          schema: z.string().openapi({ type: "string", format: "binary" }),
        },
      },
    },
    400: { description: "無效的回報 ID" },
    401: { description: "未登入或 token 過期" },
    403: { description: "token 無效" },
    404: { description: "無存取權、回報或照片不存在、已清除" },
    429: { description: "請求過於頻繁" },
    503: { description: "儲存或照片處理暫時不可用，可重試" },
  },
});

registry.registerPath({
  method: "get",
  path: "/a11y/reports/safety",
  tags: ["Hazard Report"],
  summary: "公開導航安全事實（不含使用者文字、圖片、作者）",
  description:
    "個人封鎖不改變路況風險；僅提供仍有效且已驗證的障礙事實，平台下架內容一律排除。",
  request: { query: NearbyReportsQuerySchema },
  responses: {
    200: {
      description: "安全障礙資料",
      content: {
        "application/json": {
          schema: z.object({
            ok: z.boolean(),
            status: z.string(),
            code: z.number(),
            message: z.string(),
            data: z.object({
              total: z.number(),
              reports: z.array(
                z.object({
                  _id: z.string(),
                  hazardType: z.string(),
                  severity: z.string().optional(),
                  reportedLocation: z.object({
                    type: z.literal("Point"),
                    coordinates: z.array(z.number()),
                  }),
                  status: z.literal("verified"),
                  expiredAt: z.string(),
                }),
              ),
            }),
          }),
        },
      },
    },
    400: { description: "查詢參數錯誤" },
    429: { description: "限流" },
  },
});
