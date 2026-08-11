import { extendZodWithOpenApi } from "@asteasolutions/zod-to-openapi";
import { z } from "zod";
import { registry } from "../../openapi/registry";

extendZodWithOpenApi(z);

const HAZARD_TYPES = ["obstacle", "construction", "data_error"] as const;
const SEVERITIES = ["blocking", "difficult", "minor"] as const;
const STATUSES = ["pending", "verified", "rejected", "expired"] as const;
const MAX_EXPECTED_UNTIL_DAYS = 180;

export const CreateHazardReportSchema = z
  .object({
    hazardType: z.enum(HAZARD_TYPES).openapi({ example: "obstacle" }),
    severity: z
      .enum(SEVERITIES)
      .openapi({ example: "difficult", description: "blocking=完全無法通行, difficult=可通行但困難, minor=輕微影響" }),
    latitude: z.coerce.number().min(-90).max(90).openapi({ example: 25.033 }),
    longitude: z.coerce.number().min(-180).max(180).openapi({ example: 121.5654 }),
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
          return date.getTime() > now && date.getTime() <= now + MAX_EXPECTED_UNTIL_DAYS * 86_400_000;
        },
        { message: `expectedUntil 必須在未來且不超過 ${MAX_EXPECTED_UNTIL_DAYS} 天` },
      )
      .openapi({ example: "2026-09-30T00:00:00.000Z", description: "預計此障礙持續到何時；未提供時依 hazardType 使用預設有效期" }),
  })
  .strict();

export const NearbyReportsQuerySchema = z
  .object({
    lat: z.coerce.number().min(-90).max(90).openapi({ example: 25.033 }),
    lng: z.coerce.number().min(-180).max(180).openapi({ example: 121.5654 }),
    radius: z.coerce.number().min(1).max(5000).optional().openapi({ example: 500 }),
    hazardType: z.enum(HAZARD_TYPES).optional(),
    status: z.string().optional().openapi({ example: "pending,verified" }),
    limit: z.coerce.number().min(1).max(50).optional().openapi({ example: 20 }),
  })
  .strict();

export const MyReportsQuerySchema = z
  .object({
    status: z.string().optional().openapi({ example: "pending,verified,expired" }),
    hazardType: z.enum(HAZARD_TYPES).optional(),
    limit: z.coerce.number().min(1).max(50).optional().openapi({ example: 20 }),
    cursor: z.string().optional().openapi({ example: "6670abc123def4567890abcd" }),
  })
  .strict();

export const ReportIdParamSchema = z
  .object({
    id: z.string().min(1).openapi({ example: "6670abc123def4567890abcd" }),
  })
  .strict();

export const ConfirmSchema = z
  .object({
    action: z.enum(["confirm", "deny"]).openapi({ example: "confirm" }),
  })
  .strict();

const GeoPointSchema = z
  .object({
    type: z.literal("Point").openapi({ example: "Point" }),
    coordinates: z
      .tuple([z.number(), z.number()])
      .openapi({ example: [121.5654, 25.033] }),
  })
  .openapi("HazardGeoPoint");

const HazardReportSchema = z
  .object({
    _id: z.string().openapi({ example: "6670abc123def4567890abcd" }),
    reporterId: z.string().optional().openapi({ example: "665f0011aa22bb33cc44dd55" }),
    hazardType: z.enum(HAZARD_TYPES).openapi({ example: "obstacle" }),
    severity: z.enum(SEVERITIES).openapi({ example: "difficult" }),
    expectedUntil: z
      .string()
      .nullable()
      .openapi({ example: null, description: "預計此障礙持續到何時；null 表示依預設有效期自動過期" }),
    reportedLocation: GeoPointSchema,
    description: z.string().optional().openapi({ example: "人行道上有施工鐵板未固定" }),
    photoUrl: z
      .string()
      .openapi({ example: "https://storage.googleapis.com/bucket/reports/6670abc.jpg" }),
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
    confirmCount: z.number().openapi({ example: 0 }),
    denyCount: z.number().openapi({ example: 0 }),
    createdAt: z.string().openapi({ example: "2026-06-17T08:30:00.000Z" }),
    expiredAt: z.string().openapi({ example: "2026-06-17T14:30:00.000Z" }),
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
            photo: z.string().openapi({ type: "string", format: "binary" }),
            hazardType: z.enum(HAZARD_TYPES),
            latitude: z.number(),
            longitude: z.number(),
            description: z.string().optional(),
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
    400: { description: "驗證失敗（EXIF/照片）" },
    429: { description: "回報過於頻繁" },
    500: { description: "照片上傳或伺服器錯誤" },
  },
});

registry.registerPath({
  method: "get",
  path: "/a11y/reports",
  tags: ["Hazard Report"],
  summary: "查詢附近路況回報",
  description: "以 $near 回傳指定座標半徑內的回報（預設排除 expired/rejected），依距離排序。",
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
  description: "回傳目前登入使用者的回報（依 reporterId，預設含 expired），以 createdAt 由新到舊游標分頁。",
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
  description: "依 ID 回傳單筆回報，供前端輪詢最新 status 與 aiVerification。",
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
  description: "其他使用者對既有回報投下確認或否認票（帶 JWT 以 userId 記錄，否則以 IP hash 匿名識別，皆防重複投票）。",
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
    410: { description: "回報已過期，無法投票" },
  },
});
