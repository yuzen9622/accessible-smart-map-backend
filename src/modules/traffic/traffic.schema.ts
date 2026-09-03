import { extendZodWithOpenApi } from "@asteasolutions/zod-to-openapi";
import { z } from "zod";
import {
  TDX_SUPPORTED_CITIES,
  TRAFFIC_FLOW_MAX_BBOX_DEG,
} from "../../config/traffic";
import { registry } from "../../openapi/registry";
import type { Bbox } from "../../types/traffic";

extendZodWithOpenApi(z);

export const TrafficCityEnum = z.enum(TDX_SUPPORTED_CITIES, {
  message: "不支援的城市名稱，請使用合法城市代碼",
});

const BBOX_REGEX = /^(-?\d+(\.\d+)?,){3}-?\d+(\.\d+)?$/;

export function parseBbox(raw: string): Bbox {
  const parts = raw.split(",").map(Number);
  return [parts[0], parts[1], parts[2], parts[3]];
}

function validateBboxString(raw: string, ctx: z.RefinementCtx) {
  const parts = raw.split(",").map(Number);
  const [minLng, minLat, maxLng, maxLat] = parts;
  if (
    !Number.isFinite(minLng) ||
    !Number.isFinite(minLat) ||
    !Number.isFinite(maxLng) ||
    !Number.isFinite(maxLat)
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["bbox"],
      message: "bbox 包含無效數字",
    });
    return;
  }
  if (minLng < -180 || maxLng > 180 || minLat < -90 || maxLat > 90) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["bbox"],
      message: "bbox 經緯度超出 WGS84 合法範圍（經度 -180~180，緯度 -90~90）",
    });
    return;
  }
  if (maxLng <= minLng || maxLat <= minLat) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["bbox"],
      message: "bbox 格式錯誤：max 必須大於 min（正面積）",
    });
    return;
  }
  if (
    maxLng - minLng > TRAFFIC_FLOW_MAX_BBOX_DEG ||
    maxLat - minLat > TRAFFIC_FLOW_MAX_BBOX_DEG
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["bbox"],
      message: `bbox 跨度過大，經緯跨度上限為 ${TRAFFIC_FLOW_MAX_BBOX_DEG} 度`,
    });
  }
}

export const GetTrafficFlowQuerySchema = z
  .object({
    bbox: z
      .string()
      .regex(BBOX_REGEX, "bbox 須為 minLng,minLat,maxLng,maxLat")
      .optional()
      .openapi({
        example: "121.50,25.02,121.56,25.07",
        description: "地圖可視範圍（WGS84）：minLng,minLat,maxLng,maxLat",
      }),
    city: TrafficCityEnum.optional().openapi({
      example: "Taipei",
      description: "查詢特定城市路網",
    }),
    minLevel: z.coerce.number().int().min(0).max(6).default(0).openapi({
      example: 0,
      description: "只回傳 >= 此壅塞等級（0=全部）",
    }),
  })
  .strict()
  .refine((d) => Boolean(d.bbox || d.city), {
    message: "需提供 bbox 或 city 其一",
  })
  .superRefine((data, ctx) => {
    if (data.bbox) {
      validateBboxString(data.bbox, ctx);
    }
  });

export const FlowQuerySchema = GetTrafficFlowQuerySchema;

export const GetRoadIncidentsQuerySchema = z
  .object({
    bbox: z
      .string()
      .regex(BBOX_REGEX, "bbox 須為 minLng,minLat,maxLng,maxLat")
      .optional()
      .openapi({
        example: "121.50,25.02,121.56,25.07",
        description: "地圖可視範圍（WGS84）：minLng,minLat,maxLng,maxLat",
      }),
    city: TrafficCityEnum.optional().openapi({
      example: "Taipei",
      description: "查詢特定城市即時事件",
    }),
  })
  .strict()
  .superRefine((data, ctx) => {
    if (data.bbox) {
      validateBboxString(data.bbox, ctx);
    }
  });

export const IncidentQuerySchema = GetRoadIncidentsQuerySchema;

const ApiResponseSchema = <T extends z.ZodTypeAny>(data: T) =>
  z.object({
    ok: z.boolean().openapi({ example: true }),
    status: z.enum(["success", "error"]).openapi({ example: "success" }),
    code: z.number().openapi({ example: 200 }),
    message: z.string().openapi({ example: "OK" }),
    data: data.optional(),
  });

export const TrafficFeaturePropertiesSchema = z
  .object({
    sectionId: z.string().openapi({ example: "TPE-SEC-00123" }),
    roadName: z.string().optional().openapi({ example: "市民大道三段" }),
    city: z.string().openapi({ example: "Taipei" }),
    trafficLevel: z
      .enum(["light", "moderate", "heavy", "severe", "closed", "unknown"])
      .openapi({
        example: "moderate",
        description: "語意化壅塞等級（供前端依主題/色弱模式自訂色板）",
      }),
    congestionLevel: z.number().openapi({ example: 3 }),
    congestionLabel: z.string().openapi({ example: "車多" }),
    speedKmh: z.number().optional().openapi({ example: 18 }),
    travelTimeSec: z.number().optional().openapi({ example: 240 }),
  })
  .openapi("TrafficFeatureProperties");

