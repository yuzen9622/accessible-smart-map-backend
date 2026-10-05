import { extendZodWithOpenApi } from "@asteasolutions/zod-to-openapi";
import { z } from "zod";
import { registry } from "../../openapi/registry";

extendZodWithOpenApi(z);

export const VisualA11yNearbyQuerySchema = z
  .object({
    lat: z.coerce.number().min(-90).max(90).openapi({ example: 25.047 }),
    lng: z.coerce.number().min(-180).max(180).openapi({ example: 121.517 }),
    radius: z.coerce
      .number()
      .int()
      .min(100)
      .max(5000)
      .default(500)
      .openapi({ example: 500, description: "搜尋半徑（公尺），預設 500" }),
    type: z
      .enum(["audio_signal", "tactile_paving"])
      .optional()
      .openapi({ description: "設施類型篩選" }),
  })
  .strict();

const GeoPointSchema = z.object({
  type: z.literal("Point"),
  coordinates: z.tuple([z.number(), z.number()]),
});

const VisualA11yPropertiesSchema = z.object({
  buttonOperated: z.boolean().nullable().optional(),
  vibration: z.boolean().nullable().optional(),
  roadName: z.string().nullable().optional(),
  subType: z.string().nullable().optional(),
  name: z.string().nullable().optional(),
  nameEn: z.string().nullable().optional(),
  wheelchair: z.string().nullable().optional(),
});

export const VisualA11yItemSchema = z
  .object({
    _id: z.string().openapi({ example: "66a1f2c3e4b5a6d7c8e9f0d4" }),
    source: z.enum(["osm", "taipei_tce"]).openapi({
      example: "taipei_tce",
      description:
        "osm＝OpenStreetMap 節點；taipei_tce＝臺北市交通管制工程處有聲號誌設置資料",
    }),
    sourceId: z.string().openapi({
      example: "SKWPX10",
      description: "來源內的識別碼：OSM 節點 id 或交工處號誌編號",
    }),
    osmNodeId: z
      .number()
      .optional()
      .openapi({ example: 656416266, description: "僅 source 為 osm 時存在" }),
    type: z.enum(["audio_signal", "tactile_paving"]),
    location: GeoPointSchema,
    properties: VisualA11yPropertiesSchema,
    updatedAt: z.string().openapi({ example: "2026-06-25T00:00:00.000Z" }),
  })
  .openapi("VisualA11yItem");

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

export const VisualA11yListResponseSchema = ApiResponseSchema(
  z.array(VisualA11yItemSchema),
  "VisualA11yListResponse",
);

export const VisualA11ySyncResponseSchema = ApiResponseSchema(
  z.object({
    inserted: z.number().openapi({ example: 120 }),
    updated: z.number().openapi({ example: 35 }),
  }),
  "VisualA11ySyncResponse",
);

registry.registerPath({
  method: "get",
  path: "/a11y/visual-a11y",
  tags: ["VisualA11y"],
  summary: "鄰近視障輔助設施",
  description:
    "回傳指定座標附近的有聲號誌（audio_signal）與導盲磚（tactile_paving）。來源含 OSM 與臺北市交工處有聲號誌設置資料（source 欄位區分）。",
  request: { query: VisualA11yNearbyQuerySchema },
  responses: {
    200: {
      description: "視障輔助設施清單",
      content: {
        "application/json": { schema: VisualA11yListResponseSchema },
      },
    },
    400: { description: "缺少或無效的經緯度" },
    500: { description: "伺服器錯誤" },
  },
});

registry.registerPath({
  method: "post",
  path: "/a11y/visual-a11y/sync",
  tags: ["VisualA11y"],
  summary: "同步 OSM 視障設施資料",
  description:
    "從 OpenStreetMap Overpass API 拉取最新有聲號誌與導盲磚資料，upsert 進 MongoDB。需登入，避免任意人觸發全國性 Overpass 查詢。",
  security: [{ bearerAuth: [] }],
  responses: {
    200: {
      description: "同步結果",
      content: {
        "application/json": { schema: VisualA11ySyncResponseSchema },
      },
    },
    401: { description: "未提供或已過期的 token" },
    403: { description: "token 無效" },
    500: { description: "伺服器錯誤" },
  },
});
