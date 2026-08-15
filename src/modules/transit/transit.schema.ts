import { extendZodWithOpenApi } from "@asteasolutions/zod-to-openapi";
import { z } from "zod";
import { registry } from "../../openapi/registry";

extendZodWithOpenApi(z);

const CityQuery = z.string().min(1).optional().openapi({
  example: "台北",
  description: "公車所在縣市（中文或英文），未提供則無法定位",
});

const DirectionQuery = z.coerce
  .number()
  .int()
  .min(0)
  .max(1)
  .optional()
  .openapi({ example: 0, description: "行駛方向（0=去程，1=返程），可省略" });

export const BusRouteQuerySchema = z
  .object({
    routeName: z.string().min(1).openapi({ example: "307" }),
    city: CityQuery,
  })
  .strict();

export const BusArrivalQuerySchema = z
  .object({
    routeName: z.string().min(1).openapi({ example: "307" }),
    stopName: z.string().min(1).openapi({ example: "台北車站" }),
    city: CityQuery,
    direction: DirectionQuery,
  })
  .strict();

export const BusTimetableQuerySchema = z
  .object({
    routeName: z.string().min(1).openapi({ example: "307" }),
    city: CityQuery,
  })
  .strict();

export const BusPositionsQuerySchema = z
  .object({
    routeName: z.string().min(1).openapi({ example: "307" }),
    city: CityQuery,
    direction: DirectionQuery,
  })
  .strict();

export const BusSearchQuerySchema = z
  .object({
    keyword: z
      .string()
      .min(1)
      .openapi({ example: "307", description: "路線名稱搜尋關鍵字" }),
  })
  .strict();

export const BusStopSearchQuerySchema = z
  .object({
    keyword: z
      .string()
      .min(1)
      .openapi({ example: "台北車站", description: "站牌名稱搜尋關鍵字" }),
  })
  .strict();

export const BusNearbyQuerySchema = z
  .object({
    lat: z
      .preprocess(
        (val) => {
          if (val === undefined || val === null || val === "") return undefined;
          const num = Number(val);
          return isNaN(num) ? undefined : num;
        },
        z
          .number({
            message: "緯度為必填且必須為有效數字",
          })
          .min(-90, "緯度必須大於或等於 -90")
          .max(90, "緯度必須小於或等於 90"),
      )
      .openapi({ example: 25.0478, description: "使用者緯度" }),
    lng: z
      .preprocess(
        (val) => {
          if (val === undefined || val === null || val === "") return undefined;
          const num = Number(val);
          return isNaN(num) ? undefined : num;
        },
        z
          .number({
            message: "經度為必填且必須為有效數字",
          })
          .min(-180, "經度必須大於或等於 -180")
          .max(180, "經度必須小於或等於 180"),
      )
      .openapi({ example: 121.5171, description: "使用者經度" }),
    radius: z.coerce
      .number()
      .int()
      .min(1)
      .max(5000)
      .default(500)
      .openapi({ example: 500, description: "搜尋半徑 (公尺，預設 500)" }),
    limit: z.coerce
      .number()
      .int()
      .min(1)
      .max(50)
      .default(10)
      .openapi({ example: 10, description: "限制筆數 (預設 10)" }),
  })
  .strict();

const BilingualNameSchema = z
  .object({
    Zh_tw: z.string().openapi({ example: "台北車站" }),
    En: z.string().openapi({ example: "Taipei Main Station" }),
  })
  .openapi("BilingualName");

const DirectionSchema = z
  .union([z.literal(0), z.literal(1)])
  .openapi({ example: 0, description: "行駛方向（0 = 去程，1 = 返程）" });

export const EstimatedTimeOfArrivalSchema = z
  .object({
    StopUID: z.string().openapi({ example: "TPE16523" }),
    StopName: BilingualNameSchema,
    Direction: DirectionSchema,
    EstimateTime: z
      .number()
      .nullable()
      .openapi({ example: 180, description: "預估到站秒數，無資料時為 null" }),
    StopStatus: z.number().openapi({ example: 0 }),
    MessageType: z.number().optional().openapi({ example: 1 }),
    PlateNumb: z.string().optional().openapi({ example: "KKA-1234" }),
    RouteName: BilingualNameSchema.optional(),
    SubRouteName: BilingualNameSchema.optional(),
  })
  .passthrough()
  .openapi("EstimatedTimeOfArrival");

