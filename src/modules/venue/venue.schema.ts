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
        "通行模式：wheelchair 先完整搜尋無階梯路徑，確認不可達才提供 stairsFallback=true、含明確警告的階梯備援；不是輪椅可自行通行的保證。elderly / visual_impaired 維持原本避開樓梯及手扶梯限制；normal 可走樓梯。各模式仍保留已知封閉、門寬等其他限制，不接受自訂 profile。",
    }),
    language: z.enum(SUPPORTED_LANGS).default(DEFAULT_LANG).openapi({
      example: "zh-TW",
      description: "步驟文字語言",
    }),
  })
  .strict();

const ProvenanceAnnotations = {
  heightPending: z.boolean().optional().openapi({
    description:
      "高度仍待核實；不代表電梯停靠樓層或連通性已現場確認，須同時保留 note / fixme 的限制說明",
  }),
  note: z.string().optional().openapi({
    description: "來源的補充註記，保留高度、停靠層與連通性等原始限制語意",
  }),
  fixme: z
    .string()
    .optional()
    .openapi({ description: "來源仍待補齊或現場核實的事項" }),
};

const LevelCoverageSchema = z
  .object({
    hasAnchor: z
      .boolean()
      .openapi({ description: "此棟此層有實際樓層錨點（places.kind=anchor）" }),
    hasRouteData: z.boolean().openapi({
      description:
        "此棟此層節點有相接路網邊；僅表示有路網資料，不保證可達或輪椅可通行",
    }),
    hasDisplayGeometry: z.boolean().openapi({
      description:
        "此棟此層有實際房間、走廊、門等顯示幾何；建築外框與宣告樓層數不算",
    }),
  })
  .openapi("VenueLevelCoverage");

const LevelSchema = z.object({
  ordinal: z.number().int(),
  ref: z.string().openapi({ example: "1F" }),
  elevationM: z.number(),
  coverage: LevelCoverageSchema,
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
    ...ProvenanceAnnotations,
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
    arrivalNodeIds: z.array(z.string()).min(1).max(16).optional().openapi({
      uniqueItems: true,
      description:
        "同一建築、樓層已由來源確認的真實到達節點；最多 16 個、不重複且包含 nodeId。省略時只用 nodeId；後端按通行模式從起終點候選配對選最低成本路線，路徑首尾為實選節點，place ID 不變",
    }),
    location: LngLatSchema,
    featureId: z.string().nullable().optional().openapi({
      description:
        "相同建築與樓層下，由來源拓樸、唯一房號、明確 a11ymap:arrival_node 或唯一垂直設施落點識別的顯示圖形；無法確定時為 null，不依名稱或最近距離猜測",
    }),
    arrivalKind: z
      .enum(["door", "corridor", "place"])
      .nullable()
      .optional()
      .openapi({
        description:
          "實際導航到達點語意；corridor 是走廊到達點，不代表已確認房門位置",
      }),
    doorKnown: z.boolean().nullable().optional().openapi({
      description:
        "此導航點是否有明確來源門位標記；走廊點為 false，並非宣稱附近沒有門；未知為 null 或省略，不能由 kind=room 推定",
    }),
    connectionId: z.string().nullable().optional(),
    connectionIds: z.array(z.string()).optional().openapi({
      description:
        "與此地點任一真實到達節點相接的 connection IDs；多筆時 connectionId 為 null，不代表所有模式皆可使用每個設施",
    }),
    wheelchair: z.enum(["yes", "no", "limited", "unknown"]).optional().openapi({
      description:
        "校門：輪椅可否通過，校外導進校內時，非 normal 模式只選 yes 的校門。廁所：來源有標 wheelchair 時才回傳，yes 表示有無障礙廁間；未標則省略",
    }),
    accessibleSpaces: z.number().int().optional().openapi({
      description: "僅停車場：無障礙車位數（capacity:disabled）",
    }),
  })
  .openapi("VenuePlace");

const FeatureTagsSchema = z
  .object({
    indoor: z.string().optional(),
    amenity: z.string().optional(),
    "a11ymap:area_type": z.string().optional(),
    ref: z.string().optional(),
    wheelchair: z.enum(["yes", "no", "limited", "unknown"]).optional().openapi({
      description: "僅 amenity=toilets：來源 wheelchair 標籤；未標則省略",
    }),
  })
  .strict()
  .openapi("VenueFeatureTags", {
    description:
      "來源分類標籤白名單；toilets / vertical-core / elevator-shaft / stairwell 依來源保留，不由名稱推定，也不保證井道在該層停靠",
  });

const FeatureSchema = z
  .object({
    id: z.string(),
    kind: z.enum(["room", "corridor", "area", "door", "elevator", "stairs"]),
    osmRef: z.string().optional(),
    tags: FeatureTagsSchema.optional(),
    connectionId: z.string().nullable().optional(),
    connectionIds: z.array(z.string()).optional().openapi({
      description:
        "依來源節點或同棟設施幾何包含關係識別的 connections；未知或歧義為空，不依名稱或最近距離猜測；井道關聯不新增停靠層",
    }),
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
    ...ProvenanceAnnotations,
  })
  .openapi("VenueFeature");

