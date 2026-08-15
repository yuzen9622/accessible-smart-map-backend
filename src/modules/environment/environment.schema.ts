import { extendZodWithOpenApi } from "@asteasolutions/zod-to-openapi";
import { z } from "zod";
import { registry } from "../../openapi/registry";

extendZodWithOpenApi(z);

export const EnvironmentQuerySchema = z.object({
  lat: z.coerce.number().min(-90).max(90),
  lng: z.coerce.number().min(-180).max(180),
  radius: z.coerce.number().int().min(100).max(2000).default(500),
});

const StatusEnum = z.enum(["ok", "unavailable"]);

const WeatherBlockSchema = z.object({
  status: StatusEnum,
  temperature: z.number().optional(),
  precipitationProbability: z.number().optional(),
  windSpeed: z.number().optional(),
  windDirection: z.string().optional(),
  condition: z.string().optional(),
  forecastTime: z.string().optional(),
  reason: z.string().optional(),
});

const AirQualityBlockSchema = z.object({
  status: StatusEnum,
  pm25: z.number().optional(),
  quality: z.string().optional(),
  advice: z.string().optional(),
  area: z.string().nullable().optional(),
  stationCoordinates: z.tuple([z.number(), z.number()]).nullable().optional(),
  reason: z.string().optional(),
});

const CctvCameraSchema = z.object({
  id: z.string(),
  name: z.string(),
  location: z.object({ lat: z.number(), lng: z.number() }),
  distanceM: z.number(),
  snapshotUrl: z.string().nullable(),
  streamUrl: z.string().nullable(),
});

const CctvBlockSchema = z.object({
  status: StatusEnum,
  cameras: z.array(CctvCameraSchema).optional(),
  reason: z.string().optional(),
});

const EnvironmentDataSchema = z
  .object({
    location: z.object({ lat: z.number(), lng: z.number() }),
    weather: WeatherBlockSchema,
    airQuality: AirQualityBlockSchema,
    nearbyCctv: CctvBlockSchema,
  })
  .openapi("EnvironmentData");

const EnvironmentResponseSchema = z
  .object({
    ok: z.boolean().openapi({ example: true }),
    status: z.enum(["success", "error"]).openapi({ example: "success" }),
    code: z.number().openapi({ example: 200 }),
    message: z.string().openapi({ example: "環境資訊查詢成功" }),
    data: EnvironmentDataSchema.optional(),
  })
  .openapi("EnvironmentResponse");

registry.registerPath({
  method: "get",
  path: "/a11y/environment",
  tags: ["Environment"],
  summary: "出發前環境資訊查詢",
  description:
    "依座標一次聚合天氣（CWA）、空氣品質（STA PM2.5）與鄰近監視器（twipcam），各來源獨立降級。",
  request: {
    query: z.object({
      lat: z
        .union([z.string(), z.number()])
        .openapi({ example: 25.0478, description: "目標地點緯度。" }),
      lng: z
        .union([z.string(), z.number()])
        .openapi({ example: 121.5318, description: "目標地點經度。" }),
      radius: z.union([z.string(), z.number()]).optional().openapi({
        example: 500,
        description: "監視器搜尋半徑（公尺），100–2000，預設 500。",
      }),
    }),
  },
  responses: {
    200: {
      description: "聚合環境資訊（含部分降級）",
      content: {
        "application/json": { schema: EnvironmentResponseSchema },
      },
    },
    400: { description: "參數驗證失敗" },
    500: { description: "伺服器錯誤" },
  },
});
