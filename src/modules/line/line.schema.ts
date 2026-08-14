import { extendZodWithOpenApi } from "@asteasolutions/zod-to-openapi";
import { z } from "zod";
import { registry } from "../../openapi/registry";
import { AccessibleRouteDataSchema } from "../accessible-route/accessible-route.schema";

extendZodWithOpenApi(z);

export const RoutePreviewQuerySchema = z
  .object({
    sessionId: z
      .string()
      .regex(/^[0-9a-f]{32}$/, "sessionId 必須是 32 位元 hex 的 SOS share token")
      .openapi({
        description:
          "SOS session 的 shareToken（32 位元 hex，建立 session 時產生），取自 LINE 路線預覽 URL。",
        example: "6a4e797394fbb1b1721c8b810c2d3e4f",
      }),
    travelMode: z
      .enum(["transit", "drive", "motorcycle", "walk"])
      .optional()
      .openapi({ example: "transit", description: "交通方式" }),
    mode: z
      .enum(["wheelchair", "elderly", "visual_impaired", "normal"])
      .optional()
      .openapi({ example: "normal", description: "無障礙模式" }),
    departureTime: z
      .string()
      .optional()
      .openapi({ example: "2026-07-09T16:00:00+08:00", description: "出發時間" }),
  })
  .strict();

const RoutePreviewDataSchema = AccessibleRouteDataSchema.extend({
  sessionId: z.string().openapi({ example: "6a4e797394fbb1b1721c8b81" }),
  ownerName: z.string().openapi({ example: "王小明" }),
  originLabel: z.string().openapi({ example: "你分享的位置" }),
  destinationLabel: z.string().openapi({ example: "台北車站" }),
}).openapi("LineRoutePreviewData");

const RoutePreviewResponseSchema = z
  .object({
    ok: z.boolean().openapi({ example: true }),
    status: z.enum(["success", "error"]).openapi({ example: "success" }),
    code: z.number().openapi({ example: 200 }),
    message: z.string().openapi({ example: "OK" }),
    data: RoutePreviewDataSchema.optional(),
  })
  .openapi("LineRoutePreviewResponse");

const RoutePreviewErrorSchema = z
  .object({
    ok: z.boolean().openapi({ example: false }),
    status: z.enum(["success", "error"]).openapi({ example: "error" }),
    code: z.number().openapi({ example: 404 }),
    message: z.string().openapi({ example: "找不到進行中的求救紀錄" }),
    data: z.unknown().optional(),
  })
  .openapi("LineRoutePreviewError");

registry.registerPath({
  method: "get",
  path: "/line/route-preview",
  tags: ["LINE"],
  summary: "取得 LINE SOS 路線預覽資料",
  description:
    "前端地圖頁以 sessionId hydrate LINE Flex Message 的路線預覽。此端點不重新實作路線引擎，會以 SOS 位置與最近分享位置的已綁定聯絡人作為起訖點，重用 accessible-route 規劃結果。",
  request: { query: RoutePreviewQuerySchema },
  responses: {
    200: {
      description: "已取得可直接 hydrate 到地圖的路線資料",
      content: { "application/json": { schema: RoutePreviewResponseSchema } },
    },
    400: {
      description: "缺少聯絡人位置或路線規劃失敗",
      content: { "application/json": { schema: RoutePreviewErrorSchema } },
    },
    404: {
      description: "找不到進行中的 SOS session",
      content: { "application/json": { schema: RoutePreviewErrorSchema } },
    },
  },
});
