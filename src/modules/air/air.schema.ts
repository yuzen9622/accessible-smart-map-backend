import { extendZodWithOpenApi } from "@asteasolutions/zod-to-openapi";
import { z } from "zod";
import { registry } from "../../openapi/registry";

extendZodWithOpenApi(z);

export const AirQualityQuerySchema = z
  .object({
    lat: z
      .string()
      .regex(/^-?\d+(\.\d+)?$/, "Must be a valid latitude")
      .openapi({ example: "25.0330" }),
    lng: z
      .string()
      .regex(/^-?\d+(\.\d+)?$/, "Must be a valid longitude")
      .openapi({ example: "121.5654" }),
  })
  .strict();

const ApiResponseSchema = <T extends z.ZodTypeAny>(data: T) =>
  z.object({
    ok: z.boolean().openapi({ example: true }),
    status: z.enum(["success", "error"]).openapi({ example: "success" }),
    code: z.number().openapi({ example: 200 }),
    message: z.string().openapi({ example: "OK" }),
    data: data.optional(),
    accessToken: z.string().optional(),
  });

export const AIResponseSchema = z
  .object({
    description: z.string().openapi({
      example: "目前空氣品質良好,適合外出活動。",
    }),
    quality: z
      .enum([
        "GOOD",
        "MODERATE",
        "UNHEALTHY_SENSITIVE",
        "UNHEALTHY",
        "VERY_UNHEALTHY",
        "HAZARDOUS",
        "",
      ])
      .openapi({ example: "GOOD" }),
  })
  .openapi("AIResponse");

export const AirQualityResponseSchema =
  ApiResponseSchema(AIResponseSchema).openapi("AirQualityResponse");

registry.registerPath({
  method: "get",
  path: "/air/air-quality",
  tags: ["Air Quality"],
  summary: "目前空氣品質",
  description:
    "依座標回傳由 Gemini 依 PM2.5 感測資料生成的空品說明，無資料時 quality 為空。",
  request: {
    query: z.object({
      lat: z
        .union([z.string(), z.number()])
        .openapi({ example: 25.0478, description: "地點緯度。" }),
      lng: z
        .union([z.string(), z.number()])
        .openapi({ example: 121.5319, description: "地點經度。" }),
    }),
  },
  responses: {
    200: {
      description: "空氣品質資料",
      content: {
        "application/json": { schema: AirQualityResponseSchema },
      },
    },
    500: { description: "伺服器錯誤" },
  },
});