const ConnectionSchema = z
  .object({
    id: z.string(),
    kind: z.enum(["stairs", "steps", "ramp", "escalator", "elevator"]),
    name: z
      .string()
      .nullable()
      .optional()
      .openapi({ description: "來源設施名稱；未知為 null" }),
    ref: z
      .string()
      .nullable()
      .optional()
      .openapi({ description: "來源設施編號；未知為 null" }),
    nodeIds: z.array(z.string()).optional().openapi({
      description:
        "compiled source node IDs，與 coordinates / levelRefs 同長同序；電梯僅列實際停靠點，不用座標字串產生 ID",
    }),
    featureIds: z.array(z.string()).optional().openapi({
      description: "來源顯示圖形的反向關聯；不代表井道出現的每層都可搭乘",
    }),
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
    ...ProvenanceAnnotations,
    osmRef: z.string(),
  })
  .openapi("VenueConnection");

const WalkwaySchema = z
  .object({
    id: z
      .string()
      .openapi({ description: "穩定的路網邊 id，每筆為一條邊的兩端點" }),
    kind: z.enum([
      "corridor",
      "footway",
      "path",
      "pedestrian",
      "service",
      "crossing",
    ]),
    indoor: z.boolean(),
    nodeIds: z.tuple([z.string(), z.string()]).optional().openapi({
      description:
        "實際路網邊兩端 compiled source node IDs，順序對應 coordinates；供顯示入口側拓樸，不能推定門寬或替代 route API",
    }),
    coordinates: z
      .tuple([
        z.tuple([z.number(), z.number(), z.number()]),
        z.tuple([z.number(), z.number(), z.number()]),
      ])
      .openapi({
        description:
          "兩端點 [lng, lat, z]；z 為場域基準面以上公尺，非手機定位樓層",
      }),
    buildingId: z
      .string()
      .nullable()
      .openapi({ description: "兩端同棟時為該棟 id，戶外或跨棟邊為 null" }),
    levelRef: z.string().nullable().openapi({
      description: "兩端同棟同層時為該層，否則 null；跨界請依 levelRefs",
    }),
    buildingIds: z
      .tuple([z.string().nullable(), z.string().nullable()])
      .openapi({
        description: "各端點所屬建築，順序對應 coordinates；戶外為 null",
      }),
    levelRefs: z.tuple([z.string().nullable(), z.string().nullable()]).openapi({
      description: "各端點樓層，順序對應 coordinates；戶外或中間高度為 null",
    }),
    wheelchair: z.enum(["yes", "no", "limited", "unknown"]),
    geometryStatus: z.enum(["surveyed", "traced", "schematic"]),
    heightStatus: z.enum(["measured", "drawing", "estimated"]),
    source: z.string().optional(),
    ...ProvenanceAnnotations,
    osmRef: z.string(),
  })
  .openapi("VenueWalkway");

const WallSchema = z
  .object({
    id: z.string(),
    osmRef: z.string(),
    buildingId: z.string().nullable(),
    ordinal: z.number().int().nullable(),
    levelRef: z.string().nullable(),
    geometry: z.object({
      type: z.literal("LineString"),
      coordinates: z.array(LngLatSchema).min(2),
    }),
    geometryStatus: z.enum(["surveyed", "traced", "schematic"]),
    heightStatus: z.enum(["measured", "drawing", "estimated"]),
    thicknessM: z.number().positive().nullable().optional().openapi({
      description:
        "來源明確標註的牆厚（公尺）；未知為 null，前端示意厚度不能視為實測值",
    }),
    source: z.string().optional(),
    ...ProvenanceAnnotations,
  })
  .openapi("VenueWall");

const VenueDetailSchema = z
  .object({
    venueId: z.string(),
    name: z.string(),
    version: z.number().int(),
    importedAt: z.string(),
    center: LngLatSchema,
    sourceSha256: z.string().nullable().openapi({
      description:
        "本次匯入原始檔的 SHA-256；舊文件無來源雜湊時為 null。此值不包含發布建築範圍，快取仍須使用 venueId + version",
    }),
    buildings: z.array(BuildingSchema),
    places: z.array(PlaceSchema),
    features: z.array(FeatureSchema),
    walls: z.array(WallSchema).openapi({
      description:
        "來源 indoor=wall 的牆線，依原始頂點順序保留，不猜測開口或門寬；舊資料未匯入牆線時為空陣列",
    }),
    walkways: z.array(WalkwaySchema).openapi({
      description:
        "一般平走路網，包含戶外步道、室內走廊與跨棟連通邊；樓梯、坡道、手扶梯與電梯另在 connections，避免重複繪製",
    }),
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
    "回傳已發布建築外框、樓層高度與資料涵蓋度、可選起訖地點（教室、校門、樓層錨點）、室內顯示幾何、一般步道與垂直連通設施。包含來源雜湊與待核實註記。來源牆線另在 walls，房間共牆可由用戶端依原始外框處理；有樓層宣告不代表該層已有完整圖資。",
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
    "規劃同一場域的樓層感知路徑與步驟。輪椅先完整搜尋無階梯路；確實不可達才提供含警告的階梯備援，stairsFallback=true 不代表輪椅可自行通過。一般步行可走樓梯；長者／視障仍保留原有限制。封閉、禁止通行、已知門寬及其他非階梯限制不會因備援而放寬。搜尋預算耗盡回503，不會被當作無階梯路不存在。",
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
        "NO_ACCESSIBLE_ROUTE：目的地可步行到達，但仍受非階梯通行限制阻擋（附 venueAccessibility）；NO_ROUTE：路網未連通，包含已知禁止通行後無替代路徑",
      content: {
        "application/json": { schema: VenueRouteFailureResponseSchema },
      },
    },
    503: {
      description:
        "搜尋預算耗盡或路由暫時不可用；不是確認不可達，不會因此啟用階梯備援",
      content: {
        "application/json": { schema: VenueRouteFailureResponseSchema },
      },
    },
    500: { description: "伺服器錯誤" },
  },
});