export const RealTimeByFrequencySchema = z
  .object({
    PlateNumb: z.string().openapi({ example: "KKA-1234" }),
    OperatorNo: z.string().openapi({ example: "10081" }),
    Direction: DirectionSchema,
    BusPosition: z
      .object({
        PositionLon: z.number().openapi({ example: 121.5171 }),
        PositionLat: z.number().openapi({ example: 25.0478 }),
      })
      .openapi("BusPosition"),
    Speed: z.number().optional().openapi({ example: 32.5 }),
    GPSTime: z
      .string()
      .optional()
      .openapi({ example: "2026-06-03T08:15:30+08:00" }),
    UpdateTime: z
      .string()
      .optional()
      .openapi({ example: "2026-06-03T08:15:35+08:00" }),
    RouteName: BilingualNameSchema.optional(),
  })
  .passthrough()
  .openapi("RealTimeByFrequency");

const ApiResponseSchema = <T extends z.ZodTypeAny>(data: T) =>
  z.object({
    ok: z.boolean().openapi({ example: true }),
    status: z.enum(["success", "error"]).openapi({ example: "success" }),
    code: z.number().openapi({ example: 200 }),
    message: z.string().openapi({ example: "OK" }),
    data: data.optional(),
    accessToken: z.string().optional(),
  });

const BusServiceResponseSchema = ApiResponseSchema(
  z.object({ ok: z.boolean() }).passthrough(),
).openapi("BusServiceResponse");

export const BusSearchResultSchema = z
  .object({
    routeName: z.string().openapi({ example: "307", description: "路線名稱" }),
    city: z
      .string()
      .openapi({ example: "Taipei", description: "路線所屬縣市英文名" }),
    departure: z
      .string()
      .openapi({ example: "撫順街口", description: "去程起點站" }),
    destination: z
      .string()
      .openapi({ example: "板橋國中", description: "去程終點站" }),
  })
  .openapi("BusSearchResult");

export const BusSearchResponseSchema = ApiResponseSchema(
  z.object({
    routes: z.array(BusSearchResultSchema),
  }),
).openapi("BusSearchResponse");

export const BusStopSearchResultSchema = z
  .object({
    stopUid: z
      .string()
      .openapi({ example: "TPE16523", description: "站牌唯一識別碼" }),
    stopName: z
      .string()
      .openapi({ example: "台北車站", description: "站牌名稱" }),
    city: z
      .string()
      .openapi({ example: "Taipei", description: "站牌所屬縣市英文名" }),
    coordinates: z.tuple([z.number(), z.number()]).openapi({
      example: [121.5171, 25.0478],
      description: "站牌經緯度座標 [lng, lat]",
    }),
    routes: z.array(z.string()).openapi({
      example: ["307", "652"],
      description: "停靠該站牌的公車路線清單",
    }),
  })
  .openapi("BusStopSearchResult");

export const BusStopSearchResponseSchema = ApiResponseSchema(
  z.object({
    stops: z.array(BusStopSearchResultSchema),
  }),
).openapi("BusStopSearchResponse");

export const BusNearbyStopSchema = z
  .object({
    stopUid: z
      .string()
      .openapi({ example: "TPE16523", description: "站牌唯一識別碼" }),
    stopName: z
      .string()
      .openapi({ example: "台北車站", description: "站牌名稱" }),
    city: z
      .string()
      .openapi({ example: "Taipei", description: "站牌所屬縣市英文名" }),
    coordinates: z.tuple([z.number(), z.number()]).openapi({
      example: [121.5171, 25.0478],
      description: "站牌經緯度座標 [lng, lat]",
    }),
    distance: z
      .number()
      .openapi({ example: 120, description: "與使用者的距離 (公尺)" }),
    routes: z.array(z.string()).openapi({
      example: ["307", "652"],
      description: "停靠該站牌的公車路線清單",
    }),
  })
  .openapi("BusNearbyStop");

export const BusNearbyResponseSchema = ApiResponseSchema(
  z.object({
    stops: z.array(BusNearbyStopSchema),
  }),
).openapi("BusNearbyResponse");

const AlertDirectionQuery = z.coerce.number().optional();
const CommaSeparatedStationIdsQuery = z.string().transform((value) =>
  value
    .split(",")
    .map((stationId) => stationId.trim())
    .filter(Boolean),
);

export const AlertQuerySchema = z.discriminatedUnion("mode", [
  z
    .object({
      mode: z.literal("bus"),
      city: z.string().min(1),
      routeName: z.string().min(1),
      direction: AlertDirectionQuery,
      stopUid: z.string().min(1).optional(),
      stopName: z.string().min(1).optional(),
    })
    .strict(),
  z
    .object({
      mode: z.literal("metro"),
      railSystem: z.enum(["TRTC", "KRTC", "TYMC", "TMRT", "KLRT", "TRTCMG"]),
      lineCode: z.string().min(1).optional(),
      stationIds: CommaSeparatedStationIdsQuery.optional(),
    })
    .strict(),
  z
    .object({
      mode: z.literal("tra"),
      trainNo: z.string().min(1).optional(),
      lineId: z.string().min(1).optional(),
      stationIds: CommaSeparatedStationIdsQuery.optional(),
      direction: AlertDirectionQuery,
    })
    .strict(),
  z
    .object({
      mode: z.literal("thsr"),
      lineId: z.string().min(1).optional(),
      direction: AlertDirectionQuery,
      fromStationId: z.string().min(1).optional(),
      toStationId: z.string().min(1).optional(),
    })
    .strict(),
]);

