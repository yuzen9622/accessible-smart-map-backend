import { extendZodWithOpenApi } from "@asteasolutions/zod-to-openapi";
import { z } from "zod";
import { registry } from "../../openapi/registry";
import { DEFAULT_LANG, SUPPORTED_LANGS } from "../../types/lang";
import { RouteFailureDataSchema } from "../accessible-route/accessible-route.schema";
import {
  VENUE_MODES,
  VenueRouteSchema,
} from "../accessible-route/venue-leg.schema";
import { VENUE_ID_RE } from "./venue.compile";

extendZodWithOpenApi(z);

const MODES = VENUE_MODES;
const LngLatSchema = z.tuple([z.number(), z.number()]);

export const VenueParamsSchema = z
  .object({
    venueId: z
      .string()
      .regex(VENUE_ID_RE)
      .openapi({ example: "nutc-sanmin", description: "場域 id" }),
  })
  .strict();

export const VenueRouteBodySchema = z
  .object({
    fromPlaceId: z.string().min(1).max(200).openapi({
      example: "info@4F",
      description:
        "起點地點 id（教室、校門或樓層錨點 `${buildingId}@${levelRef}`），取自 GET /a11y/venues/{venueId} 的 places",
    }),
    toPlaceId: z.string().min(1).max(200).openapi({
      example: "zk@3F",
      description: "終點地點 id",
    }),
    mode: z.enum(MODES).default("wheelchair").openapi({
      example: "wheelchair",
      description:
        "通行模式：wheelchair 不走樓梯；elderly / visual_impaired 偏好電梯但可走樓梯；normal 最短路線。伺服器依此解析成本設定，不接受自訂 profile。",
    }),
    language: z.enum(SUPPORTED_LANGS).default(DEFAULT_LANG).openapi({
      example: "zh-TW",
      description: "步驟文字語言",
    }),
  })
  .strict();

const LevelSchema = z.object({
  ordinal: z.number().int(),
  ref: z.string().openapi({ example: "1F" }),
  elevationM: z.number(),
});

const BuildingSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    aliases: z.array(z.string()),
    footprint: z.array(z.array(LngLatSchema)),
    levels: z.array(LevelSchema),
    floorHeightM: z.number(),
    groundOffsetM: z.number(),
    heightStatus: z.enum(["measured", "drawing", "estimated"]),
    geometryStatus: z.enum(["surveyed", "traced", "schematic"]),
    source: z.string().optional().openapi({
      description: "a11ymap:source：資料來源（照片檔名或掃描 ID）",
    }),
    osmRef: z.string(),
    moeRef: z.string().optional(),
  })
  .openapi("VenueBuilding");

const PlaceSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    ref: z.string().optional(),
    kind: z.enum([
      "room",
      "amenity",
      "parking",
      "entrance",
      "gate",
      "anchor",
      "poi",
    ]),
    buildingId: z.string().nullable(),
    levelRef: z.string().nullable(),
    nodeId: z.string(),
    location: LngLatSchema,
    wheelchair: z.enum(["yes", "no", "limited", "unknown"]).optional().openapi({
      description:
        "僅校門：輪椅可否通過。校外導進校內時，非 normal 模式只選 yes 的校門",
    }),
    accessibleSpaces: z.number().int().optional().openapi({
      description: "僅停車場：無障礙車位數（capacity:disabled）",
    }),
  })
  .openapi("VenuePlace");

const FeatureSchema = z
  .object({
    id: z.string(),
    kind: z.enum(["room", "corridor", "area", "door", "elevator", "stairs"]),
    buildingId: z.string().nullable(),
    levelRef: z.string().nullable(),
    ordinal: z.number().int().nullable(),
    name: z.string().optional(),
    ref: z.string().optional(),
    geometry: z.object({
      type: z.enum(["Polygon", "Point"]),
      coordinates: z.unknown(),
    }),
    geometryStatus: z.enum(["surveyed", "traced", "schematic"]),
    heightStatus: z.enum(["measured", "drawing", "estimated"]),
    source: z.string().optional(),
  })
  .openapi("VenueFeature");

