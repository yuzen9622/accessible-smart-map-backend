import { extendZodWithOpenApi } from "@asteasolutions/zod-to-openapi";
import { z } from "zod";
import { registry } from "../../openapi/registry";

extendZodWithOpenApi(z);

const PLACE_TYPES = ["osm", "a11y", "bathroom", "welfare", "parking", "google"] as const;

export const PlaceTypeSchema = z.enum(PLACE_TYPES);
export const EntranceAccessibilitySchema = z.enum([
  "step_free",
  "ramp",
  "stairs_with_assistance",
  "inaccessible",
]);

export const CreateReviewSchema = z
  .object({
    placeId: z.string().min(1).openapi({ example: "node/123456" }),
    placeType: PlaceTypeSchema.openapi({ example: "osm" }),
    passageWidthRating: z.coerce.number().int().min(1).max(5).openapi({ example: 4 }),
    toiletRating: z.coerce.number().int().min(1).max(5).openapi({ example: 4 }),
    elevatorRating: z.coerce.number().int().min(1).max(5).openapi({ example: 4 }),
    serviceRating: z.coerce.number().int().min(1).max(5).openapi({ example: 4 }),
    entranceAccessibility: EntranceAccessibilitySchema.optional().openapi({
      example: "step_free",
      description: "入口狀況：step_free、ramp、stairs_with_assistance 或 inaccessible",
    }),
    toiletTurningRoom: z.boolean().optional().openapi({
      example: true,
      description: "輪椅可在無障礙廁所內迴轉",
    }),
    wheelchairTableHeight: z.boolean().optional().openapi({
      example: true,
      description: "桌面高度適合輪椅使用者",
    }),
    adequateAisleWidth: z.boolean().optional().openapi({
      example: true,
      description: "主要走道寬度足夠輪椅通行",
    }),
    staffHelpfulnessRating: z.coerce.number().int().min(1).max(5).optional().openapi({
      example: 4,
      description: "工作人員協助程度，1 到 5 分",
    }),
    comment: z.string().max(500).optional().openapi({ example: "電梯空間寬敞，坡道坡度適中" }),
  })
  .strict();

export const UpdateReviewSchema = z
  .object({
    passageWidthRating: z.coerce.number().int().min(1).max(5).optional().openapi({ example: 4 }),
    toiletRating: z.coerce.number().int().min(1).max(5).optional().openapi({ example: 4 }),
    elevatorRating: z.coerce.number().int().min(1).max(5).optional().openapi({ example: 4 }),
    serviceRating: z.coerce.number().int().min(1).max(5).optional().openapi({ example: 4 }),
    entranceAccessibility: EntranceAccessibilitySchema.optional().openapi({
      example: "ramp",
      description: "入口狀況：step_free、ramp、stairs_with_assistance 或 inaccessible",
    }),
    toiletTurningRoom: z.boolean().optional().openapi({
      example: true,
      description: "輪椅可在無障礙廁所內迴轉",
    }),
    wheelchairTableHeight: z.boolean().optional().openapi({
      example: true,
      description: "桌面高度適合輪椅使用者",
    }),
    adequateAisleWidth: z.boolean().optional().openapi({
      example: true,
      description: "主要走道寬度足夠輪椅通行",
    }),
    staffHelpfulnessRating: z.coerce.number().int().min(1).max(5).optional().openapi({
      example: 5,
      description: "工作人員協助程度，1 到 5 分",
    }),
    comment: z.string().max(500).optional().openapi({ example: "再次造訪，電梯已修好" }),
  })
  .strict();

export const ListReviewsQuerySchema = z
  .object({
    placeId: z.string().min(1).openapi({ example: "node/123456" }),
    placeType: PlaceTypeSchema.openapi({ example: "osm" }),
    page: z.coerce.number().int().min(1).default(1).openapi({ example: 1 }),
    limit: z.coerce.number().int().min(1).max(50).default(10).openapi({ example: 10 }),
    minAggregateScore: z.coerce.number().min(1).max(5).optional().openapi({
      example: 3.5,
      description: "只回傳 aggregateAccessibilityScore 至少為此值的評價（1 到 5）",
    }),
  })
  .strict();

export const SummaryQuerySchema = z
  .object({
    placeId: z.string().min(1).openapi({ example: "node/123456" }),
    placeType: PlaceTypeSchema.openapi({ example: "osm" }),
  })
  .strict();

export const ReviewIdParamSchema = z
  .object({
    id: z.string().regex(/^[0-9a-f]{24}$/, "無效的評價 ID 格式").openapi({ example: "66a1f2c3e4b5a6d7c8e9f0d4" }),
  })
  .strict();

const ReviewItemSchema = z
  .object({
    _id: z.string().openapi({ example: "66a1f2c3e4b5a6d7c8e9f0d4" }),
    userId: z.string().openapi({ example: "665f0011aa22bb33cc44dd55" }),
    rating: z.number().openapi({ example: 4 }),
    passageWidthRating: z.number().openapi({ example: 4 }),
    toiletRating: z.number().openapi({ example: 4 }),
    elevatorRating: z.number().openapi({ example: 4 }),
    serviceRating: z.number().openapi({ example: 4 }),
    entranceAccessibility: EntranceAccessibilitySchema.optional().openapi({
      example: "step_free",
      description: "入口狀況；舊評價未提供時省略",
    }),
    toiletTurningRoom: z.boolean().optional().openapi({
      example: true,
      description: "輪椅可在無障礙廁所內迴轉；舊評價未提供時省略",
    }),
    wheelchairTableHeight: z.boolean().optional().openapi({
      example: true,
      description: "桌面高度適合輪椅使用者；舊評價未提供時省略",
    }),
    adequateAisleWidth: z.boolean().optional().openapi({
      example: true,
      description: "主要走道寬度足夠輪椅通行；舊評價未提供時省略",
    }),
    staffHelpfulnessRating: z.number().int().min(1).max(5).optional().openapi({
      example: 4,
      description: "工作人員協助程度；舊評價未提供時省略",
    }),
    aggregateAccessibilityScore: z.number().min(1).max(5).optional().openapi({
      example: 4.2,
      description: "1 到 5 的衍生無障礙分數；不會改寫既有 rating",
    }),
    comment: z.string().optional().openapi({ example: "電梯空間寬敞" }),
    createdAt: z.string().openapi({ example: "2026-06-25T08:00:00.000Z" }),
  })
  .openapi("ReviewItem");