const AlertQueryDocSchema = z
  .object({
    mode: z
      .enum(["bus", "metro", "tra", "thsr"])
      .openapi({
        example: "bus",
        description: "運具模式：bus=公車、metro=捷運、tra=臺鐵、thsr=高鐵",
      }),
    city: z
      .string()
      .min(1)
      .optional()
      .openapi({ example: "Taipei", description: "公車縣市（mode=bus 必填）" }),
    routeName: z
      .string()
      .min(1)
      .optional()
      .openapi({ example: "307", description: "公車路線（mode=bus 必填）" }),
    direction: z.coerce
      .number()
      .int()
      .optional()
      .openapi({ example: 0, description: "行駛方向（bus/tra/thsr 可選）" }),
    stopUid: z.string().min(1).optional().openapi({ description: "站牌 UID" }),
    stopName: z
      .string()
      .min(1)
      .optional()
      .openapi({ example: "台北車站", description: "站牌名稱" }),
    railSystem: z
      .enum(["TRTC", "KRTC", "TYMC", "TMRT", "KLRT", "TRTCMG"])
      .optional()
      .openapi({ example: "TRTC", description: "捷運系統（mode=metro 必填）" }),
    lineCode: z
      .string()
      .min(1)
      .optional()
      .openapi({ example: "R", description: "捷運路線代碼" }),
    stationIds: z
      .string()
      .optional()
      .openapi({ example: "R10,R16", description: "逗號分隔的車站代碼" }),
    trainNo: z
      .string()
      .min(1)
      .optional()
      .openapi({ example: "123", description: "臺鐵車次" }),
    lineId: z.string().min(1).optional(),
    fromStationId: z
      .string()
      .min(1)
      .optional()
      .openapi({ description: "高鐵起站代碼" }),
    toStationId: z
      .string()
      .min(1)
      .optional()
      .openapi({ description: "高鐵迄站代碼" }),
  })
  .strict();

const MatchedAlertSchema = z
  .object({
    alertId: z
      .string()
      .openapi({ example: "34265", description: "通阻事件代碼" }),
    title: z.string().openapi({ example: "8月27日城隍祭改道" }),
    description: z.string().openapi({ description: "事件描述" }),
    status: z
      .union([z.number(), z.string()])
      .openapi({ description: "0/1/2（公車/臺鐵/捷運）或 ''/▲/X（高鐵）" }),
    cause: z.union([z.number(), z.string()]).optional(),
    effect: z.union([z.number(), z.string()]).optional(),
    level: z.union([z.number(), z.string()]).optional(),
    reason: z.string().optional(),
    matchKind: z
      .enum(["route", "stop", "station", "line", "train", "section"])
      .openapi({
        description: "匹配精度（train/stop/station 最精準，section 最寬）",
      }),
    startTime: z.string().nullable().optional(),
    endTime: z.string().nullable().optional(),
    alertUrl: z.string().optional(),
  })
  .openapi("MatchedAlert");

const AlertResponseSchema = ApiResponseSchema(
  z.object({
    mode: z.enum(["bus", "metro", "tra", "thsr"]),
    matchedAt: z.string().openapi({ example: "2026-08-15T10:42:42+08:00" }),
    alerts: z.array(MatchedAlertSchema),
  }),
).openapi("AlertResponse");

registry.registerPath({
  method: "get",
  path: "/transit/alerts",
  tags: ["Transit"],
  summary: "營運通阻（即時）",
  description:
    "依使用者搭乘的運具精準匹配 TDX 營運通阻資料：公車以路線、捷運以線/站、臺鐵以車次、高鐵以區間+方向。資料由 TDX MQTT 即時餵養，REST 兜底。",
  request: { query: AlertQueryDocSchema },
  responses: {
    200: {
      description: "匹配到的通阻訊息",
      content: { "application/json": { schema: AlertResponseSchema } },
    },
    400: { description: "mode 或參數錯誤" },
    500: { description: "TDX/DB 錯誤" },
  },
});

