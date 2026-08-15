import { extendZodWithOpenApi } from "@asteasolutions/zod-to-openapi";
import { z } from "zod";
import { registry } from "../../openapi/registry";

extendZodWithOpenApi(z);

export const WelfareNearbyQuerySchema = z
  .object({
    lat: z.coerce.number().min(-90).max(90).openapi({ example: 25.05 }),
    lng: z.coerce.number().min(-180).max(180).openapi({ example: 121.51 }),
    radius: z.coerce
      .number()
      .int()
      .min(100)
      .max(20000)
      .default(1000)
      .openapi({ example: 1000, description: "搜尋半徑（公尺），預設 1000" }),
  })
  .strict();

export const WelfareListQuerySchema = z
  .object({
    county: z.string().optional().openapi({ example: "臺北市" }),
    type: z
      .string()
      .optional()
      .openapi({ example: "日間型機構", description: "機構類型" }),
  })
  .strict();

export const WelfareParamsSchema = z.object({
  id: z
    .string()
    .regex(/^[0-9a-fA-F]{24}$/, "Must be a Mongo ObjectId")
    .openapi({ example: "66a1f2c3e4b5a6d7c8e9f0d4" }),
});

const GeoPointSchema = z.object({
  type: z.literal("Point"),
  coordinates: z.tuple([z.number(), z.number()]),
});

const CapacitySchema = z.object({
  residential: z.number().openapi({ example: 173 }),
  night: z.number().openapi({ example: 0 }),
  day: z.number().openapi({ example: 0 }),
});

export const WelfareSchema = z
  .object({
    _id: z.string().openapi({ example: "66a1f2c3e4b5a6d7c8e9f0d4" }),
    name: z.string().openapi({ example: "新北市愛維養護中心" }),
    county: z.string().openapi({ example: "新北市" }),
    district: z.string().openapi({ example: "八里區" }),
    address: z.string().openapi({ example: "新北市八里區華富山35號" }),
    phone: z.string().openapi({ example: "02-86304104" }),
    type: z.string().openapi({ example: "全日型住宿式機構" }),
    approvedCapacity: CapacitySchema,
    actualServed: CapacitySchema,
    evaluationTerm: z.string().openapi({ example: "11" }),
    evaluationGrade: z.string().openapi({ example: "優" }),
    geocoded: z.boolean().openapi({ example: true }),
    location: GeoPointSchema.optional(),
    importedAt: z.string().openapi({ example: "2026-06-24T00:00:00.000Z" }),
  })
  .openapi("Welfare");

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

export const WelfareListResponseSchema = ApiResponseSchema(
  z.array(WelfareSchema),
  "WelfareListResponse",
);

export const WelfareDetailResponseSchema = ApiResponseSchema(
  WelfareSchema,
  "WelfareDetailResponse",
);

registry.registerPath({
  method: "get",
  path: "/a11y/welfare/nearby",
  tags: ["Welfare"],
  summary: "鄰近身心障礙福利機構",
  description: "回傳指定座標附近、已成功定位的福利機構（預設半徑 1000 公尺）。",
  request: { query: WelfareNearbyQuerySchema },
  responses: {
    200: {
      description: "鄰近福利機構清單",
      content: { "application/json": { schema: WelfareListResponseSchema } },
    },
    400: { description: "缺少或無效的經緯度" },
    500: { description: "伺服器錯誤" },
  },
});

registry.registerPath({
  method: "get",
  path: "/a11y/welfare",
  tags: ["Welfare"],
  summary: "福利機構目錄（可篩選）",
  description: "回傳福利機構清單，可用 county / type 篩選。",
  request: { query: WelfareListQuerySchema },
  responses: {
    200: {
      description: "福利機構清單",
      content: { "application/json": { schema: WelfareListResponseSchema } },
    },
    500: { description: "伺服器錯誤" },
  },
});

registry.registerPath({
  method: "get",
  path: "/a11y/welfare/{id}",
  tags: ["Welfare"],
  summary: "福利機構詳情",
  description: "依機構 id 回傳完整資訊（含核定/實際服務人數、評鑑）。",
  request: { params: WelfareParamsSchema },
  responses: {
    200: {
      description: "福利機構詳情",
      content: { "application/json": { schema: WelfareDetailResponseSchema } },
    },
    404: { description: "查無此機構" },
    500: { description: "伺服器錯誤" },
  },
});