export const TrafficGeometrySchema = z
  .discriminatedUnion("type", [
    z.object({
      type: z.literal("LineString"),
      coordinates: z.array(z.tuple([z.number(), z.number()])),
    }),
    z.object({
      type: z.literal("MultiLineString"),
      coordinates: z.array(z.array(z.tuple([z.number(), z.number()]))),
    }),
  ])
  .openapi("TrafficGeometry");

export const TrafficFlowFeatureSchema = z
  .object({
    type: z.literal("Feature").openapi({ example: "Feature" }),
    geometry: TrafficGeometrySchema,
    properties: TrafficFeaturePropertiesSchema,
  })
  .openapi("TrafficFlowFeature");

export const TrafficFlowMetaSchema = z
  .object({
    cities: z.array(z.string()).openapi({ example: ["Taipei"] }),
    bbox: z.tuple([z.number(), z.number(), z.number(), z.number()]).openapi({
      example: [121.5, 25.02, 121.56, 25.07],
    }),
    count: z.number().openapi({ example: 42 }),
    levelCounts: z.record(z.string(), z.number()).openapi({
      example: { "1": 20, "2": 15, "3": 7 },
    }),
    liveUpdatedAt: z.string().nullable().openapi({
      example: "2026-09-03T16:00:00.000Z",
    }),
    geometryImportedAt: z.string().nullable().openapi({
      example: "2026-09-03T00:00:00.000Z",
    }),
  })
  .openapi("TrafficFlowMeta");

export const TrafficFlowCollectionSchema = z
  .object({
    type: z
      .literal("FeatureCollection")
      .openapi({ example: "FeatureCollection" }),
    features: z.array(TrafficFlowFeatureSchema),
    meta: TrafficFlowMetaSchema,
  })
  .openapi("TrafficFlowCollection");

export const RoadIncidentItemSchema = z
  .object({
    incidentId: z.string().openapi({ example: "TPE-INC-001" }),
    title: z.string().openapi({ example: "道路施工" }),
    description: z.string().optional().openapi({ example: "外側車道施工封閉" }),
    severity: z.enum(["closure", "advisory"]).openapi({ example: "advisory" }),
    roadName: z.string().optional().openapi({ example: "忠孝東路四段" }),
    location: z.object({
      lat: z.number().openapi({ example: 25.041 }),
      lng: z.number().openapi({ example: 121.567 }),
    }),
    startTime: z.string().optional(),
    endTime: z.string().optional(),
  })
  .openapi("RoadIncidentItem");

export const TrafficFlowResponseSchema = ApiResponseSchema(
  TrafficFlowCollectionSchema,
).openapi("TrafficFlowResponse");

export const RoadIncidentsResponseSchema = ApiResponseSchema(
  z.array(RoadIncidentItemSchema),
).openapi("RoadIncidentsResponse");

registry.registerPath({
  method: "get",
  path: "/traffic/flow",
  tags: ["Traffic"],
  summary: "即時車流路網",
  description:
    "依 bounding box 或城市查詢即時道路車流壅塞等級與線型（GeoJSON FeatureCollection）。",
  request: {
    query: z.object({
      bbox: z.string().optional().openapi({
        example: "121.50,25.02,121.56,25.07",
        description: "minLng,minLat,maxLng,maxLat",
      }),
      city: z
        .string()
        .optional()
        .openapi({ example: "Taipei", description: "城市名稱" }),
      minLevel: z.coerce
        .number()
        .optional()
        .openapi({ example: 0, description: "最低壅塞等級" }),
    }),
  },
  responses: {
    200: {
      description: "即時車流 FeatureCollection",
      content: { "application/json": { schema: TrafficFlowResponseSchema } },
    },
    400: { description: "參數錯誤（如 bbox 格式不符或範圍過大）" },
    500: { description: "路段線型幾何未匯入或系統錯誤" },
  },
});

registry.registerPath({
  method: "get",
  path: "/traffic/incidents",
  tags: ["Traffic"],
  summary: "即時路況事件",
  description: "依 bounding box 或城市查詢即時道路事件與施工管制資訊。",
  request: {
    query: z.object({
      bbox: z.string().optional().openapi({
        example: "121.50,25.02,121.56,25.07",
        description: "minLng,minLat,maxLng,maxLat",
      }),
      city: z
        .string()
        .optional()
        .openapi({ example: "Taipei", description: "城市名稱" }),
    }),
  },
  responses: {
    200: {
      description: "即時路況事件列表",
      content: { "application/json": { schema: RoadIncidentsResponseSchema } },
    },
    400: { description: "參數錯誤" },
    500: { description: "伺服器錯誤" },
  },
});