registry.registerPath({
  method: "get",
  path: "/transit/bus/route",
  tags: ["Transit"],
  summary: "公車路線站序",
  description:
    "回傳指定路線去/返程的起訖站與完整停靠站列表（優先讀已匯入資料，未匯入則即時查 TDX）。",
  request: { query: BusRouteQuerySchema },
  responses: {
    200: {
      description: "路線站序",
      content: { "application/json": { schema: BusServiceResponseSchema } },
    },
    400: { description: "缺少縣市或參數" },
    404: { description: "找不到路線" },
    500: { description: "TDX/DB 錯誤" },
  },
});

registry.registerPath({
  method: "get",
  path: "/transit/bus/route-detail",
  tags: ["Transit"],
  summary: "公車路線詳細資訊",
  description:
    "回傳指定路線的所有站點列表、每個站點的預估到站時間（ETA）以及當前時刻表。",
  request: { query: BusRouteQuerySchema },
  responses: {
    200: {
      description: "路線詳細資訊",
      content: { "application/json": { schema: BusServiceResponseSchema } },
    },
    400: { description: "缺少縣市或參數" },
    404: { description: "找不到路線" },
    500: { description: "TDX/DB 錯誤" },
  },
});

registry.registerPath({
  method: "get",
  path: "/transit/bus/arrival",
  tags: ["Transit"],
  summary: "公車到站時間",
  description:
    "回傳指定路線在某站牌的即時預估到站分鐘數；若該班車車牌已知，附帶是否低底盤。",
  request: { query: BusArrivalQuerySchema },
  responses: {
    200: {
      description: "到站預估",
      content: { "application/json": { schema: BusServiceResponseSchema } },
    },
    400: { description: "缺少縣市或參數" },
    404: { description: "找不到到站資料" },
    500: { description: "TDX 錯誤" },
  },
});

registry.registerPath({
  method: "get",
  path: "/transit/bus/timetable",
  tags: ["Transit"],
  summary: "公車時刻表",
  description: "回傳指定路線的首末班車時間與今日班次發車時刻。",
  request: { query: BusTimetableQuerySchema },
  responses: {
    200: {
      description: "時刻表",
      content: { "application/json": { schema: BusServiceResponseSchema } },
    },
    400: { description: "缺少縣市或參數" },
    404: { description: "找不到時刻表" },
    500: { description: "TDX 錯誤" },
  },
});

registry.registerPath({
  method: "get",
  path: "/transit/bus/positions",
  tags: ["Transit"],
  summary: "公車即時位置（含低底盤）",
  description:
    "回傳指定路線目前所有在線車輛的即時位置與行駛狀態，並標註每台車是否為低底盤／有無升降斜坡板。無需提供車牌。",
  request: { query: BusPositionsQuerySchema },
  responses: {
    200: {
      description: "在線車輛清單",
      content: { "application/json": { schema: BusServiceResponseSchema } },
    },
    400: { description: "缺少縣市或參數" },
    404: { description: "目前無營運車輛" },
    500: { description: "TDX 錯誤" },
  },
});

registry.registerPath({
  method: "get",
  path: "/transit/bus/search-routes",
  tags: ["Transit"],
  summary: "搜尋公車路線",
  description:
    "依關鍵字模糊搜尋所有縣市的公車路線，回傳匹配的路線、縣市及去程起迄站，供前端做下拉選擇。",
  request: { query: BusSearchQuerySchema },
  responses: {
    200: {
      description: "搜尋結果列表",
      content: { "application/json": { schema: BusSearchResponseSchema } },
    },
    400: { description: "缺少必要參數" },
    500: { description: "DB 錯誤" },
  },
});

registry.registerPath({
  method: "get",
  path: "/transit/bus/search-stops",
  tags: ["Transit"],
  summary: "搜尋公車站牌",
  description:
    "依關鍵字模糊搜尋所有縣市的公車站牌，回傳匹配的站牌、所屬縣市、座標及行經該站的路線清單，供前端做下拉選擇。同名站牌會依縣市區分；最多回傳 50 筆。",
  request: { query: BusStopSearchQuerySchema },
  responses: {
    200: {
      description: "搜尋結果列表",
      content: { "application/json": { schema: BusStopSearchResponseSchema } },
    },
    400: { description: "缺少必要參數" },
    500: { description: "DB 錯誤" },
  },
});

registry.registerPath({
  method: "get",
  path: "/transit/bus/nearby-stops",
  tags: ["Transit"],
  summary: "自動抓離使用者最近的站牌",
  description:
    "依使用者經緯度搜尋最近的公車站牌列表，依距離排序，並回傳行經各站牌的公車路線清單。",
  request: { query: BusNearbyQuerySchema },
  responses: {
    200: {
      description: "附近站牌列表",
      content: { "application/json": { schema: BusNearbyResponseSchema } },
    },
    400: { description: "缺少必要參數或參數無效" },
    500: { description: "DB 錯誤" },
  },
});