const ApiResponseSchema = <T extends z.ZodTypeAny>(data: T, refName: string) =>
  z
    .object({
      ok: z.boolean().openapi({ example: true }),
      status: z.enum(["success", "error"]).openapi({ example: "success" }),
      code: z.number().openapi({ example: 200 }),
      message: z.string().openapi({ example: "OK" }),
      data: data.optional(),
    })
    .openapi(refName);

const CreateReviewResponseSchema = ApiResponseSchema(
  z.object({
    review: ReviewItemSchema,
  }),
  "CreateReviewResponse",
);

const UpdateReviewResponseSchema = ApiResponseSchema(
  z.object({
    review: ReviewItemSchema,
  }),
  "UpdateReviewResponse",
);

const ListReviewsResponseSchema = ApiResponseSchema(
  z.object({
    items: z.array(ReviewItemSchema),
    avgRating: z.number().nullable().openapi({ example: 4.2 }),
    totalCount: z.number().openapi({ example: 12 }),
    page: z.number().openapi({ example: 1 }),
    totalPages: z.number().openapi({ example: 2 }),
  }),
  "ListReviewsResponse",
);

const ReviewSummaryResponseSchema = ApiResponseSchema(
  z.object({
    avgRating: z.number().nullable().openapi({ example: 4.2 }),
    totalCount: z.number().openapi({ example: 12 }),
    summary: z.string().nullable().openapi({ example: "整體評價良好，電梯寬敞且坡道坡度適中" }),
    highlights: z.array(z.string()).nullable().openapi({ example: ["電梯空間寬敞", "坡道坡度適中"] }),
  }),
  "ReviewSummaryResponse",
);

registry.registerPath({
  method: "post",
  path: "/a11y/reviews",
  tags: ["Review"],
  summary: "新增評價",
  description: "登入使用者對無障礙設施新增既有評分與可選的結構化無障礙證據；每位使用者對同一地點只能留一筆評價。既有 rating 的語意不變，aggregateAccessibilityScore 會另外衍生。",
  security: [{ bearerAuth: [] }],
  request: {
    body: { content: { "application/json": { schema: CreateReviewSchema } } },
  },
  responses: {
    201: {
      description: "評價已建立",
      content: { "application/json": { schema: CreateReviewResponseSchema } },
    },
    400: { description: "驗證失敗或已評價過此地點" },
    401: { description: "未登入或 token 過期" },
    403: { description: "token 無效" },
  },
});

registry.registerPath({
  method: "get",
  path: "/a11y/reviews",
  tags: ["Review"],
  summary: "取得地點評價列表",
  description: "查詢指定地點的所有有效評價，支援分頁與 minAggregateScore（1 到 5）篩選，並回傳既有平均 rating 與總筆數。",
  request: { query: ListReviewsQuerySchema },
  responses: {
    200: {
      description: "評價列表",
      content: { "application/json": { schema: ListReviewsResponseSchema } },
    },
    400: { description: "缺少或無效的查詢參數" },
  },
});

registry.registerPath({
  method: "patch",
  path: "/a11y/reviews/{id}",
  tags: ["Review"],
  summary: "更新自己的評價",
  description: "更新自己對某無障礙設施的既有評分、結構化無障礙證據或評語，只能修改本人的評價。既有 rating 的語意不變，aggregateAccessibilityScore 會另外重新計算。",
  security: [{ bearerAuth: [] }],
  request: {
    params: ReviewIdParamSchema,
    body: { content: { "application/json": { schema: UpdateReviewSchema } } },
  },
  responses: {
    200: {
      description: "評價已更新",
      content: { "application/json": { schema: UpdateReviewResponseSchema } },
    },
    400: { description: "無效的評價 ID 格式" },
    401: { description: "未登入或 token 過期" },
    403: { description: "無權限修改此評價" },
    404: { description: "找不到此評價" },
  },
});

registry.registerPath({
  method: "delete",
  path: "/a11y/reviews/{id}",
  tags: ["Review"],
  summary: "刪除自己的評價",
  description: "軟刪除自己的評價（status 設為 deleted），只能刪除本人的評價。",
  security: [{ bearerAuth: [] }],
  request: { params: ReviewIdParamSchema },
  responses: {
    200: { description: "評價已刪除" },
    400: { description: "無效的評價 ID 格式" },
    401: { description: "未登入或 token 過期" },
    403: { description: "無權限刪除此評價" },
    404: { description: "找不到此評價" },
  },
});

registry.registerPath({
  method: "get",
  path: "/a11y/reviews/summary",
  tags: ["Review"],
  summary: "取得 AI 評價摘要",
  description: "彙整指定地點的所有評價，透過 Gemini AI 生成整體摘要與亮點。評價數不足 3 筆時僅回傳統計數據，不含 AI 生成內容。",
  request: { query: SummaryQuerySchema },
  responses: {
    200: {
      description: "AI 評價摘要",
      content: { "application/json": { schema: ReviewSummaryResponseSchema } },
    },
    400: { description: "缺少或無效的查詢參數" },
  },
});
