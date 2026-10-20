import { extendZodWithOpenApi } from "@asteasolutions/zod-to-openapi";
import { z } from "zod";
import { registry } from "../../openapi/registry";
import { AccessibleRouteDataSchema } from "../accessible-route/accessible-route.schema";
import { AiRoutePlanToolResultSchema } from "../ai/ai.schema";
import { LINE_PLAN_TOKEN_PATTERN } from "./line.constants";

extendZodWithOpenApi(z);

export const RoutePreviewQuerySchema = z
  .object({
    sessionId: z
      .string()
      .regex(
        /^[0-9a-f]{32}$/,
        "sessionId 必須是 32 位元 hex 的 SOS share token",
      )
      .openapi({
        description:
          "SOS session 的 shareToken（32 位元 hex，建立 session 時產生），取自 LINE 路線預覽 URL。",
        example: "6a4e797394fbb1b1721c8b810c2d3e4f",
      })
      .optional(),
    planToken: z.string().regex(LINE_PLAN_TOKEN_PATTERN).optional().openapi({
      description:
        "一般 LINE 路線結果的 256-bit bearer capability（43 字元 base64url），有效 30 分鐘。與 sessionId 互斥，不接受規劃條件覆寫。",
      example: "A3xNm2qZ7bPk8rV1aLs0fC9dH5jW6eT4uY2iO8pQ1zA",
    }),
    travelMode: z
      .enum(["transit", "drive", "motorcycle", "walk"])
      .optional()
      .openapi({ example: "transit", description: "交通方式" }),
    mode: z
      .enum(["wheelchair", "elderly", "visual_impaired", "normal"])
      .optional()
      .openapi({ example: "normal", description: "無障礙模式" }),
    departureTime: z.string().optional().openapi({
      example: "2026-07-09T16:00:00+08:00",
      description: "出發時間",
    }),
  })
  .strict()
  .superRefine((query, ctx) => {
    if (Boolean(query.sessionId) === Boolean(query.planToken)) {
      ctx.addIssue({
        code: "custom",
        message: "必須且只能提供 sessionId 或 planToken 其中一個",
      });
    }
    if (
      query.planToken &&
      (query.travelMode !== undefined ||
        query.mode !== undefined ||
        query.departureTime !== undefined)
    ) {
      ctx.addIssue({
        code: "custom",
        message: "planToken 載入已規劃結果，不接受規劃條件覆寫",
      });
    }
  });

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
    data: z
      .union([RoutePreviewDataSchema, AiRoutePlanToolResultSchema])
      .optional(),
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
  summary: "取得 LINE 已規劃路線或 SOS 路線預覽",
  description:
    "必須且只能提供 planToken 或 sessionId。一般 planToken 為高熵 bearer capability，30 分鐘內原樣載入 LINE 同一份規劃（含 selectedRouteId、完整候選、routeToken 與 effectivePreferences），不重新規劃、不續期，不接受條件覆寫。sessionId 為 SOS shareToken：以 SOS 位置與最近分享位置的已綁定聯絡人作為起訖點，重用 accessible-route 規劃。無需登入，持有 token 即可讀取，請勿公開轉貼；回應禁止快取。",
  request: { query: RoutePreviewQuerySchema },
  responses: {
    200: {
      description: "已取得可直接 hydrate 到地圖的路線資料",
      content: { "application/json": { schema: RoutePreviewResponseSchema } },
    },
    400: {
      description: "查詢無效／同時提供兩種 token、缺少聯絡人位置或路線規劃失敗",
      content: { "application/json": { schema: RoutePreviewErrorSchema } },
    },
    404: {
      description: "一般路線 token 失效／不存在，或找不到進行中的 SOS session",
      content: { "application/json": { schema: RoutePreviewErrorSchema } },
    },
  },
});