const ConnectionSchema = z
  .object({
    id: z.string(),
    kind: z.enum(["stairs", "steps", "ramp", "escalator", "elevator"]),
    buildingId: z.string().nullable(),
    coordinates: z
      .array(z.tuple([z.number(), z.number(), z.number()]))
      .openapi({
        description:
          "[lng, lat, z]：樓梯／坡道沿線各點（兩端為樓板或標註高度，中間點可能是內插值）；電梯為每個停靠層一點",
      }),
    levelRefs: z.array(z.string().nullable()),
    wheelchair: z.enum(["yes", "no", "limited", "unknown"]),
    slopeRatio: z
      .number()
      .optional()
      .openapi({ description: "坡道最大坡度（比例）" }),
    stepCount: z.number().int().optional(),
    geometryStatus: z.enum(["surveyed", "traced", "schematic"]),
    heightStatus: z.enum(["measured", "drawing", "estimated"]).openapi({
      description:
        "高度與坡度的可信度（取最不確定者）；estimated 時前端應顯示「坡度未實測」，不顯示精確數字",
    }),
    source: z.string().optional(),
    osmRef: z.string(),
  })
  .openapi("VenueConnection");

const VenueDetailSchema = z
  .object({
    venueId: z.string(),
    name: z.string(),
    version: z.number().int(),
    importedAt: z.string(),
    center: LngLatSchema,
    buildings: z.array(BuildingSchema),
    places: z.array(PlaceSchema),
    features: z.array(FeatureSchema),
    connections: z.array(ConnectionSchema).openapi({
      description: "樓梯、戶外階梯、坡道、手扶梯與電梯，含各點高度，供 3D 繪製",
    }),
  })
  .openapi("VenueDetail");

const VenueSummarySchema = z
  .object({
    venueId: z.string(),
    name: z.string(),
    center: LngLatSchema,
    version: z.number().int(),
    importedAt: z.string(),
    buildings: z.array(z.object({ id: z.string(), name: z.string() })),
  })
  .openapi("VenueSummary");

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

const VenueListResponseSchema = ApiResponseSchema(
  z.array(VenueSummarySchema),
  "VenueListResponse",
);
const VenueDetailResponseSchema = ApiResponseSchema(
  VenueDetailSchema,
  "VenueDetailResponse",
);
const VenueRouteResponseSchema = ApiResponseSchema(
  VenueRouteSchema,
  "VenueRouteResponse",
);
const VenueRouteFailureResponseSchema = ApiResponseSchema(
  RouteFailureDataSchema,
  "VenueRouteFailureResponse",
);

registry.registerPath({
  method: "get",
  path: "/a11y/venues",
  tags: ["Venue"],
  summary: "室內場域清單",
  description: "回傳已匯入的室內場域（例如校園）摘要。",
  responses: {
    200: {
      description: "場域摘要清單",
      content: { "application/json": { schema: VenueListResponseSchema } },
    },
    500: { description: "伺服器錯誤" },
  },
});

registry.registerPath({
  method: "get",
  path: "/a11y/venues/{venueId}",
  tags: ["Venue"],
  summary: "室內場域詳細資料",
  description:
    "回傳建築外框、樓層（含樓板高度）、可選的起訖地點（教室、校門、樓層錨點）與顯示用的室內幾何（房間、走廊、門、電梯、樓梯）。牆面由用戶端依房間外框生成。",
  request: { params: VenueParamsSchema },
  responses: {
    200: {
      description: "場域資料",
      content: { "application/json": { schema: VenueDetailResponseSchema } },
    },
    404: { description: "查無此場域" },
    500: { description: "伺服器錯誤" },
  },
});

registry.registerPath({
  method: "post",
  path: "/a11y/venues/{venueId}/route",
  tags: ["Venue"],
  summary: "場域內無障礙路線",
  description:
    "規劃同一場域兩個地點之間的路線，回傳帶樓板高度的路徑與跨樓層步驟（電梯、樓梯、坡道、進出建築）。輪椅不走樓梯；長者與視障偏好電梯但可走樓梯；一般為最短路線。",
  request: {
    params: VenueParamsSchema,
    body: { content: { "application/json": { schema: VenueRouteBodySchema } } },
  },
  responses: {
    200: {
      description: "路線",
      content: { "application/json": { schema: VenueRouteResponseSchema } },
    },
    400: { description: "參數格式錯誤" },
    404: { description: "查無此場域或地點" },
    422: {
      description:
        "NO_ACCESSIBLE_ROUTE：目的地可步行到達，但沒有符合所選模式限制的路線（附 venueAccessibility）；NO_ROUTE：路網未連通",
      content: {
        "application/json": { schema: VenueRouteFailureResponseSchema },
      },
    },
    500: { description: "伺服器錯誤" },
  },
});
