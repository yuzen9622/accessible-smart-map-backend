import { extendZodWithOpenApi } from "@asteasolutions/zod-to-openapi";
import { z } from "zod";
import { registry } from "../../openapi/registry";
import {
  ROUTE_MSG,
  ROUTE_REASON,
  ROUTE_WARNING,
} from "../../constants/messages";
import { RouteIntentSchema } from "../../schemas/route-intent.schema";
import {
  WALK_ABSOLUTE_DIRECTION_VALUES,
  WALK_RELATIVE_DIRECTION_VALUES,
} from "../../utils/nav-instructions-engine";

extendZodWithOpenApi(z);

const CoordSchema = z
  .object({
    lat: z.number().openapi({ description: "緯度" }),
    lng: z.number().openapi({ description: "經度" }),
  })
  .strict();

const PointSchema = z.union([
  z.string().openapi({ description: "待地理編碼的地點名稱" }),
  z
    .object({
      latitude: z.number(),
      longitude: z.number(),
    })
    .strict()
    .openapi({ description: "明確的經緯度座標" }),
]);

export const AccessibleRouteBodySchema = z
  .object({
    origin: PointSchema.optional().openapi({
      description: "起點 — 地點名稱或 {latitude, longitude}",
    }),
    destination: PointSchema.optional().openapi({
      description: "終點 — 地點名稱或 {latitude, longitude}",
    }),
    query: z
      .preprocess(
        (v) => (typeof v === "string" && v.trim() === "" ? undefined : v),
        z.string().min(1).optional(),
      )
      .openapi({
        description:
          "自然語言查詢（如「我坐輪椅要從台中車站到高鐵新竹站」）。提供且省略起訖點時，會經 /ai/intent 解析出起點、終點與模式；current_location 對應 userLocation。",
        example: "我坐輪椅要從台中車站到高鐵新竹站",
      }),
    userLocation: z
      .object({ latitude: z.number(), longitude: z.number() })
      .optional()
      .openapi({
        description: "使用者座標，用於解析 query 中的 current_location 起點。",
      }),
    mode: z
      .enum(["wheelchair", "elderly", "visual_impaired", "normal"])
      .optional()
      .openapi({
        description:
          "無障礙模式。調整評分權重（elderly 提升 Tier 1+2；visual_impaired 將導盲磚／語音號誌列為關鍵）、轉乘懲罰（wheelchair ×2、elderly ×1.5）與輪椅 Tier-1 路線排除。未填時沿用 query 解析結果；若仍未定且帶有效 Bearer token，改用登入者已儲存的無障礙偏好（GET /user/a11y-profile）推導；最後退回 normal。",
        example: "wheelchair",
      }),
    avoidStairs: z.boolean().optional().openapi({
      description:
        "硬性條件：要求無階梯路徑。true 時向路徑引擎索取 step-free 路線，並排除經過純樓梯障礙（highway=steps 且無輪椅坡道）的步行段。未填時：若帶有效 token 且已儲存的偏好有明確設定 canUseStairs，則據此推導（不能上下階梯→true，能上下階梯→false）；否則預設為 mode==='wheelchair'，故舊有請求行為不變。",
      example: true,
    }),
    requireElevator: z.boolean().optional().openapi({
      description:
        "硬性條件：要求車站有可用電梯。true 時排除「有設施資料但查無電梯」或「電梯維修／故障／暫停」的捷運／台鐵／高鐵路段；設施資料為空的車站視為未知而保留。未填時：若帶有效 token 且已儲存的偏好有明確設定 needsElevator，則直接套用該值；否則預設為 mode==='wheelchair'。當所有候選路線都被排除時仍會回傳原候選（有路線優於 404），並以較低的無障礙分數與 warnings 標示風險。",
      example: true,
    }),
    needsAccessibleToilet: z.boolean().optional().openapi({
      description:
        "軟性偏好：若為 true，會檢查目的地附近是否有登記的無障礙廁所，有則加進 accessibilityHighlights，查無資料則加進 warnings（不代表確定沒有，只是資料庫沒登記）。未填時：若帶有效 token 且已儲存的偏好要求，則預設 true。不影響路線本身的選路。",
      example: true,
    }),
    needsHandrail: z.boolean().optional().openapi({
      description:
        "軟性偏好：若為 true，路線中若有樓梯段且 OSM 資料未標記該樓梯有扶手（handrail=yes），會在 warnings 提示「需自行確認扶手」。OSM 扶手標記涵蓋率低，多數樓梯會落入此提示。未填時：若帶有效 token 且已儲存的偏好要求，則預設 true。不影響路線本身的選路。",
      example: false,
    }),
    maxSlopePercent: z.number().min(0).max(100).optional().openapi({
      description:
        "偏好的最大坡度百分比。⚠️ 目前無法保證這個任意值是硬性篩選：台北 bbox 內且啟用的純步行 CSR 會回傳選定邊的觀測坡度，但不依本欄位篩選，因此 data.slopeConstraint.enforced 會是 false；大眾運輸與台北範圍外／停用 CSR 的純步行由 OTP2 規劃，僅輪椅模式可使用伺服器固定 8.3% 上限；開車／騎車（Valhalla）沒有地形高程資料。未填時：若帶有效 token 且已儲存的偏好設定，則套用該值。",
      example: 5,
    }),
    maxTransfers: z.number().int().min(0).max(2).optional().openapi({
      description:
        "最大轉乘次數（0–2），預設 1；少於 3 條較簡單路線時才啟動兩次轉乘搜尋。",
      example: 1,
    }),
    departureTime: z.string().optional().openapi({
      description:
        "ISO 8601 出發時間，預設為現在；GTFS 路徑會採用，過去或無效時間視為現在。",
      example: "2026-06-10T08:30:00+08:00",
    }),
    format: z.enum(["standard", "compact"]).optional().openapi({
      description:
        "回應格式。standard（預設）每段內嵌精簡設施物件；compact 另將設施去重為路線層級 facilities 字典，各段改帶 a11yRefs（osmId 參照）且設施陣列為空。",
      example: "standard",
    }),
    travelMode: z
      .enum(["transit", "drive", "motorcycle", "walk"])
      .default("transit")
      .openapi({
        description:
          "交通工具（與無障礙 mode 正交）：transit（預設，大眾運輸及其 WALK legs 均走 OTP2）、drive（開車）、motorcycle（騎車）、walk（純步行）。純步行在台北 CSR bbox 內且功能啟用時優先走 CSR；bbox 外或功能停用時 OTP2 為 primary，CSR 在範圍內無法選路時改以 warnings 標記 OTP2 fallback。僅當 OTP2 不可用才由 Valhalla 作停機備援。車行時間為自由流估計，不含即時路況。",
        example: "drive",
      }),
    waypoints: z
      .array(PointSchema)
      .max(5)
      .optional()
      .openapi({
        description:
          "依序經過的中途點（新增目的地），最多 5 個；字串會被地理編碼。適用所有交通工具（大眾運輸以分段串接規劃）。",
        example: ["中正紀念堂"],
      }),
  })
  .strict()
  .refine((b) => (b.origin && b.destination) || b.query, {
    message: "請提供 origin+destination，或自然語言 query",
  });

const OsmA11ySchema = z
  .object({
    osmId: z.string().openapi({ example: "node/123456789" }),
    name: z.string().optional().openapi({ example: "市政府站 2 號出口電梯" }),
    category: z
      .enum(["wheelchair_accessible", "kerb_cut", "ramp", "elevator", "toilet"])
      .openapi({ example: "elevator" }),
    wheelchair: z
      .enum(["yes", "designated", "limited", "no"])
      .optional()
      .openapi({
        example: "yes",
        description:
          "OSM wheelchair 標籤值；designated = 專為輪椅設置（等級不低於 yes）",
      }),
    tags: z
      .record(z.string(), z.string())
      .optional()
      .openapi({
        example: { wheelchair: "yes", highway: "elevator" },
        description:
          "僅保留與判斷相關的白名單標籤（評分鍵與 name/opening_hours/level/amenity），無適用時省略；完整 OSM 標籤見 GET /api/a11y/place?osmId=…",
      }),
    location: z
      .object({
        type: z.literal("Point").openapi({ example: "Point" }),
        coordinates: z
          .tuple([z.number(), z.number()])
          .openapi({ example: [121.567, 25.041] }),
      })
      .openapi({ description: "GeoJSON 點位 [lng, lat]" }),
  })
  .strict()
  .openapi("SlimOsmA11y");

const A11yRefsSchema = z
  .array(z.string())
  .optional()
  .openapi({
    example: ["12342946149"],
    description:
      "僅 compact 格式：對應路線層級 facilities 字典的 osmId 鍵（此時各段設施陣列為空）。",
  });

const WalkLegSchema = z
  .object({
    type: z.literal("WALK").openapi({ example: "WALK" }),
    a11yRefs: A11yRefsSchema,
    from: z.string().openapi({ example: "起點" }),
    to: z.string().openapi({ example: "市政府站" }),
    distanceM: z.number().openapi({ example: 320 }),
    minutesEst: z.number().openapi({ example: 4 }),
    polyline: z.array(z.tuple([z.number(), z.number()])).openapi({
      example: [
        [121.567, 25.041],
        [121.568, 25.042],
      ],
    }),
    a11yFacilities: z.array(OsmA11ySchema),
    maxSlopePercent: z.number().nonnegative().nullable().openapi({
      example: null,
      description:
        "由此 WALK leg 已附帶的 OSM incline 標籤取最大絕對坡度百分比；null = 目前沒有可用量測，不是 0% 或平坦。現行路徑引擎的高程/坡度覆蓋稀疏，前端必須顯示未知。",
    }),
    crossings: z.number().int().nonnegative().nullable().openapi({
      example: null,
      description:
        "此 WALK leg 已附帶 OSM 設施中明確標記的 crossing 數；null = 沒有可用 crossing 觀測，不能解讀為沒有路口。",
    }),
    crossingsWithCurbRamp: z.number().int().nonnegative().nullable().openapi({
      example: null,
      description:
        "上述已觀測 crossing 中，判定為有坡道者：來源一為 OSM kerb_cut／dropped_kerb／坡道標籤（邊層級）；來源二為臺北市新工處坡道點位資料，且須兩端路口節點皆比對到坡道點（節點層級）才計入——僅單側有坡道時輪椅仍可能過不去，因此不計入，避免高估可通行性；null = 沒有正向的坡道觀測，不能解讀為 0。",
    }),
    minPathWidthCm: z.number().positive().nullable().openapi({
      example: null,
      description:
        "此 WALK leg 已附帶 OSM width 標籤的最小路徑寬度（公分）；null = 沒有可用量測，不是 0 公分。",
    }),
    surfaceType: z.enum(["paved", "gravel", "unknown"]).openapi({
      example: "unknown",
      description:
        "由目前附帶的 OSM surface 標籤保守歸類；unknown = 缺少或互相衝突的來源，不能假定鋪面品質。",
    }),
    restPoints: z
      .array(
        z
          .object({
            type: z.literal("accessible_toilet"),
            distanceM: z.number().nonnegative(),
          })
          .strict(),
      )
      .openapi({
        example: [],
        description:
          "只列出已附帶且明確標記為無障礙的 OSM 廁所。distanceM 為從 WALK 起點至該點最近路線位置的進度，不含繞行；空陣列不代表沿途沒有廁所。",
      }),
    a11ySegments: z
      .array(
        z
          .object({
            feature: z
              .enum([
                "elevator",
                "escalator",
                "moving_walkway",
                "ramp",
                "curb_ramp_crossing",
                "crossing",
                "stairs",
                "fare_gate",
                "exit_gate",
              ])
              .openapi({
                description:
                  "此段來源標註的設施類別，僅為分類、不含品質判斷；配色由前端決定。crossing 為沒有坡道觀測的路口，不代表現場真的沒有坡道，僅代表圖資無此觀測。",
              }),
            startIndex: z.number().int().nonnegative().openapi({
              description:
                "此段在同一 leg `polyline` 中的起點索引（inclusive）。startIndex === endIndex 代表點設施（例如電梯），前端應畫成 marker 而非線段。",
            }),
            endIndex: z.number().int().nonnegative().openapi({
              description:
                "此段在同一 leg `polyline` 中的終點索引（inclusive）。startIndex === endIndex 代表點設施（例如電梯），前端應畫成 marker 而非線段。",
            }),
            indoor: z.boolean().openapi({
              description: "此段是否整段位於室內（站內或建物內）。",
            }),
            distanceM: z.number().nonnegative().nullable().openapi({
              description:
                "此段地面距離；null 代表段內至少一條邊沒有可用長度量測，不是 0 公尺。",
            }),
            maxSlopePercent: z.number().nonnegative().nullable().openapi({
              description: "此段最大絕對坡度百分比；null 代表沒有可用量測。",
            }),
            minWidthCm: z.number().positive().nullable().openapi({
              description: "此段最小觀測寬度（公分）；null 代表沒有可用量測。",
            }),
          })
          .strict()
          .openapi("WalkA11ySegment"),
      )
      .optional()
      .openapi({
        description:
          "只有 engine=pedestrian-a11y 的純步行路線會有此欄位；欄位不存在代表該引擎沒有逐邊設施來源，不代表沿途沒有設施。各段依 startIndex 排序且不重疊。",
      }),
    sidewalkRampCount: z
      .number()
      .int()
      .nonnegative()
      .optional()
      .openapi({
        example: 12,
        description:
          "只有 engine=pedestrian-a11y 會有此欄位。此為路線沿線經過的政府人行道段上登錄的緣石坡道（curb ramp）總數，" +
          "不是本路徑上的定點坡道，且不代表坡道位於使用者會走到的位置。同一段人行道只計一次" +
          "（來源值為人行道面屬性，會複製到該面衍生的每條邊，已依人行道段去重後才相加）。" +
          "來源為政府人行道圖資，以鄰近比對（≤ 10 公尺）掛上；0 代表沿線人行道未登錄坡道，而非確定沒有坡道。",
      }),
    a11yPoints: z
      .array(
        z
          .object({
            type: z.literal("curb_ramp").openapi({ example: "curb_ramp" }),
            location: z.tuple([z.number(), z.number()]).openapi({
              example: [121.567, 25.041],
              description: "設施本身的 WGS84 [經度, 緯度]，非路徑上的投影點。",
            }),
          })
          .strict()
          .openapi("WalkA11yPoint"),
      )
      .optional()
      .openapi({
        description:
          "只有 engine=pedestrian-a11y 會有此欄位。座標是無障礙斜坡道設施本身的位置，" +
          "不是路徑上的投影點。來源為臺北市新工處人行道無障礙斜坡道點位（已排除汽車斜坡道），" +
          "以 8 公尺內最近人行道邊吸附。欄位為空或不存在不代表沿途沒有坡道" +
          "（約 35% 點位因該處圖上無人行道線而未吸附）。",
      }),
    steps: z
      .array(
        z
          .object({
            relativeDirection: z.enum(WALK_RELATIVE_DIRECTION_VALUES).openapi({
              description:
                "機器可讀的方向 enum，供前端 i18n、地圖對位與方位計算使用；未知上游值一律正規化為 CONTINUE。",
            }),
            absoluteDirection: z
              .enum(WALK_ABSOLUTE_DIRECTION_VALUES)
              .nullable()
              .openapi({
                description: "英文八方位 enum；無法觀測 bearing 時為 null。",
              }),
            streetName: z.string(),
            bogusName: z.boolean(),
            area: z.boolean(),
            stairs: z.boolean().openapi({
              description:
                "OTP step.feature 為 StairsUse 時為 true；Valhalla 步行備援固定為 false；CSR 選出的純步行路線依 edgeType 為 STEPS/INDOOR_STAIRS 判定。僅代表合併 step 內含樓梯，不代表整個 distanceM 都是樓梯。",
            }),
            steepSlope: z.boolean().openapi({
              description:
                "此步是否達到坡度警示門檻（wheelchair 模式 8.3%、其餘模式 12%）；false 代表未觀測或未達門檻，並不代表路段已確認平坦。",
            }),
            distanceM: z.number(),
            location: z.tuple([z.number(), z.number()]),
          })
          .strict()
          .openapi("WalkStep"),
      )
      .optional(),
    exitInfo: z
      .object({
        exitName: z.string(),
        exitNumber: z.string(),
        type: z.enum(["elevator", "ramp"]),
        coords: z.tuple([z.number(), z.number()]),
      })
      .strict()
      .nullable()
      .optional()
      .openapi({
        description: "此步行端點使用的北捷出口（電梯／坡道），僅轉乘路線會設定",
      }),
  })
  .strict()
  .openapi("WalkLeg");

const WaitInfoSchema = z
  .object({
    time: z
      .union([z.number(), z.string()])
      .nullable()
      .openapi({
        example: "14:34",
        description:
          'realtime → number（距離到站的分鐘數）；schedule → "HH:mm" 班表發車時間' +
          "（捷運等純班距服務為 number 期望等待）；null = 今日無班次",
      }),
    source: z.enum(["realtime", "schedule", "unavailable"]).openapi({
      example: "schedule",
      description:
        "realtime = TDX 即時 ETA, schedule = 班表, unavailable = 末班已過/未營運",
    }),
  })
  .strict()
  .openapi("WaitInfo");

const IntermediateStopSchema = z
  .object({
    name: z.string().openapi({ example: "中間站名" }),
    stationUid: z.string().optional().openapi({ example: "TRTC-R08" }),
    location: z
      .tuple([z.number(), z.number()])
      .optional()
      .openapi({
        example: [121.5, 25.0],
      }),
  })
  .strict()
  .openapi("IntermediateStop");

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

const BusLegSchema = z
  .object({
    type: z.literal("BUS").openapi({ example: "BUS" }),
    a11yRefs: A11yRefsSchema,
    routeName: z.string().openapi({ example: "信義幹線" }),
    departureStop: z.string().openapi({ example: "市政府站" }),
    arrivalStop: z.string().openapi({ example: "台北101" }),
    departureStopId: z.string().optional().openapi({
      example: "TXG2646",
      description: "含系統前綴的 GTFS 站牌 id（僅 GTFS 路徑）；THB… 為公路客運",
    }),
    arrivalStopId: z.string().optional().openapi({
      example: "TXG3917",
      description: "含系統前綴的 GTFS 站牌 id（僅 GTFS 路徑）",
    }),
    cityCode: z.string().optional().openapi({
      example: "TPE",
      description: "路段所屬城市代碼",
    }),
    departureTime: z.string().optional().openapi({
      example: "21:05",
      description: "HH:mm 預定發車時間（未知時省略）",
    }),
    arrivalTime: z.string().optional().openapi({
      example: "21:32",
      description: "HH:mm 預定到站時間（未知時省略）",
    }),
    waitInfo: WaitInfoSchema,
    estimatedWaitMinutes: z.number().optional().openapi({
      example: 6,
      description:
        "數值化的等待估計（分鐘）；未來排定路線的首段省略，應改讀 departureDate 與 departureTime",
    }),
    direction: z
      .union([z.literal(0), z.literal(1)])
      .openapi({ example: 0, description: "0 = 去程，1 = 返程" }),
    polyline: z.array(z.tuple([z.number(), z.number()])).openapi({
      example: [
        [121.567, 25.041],
        [121.564, 25.034],
      ],
    }),
    departureStopA11y: z.array(OsmA11ySchema),
    arrivalStopA11y: z.array(OsmA11ySchema),
    tdxCity: z
      .string()
      .optional()
      .openapi({
        example: "NewTaipei",
        description:
          "TDX City 路徑段，前端用來「另外打」RealTimeByFrequency 即時車輛位置 " +
          "（tdxCity + routeName + direction）做持續追蹤；公路客運（THB）無城市路徑、省略此欄。",
      }),
    intermediateStops: z.array(IntermediateStopSchema).optional(),
    alerts: z.array(MatchedAlertSchema).optional().openapi({
      description: "僅當該公車路線或站牌正在發布異常公告時出現。",
    }),
  })
  .strict()
  .openapi("BusLeg");

const MetroAlertStationSchema = z
  .object({
    id: z.string().openapi({ example: "R10" }),
    name: z.string().nullable().openapi({ example: "中山站" }),
  })
  .openapi("MetroAlertStation");

const MetroAlertSchema = z
  .object({
    alertId: z.string().openapi({ example: "TRTC-2026081501" }),
    title: z.string().openapi({ example: "電梯故障" }),
    description: z.string().openapi({ example: "R10 中山站電梯維修中" }),
    status: z.number().openapi({ example: 2, description: "TDX 公告狀態代碼" }),
    stations: z.array(MetroAlertStationSchema),
    lines: z.array(z.string()).openapi({ example: ["R"] }),
    publishTime: z.string().openapi({ example: "2026-08-15T09:30:00+08:00" }),
    updateTime: z.string().openapi({ example: "2026-08-15T09:45:00+08:00" }),
  })
  .openapi("MetroAlert");

const MetroAlertResultSchema = z
  .object({
    railSystem: z.string().openapi({ example: "TRTC" }),
    updatedAt: z.string().openapi({ example: "2026-08-15T10:00:00+08:00" }),
    alerts: z.array(MetroAlertSchema),
  })
  .openapi("MetroAlertResult");

const MetroLegSchema = z
  .object({
    type: z.literal("METRO").openapi({ example: "METRO" }),
    a11yRefs: A11yRefsSchema,
    railSystem: z.string().openapi({ example: "TRTC" }),
    lineId: z.string().openapi({
      example: "R",
      description:
        "路線代碼，前端用來上色/標示（紅線 R、藍線 BL、綠線 G、橘線 O、棕線 BR…）",
    }),
    lineName: z.string().openapi({ example: "TRTC-R" }),
    lineUid: z.string().openapi({ example: "TRTC-R" }),
    departureStation: z.string().openapi({ example: "市政府站" }),
    arrivalStation: z.string().openapi({ example: "台北車站" }),
    departureStationUid: z.string().openapi({ example: "TRTC-R10" }),
    arrivalStationUid: z.string().openapi({ example: "TRTC-R02" }),
    direction: z.union([z.literal(0), z.literal(1)]).openapi({ example: 0 }),
    stopsCount: z.number().openapi({ example: 5 }),
    rideMinutes: z.number().openapi({ example: 10 }),
    departureTime: z.string().optional().openapi({
      example: "21:05",
      description: "HH:mm 預定發車時間（未知時省略）",
    }),
    arrivalTime: z.string().optional().openapi({
      example: "21:15",
      description: "HH:mm 預定到站時間（未知時省略）",
    }),
    waitInfo: WaitInfoSchema,
    estimatedWaitMinutes: z.number().optional().openapi({ example: 3 }),
    polyline: z.array(z.tuple([z.number(), z.number()])).openapi({
      example: [
        [121.567, 25.041],
        [121.555, 25.047],
      ],
    }),
    departureStationA11y: z.array(OsmA11ySchema),
    arrivalStationA11y: z.array(OsmA11ySchema),
    facilityHighlights: z
      .array(z.string())
      .openapi({ example: ["乘車站有電梯", "下車站有無障礙廁所"] }),
    intermediateStops: z.array(IntermediateStopSchema).optional(),
    alerts: z.array(MetroAlertSchema).optional().openapi({
      description:
        "僅當該路段的車站或路線正在發布異常公告時出現；全線的公告也可在 data.metroAlerts 取得。",
    }),
  })
  .strict()
  .openapi("MetroLeg");

const ThsrLegSchema = z
  .object({
    type: z.literal("THSR").openapi({ example: "THSR" }),
    a11yRefs: A11yRefsSchema,
    trainNo: z.string().openapi({ example: "0617" }),
    departureStation: z.string().openapi({ example: "台北" }),
    arrivalStation: z.string().openapi({ example: "台中" }),
    departureStationUID: z.string().openapi({ example: "THSR-1000" }),
    arrivalStationUID: z.string().openapi({ example: "THSR-1040" }),
    departureTime: z
      .string()
      .openapi({ example: "09:00", description: "HH:mm" }),
    arrivalTime: z.string().openapi({ example: "09:47", description: "HH:mm" }),
    rideMinutes: z.number().openapi({ example: 47 }),
    waitInfo: WaitInfoSchema,
    estimatedWaitMinutes: z.number().optional().openapi({ example: 8 }),
    polyline: z.array(z.tuple([z.number(), z.number()])).openapi({
      example: [
        [121.516, 25.013],
        [120.684, 24.178],
      ],
      description: "僅 [上車站, 下車站] 兩點連線",
    }),
    departureStationA11y: z.array(OsmA11ySchema),
    arrivalStationA11y: z.array(OsmA11ySchema),
    facilityHighlights: z.array(z.string()).openapi({
      example: ["高鐵站設有無障礙設施", "列車備有無障礙座位及輪椅空間"],
    }),
    intermediateStops: z.array(IntermediateStopSchema).optional(),
    alerts: z.array(MatchedAlertSchema).optional().openapi({
      description: "僅當該高鐵區間正在發布異常或通阻公告時出現。",
    }),
  })
  .strict()
  .openapi("ThsrLeg");

const TraLegSchema = z
  .object({
    type: z.literal("TRA").openapi({ example: "TRA" }),
    a11yRefs: A11yRefsSchema,
    trainNo: z.string().openapi({ example: "0131" }),
    trainTypeName: z.string().openapi({
      example: "自強",
      description: "列車種類，如 自強、莒光、區間車",
    }),
    departureStation: z.string().openapi({ example: "台北" }),
    arrivalStation: z.string().openapi({ example: "基隆" }),
    departureStationUID: z.string().openapi({ example: "TRA-0900" }),
    arrivalStationUID: z.string().openapi({ example: "TRA-0900H" }),
    departureTime: z
      .string()
      .openapi({ example: "08:30", description: "HH:mm" }),
    arrivalTime: z.string().openapi({ example: "09:02", description: "HH:mm" }),
    rideMinutes: z.number().openapi({ example: 32 }),
    waitInfo: WaitInfoSchema,
    estimatedWaitMinutes: z.number().optional().openapi({ example: 12 }),
    polyline: z.array(z.tuple([z.number(), z.number()])).openapi({
      example: [
        [121.516, 25.013],
        [121.74, 25.13],
      ],
      description: "僅 [上車站, 下車站] 兩點連線",
    }),
    departureStationA11y: z.array(OsmA11ySchema),
    arrivalStationA11y: z.array(OsmA11ySchema),
    facilityHighlights: z
      .array(z.string())
      .openapi({ example: ["臺鐵自強 列車", "乘車站附近有電梯"] }),
    intermediateStops: z.array(IntermediateStopSchema).optional(),
    alerts: z.array(MatchedAlertSchema).optional().openapi({
      description: "僅當該臺鐵車次、路線或車站正在發布異常或通阻公告時出現。",
    }),
  })
  .strict()
  .openapi("TraLeg");

const DriveStepSchema = z
  .object({
    instruction: z.string().openapi({ example: "沿信義路四段向西行駛" }),
    distanceM: z.number().openapi({ example: 240 }),
    durationMin: z.number().openapi({ example: 1 }),
    polyline: z.array(z.tuple([z.number(), z.number()])).openapi({
      example: [
        [121.567, 25.041],
        [121.564, 25.04],
      ],
    }),
    maneuver: z.string().optional().openapi({ example: "TURN_LEFT" }),
  })
  .strict()
  .openapi("DriveStep");

const DriveLegSchema = z
  .object({
    type: z.literal("DRIVE").openapi({ example: "DRIVE" }),
    from: CoordSchema.openapi({ example: { lat: 25.041, lng: 121.567 } }),
    to: CoordSchema.openapi({ example: { lat: 25.034, lng: 121.564 } }),
    distanceM: z.number().openapi({ example: 5200 }),
    durationMin: z.number().openapi({
      example: 14,
      description: "Valhalla 自由流行駛時間；不含即時路況",
    }),
    durationInTrafficMin: z.number().optional().openapi({
      example: 21,
      description:
        "交通感知行駛時間（塞車預測）；目前自架 Valhalla 引擎未提供，保留供未來擴充",
    }),
    trafficLevel: z
      .enum(["light", "moderate", "heavy"])
      .optional()
      .openapi({ example: "heavy", description: "由塞車/自由流時間比值推導" }),
    summary: z
      .string()
      .optional()
      .openapi({ example: "建國高架道路", description: "主要行經道路" }),
    polyline: z.array(z.tuple([z.number(), z.number()])).openapi({
      example: [
        [121.567, 25.041],
        [121.564, 25.034],
      ],
    }),
    steps: z.array(DriveStepSchema).optional(),
    modeFallback: z.literal("DRIVE").optional().openapi({
      description:
        "僅騎車模式：該地區不支援 TWO_WHEELER 時，改用開車路線的標記",
    }),
  })
  .strict()
  .openapi("DriveLeg");

const MotorcycleLegSchema = DriveLegSchema.extend({
  type: z.literal("MOTORCYCLE").openapi({ example: "MOTORCYCLE" }),
}).openapi("MotorcycleLeg");

const ScoreComponentsSchema = z
  .object({
    facilityScore: z.number().openapi({
      example: 72,
      description: "0–100：各站 OSM 無障礙設施的加權品質",
    }),
    timeScore: z.number().openapi({
      example: 85,
      description: "0–100：正規化的行程時間（100 = 最快候選）",
    }),
    criticalFeatureScore: z.number().openapi({
      example: 65,
      description: "0–100：Tier 1 關鍵設施（電梯、平接緣石、坡道）的具備程度",
    }),
    walkPenalty: z.number().openapi({
      example: 8,
      description:
        "依模式扣分的步行距離懲罰（0 至模式上限；輪椅 35、長者 30、視障 25、一般 15）",
    }),
    environmentScore: z.number().optional().openapi({
      example: 88,
      description:
        "環境條件分數（有效區間 75–100，越高越佳；已納入 totalScore）。綜合降雨機率、長步行段高溫、空氣品質；僅在成功取得天氣/空品資料時出現，缺少時前端沿用既有 fallback。",
    }),
  })
  .strict()
  .openapi("ScoreComponents");

const RouteHazardSchema = z
  .object({
    id: z.string().openapi({ example: "67f0a6c5c0e08c4fd4bc1d2a" }),
    hazardType: z
      .enum(["obstacle", "construction", "data_error"])
      .openapi({ example: "construction" }),
    severity: z
      .enum(["blocking", "difficult", "minor"])
      .openapi({ example: "blocking" }),
    description: z.string().optional().openapi({ example: "人行道施工中" }),
    location: CoordSchema.openapi({
      example: { lat: 25.0411, lng: 121.5674 },
      description: "已確認回報的位置。",
    }),
    distanceM: z.number().nonnegative().openapi({
      example: 8.4,
      description: "此障礙到路線地面幾何的最短距離（公尺）。",
    }),
  })
  .strict()
  .openapi("RouteHazard");

const RouteHazardAdvisorySchema = z
  .object({
    onRoute: z.array(RouteHazardSchema).openapi({
      description:
        "與此路線 WALK／DRIVE／MOTORCYCLE 地面幾何相交的已確認障礙。",
    }),
    avoided: z.array(RouteHazardSchema).openapi({
      description:
        "僅在此路線是選定候選且同一障礙已被證實相交於另一候選、但未相交於此路線時出現；空陣列不表示系統已檢查到沒有其他障礙。",
    }),
    blockingOnRoute: z.number().int().nonnegative().openapi({ example: 1 }),
    penaltyPoints: z.number().nonnegative().openapi({
      example: 1000,
      description: "本次候選排序使用的已確認障礙懲罰點數；越高代表影響越大。",
    }),
  })
  .strict()
  .openapi("RouteHazardAdvisory");

export const AccessibleRouteSchema = z
  .object({
    routeId: z.string().openapi({ example: "route-001" }),
    routeToken: z.string().optional().openapi({
      example: "M2F1...short-lived-capability",
      description:
        "30 分鐘內可用於語音 WS nav.setRoute 的高熵 bearer capability；Redis 不可用時省略。",
    }),
    routeName: z.string().openapi({ example: "信義幹線" }),
    totalMinutes: z.number().openapi({ example: 18 }),
    transferCount: z
      .number()
      .openapi({ example: 0, description: "0=直達，1=轉乘一次，2=轉乘兩次" }),
    legs: z
      .array(
        z.discriminatedUnion("type", [
          WalkLegSchema,
          BusLegSchema,
          MetroLegSchema,
          ThsrLegSchema,
          TraLegSchema,
          DriveLegSchema,
          MotorcycleLegSchema,
        ]),
      )
      .openapi({
        description:
          "依序的路段：步行 → 大眾運輸 → 步行；運輸段類型為 BUS、METRO、THSR、TRA；開車／騎車路線主體為 DRIVE／MOTORCYCLE，且可能於頭、尾、以及各中途點含 WALK leg（步行銜接至/自可行車道路；中途點若只能步行抵達會出現一進一出兩段 WALK）。前端須依 leg.type 分派繪製。步行銜接段採真實行人幾何、絕不畫直線；其端點與相鄰車行段端點可能有至多約 25 公尺的網路層自然偏移（前端如需可自行視覺化銜接）。偵測到落差但無法建立可信步行路徑時不補 WALK leg，改於 accessibilityHighlights 給文字警示。",
      }),
    accessibilityHighlights: z
      .array(z.string())
      .openapi({ example: ["全程低地板公車", "出入口設有電梯"] }),
    engine: z.enum(["pedestrian-a11y", "otp-fallback"]).optional().openapi({
      example: "pedestrian-a11y",
      description:
        "純步行路線的選路來源：pedestrian-a11y 表示由 CSR 無障礙行人圖選路；otp-fallback 表示 CSR 未決定該路線，須搭配 warnings 了解 OTP2 或 OTP2 不可用後的 Valhalla 降級。大眾運輸與開車／機車路線省略。",
    }),
    degraded: z.boolean().optional().openapi({
      example: true,
      description:
        "硬性無障礙條件未完全滿足，或台北 CSR 本應保護但無法選路而改用 OTP2 時為 true；前端必須搭配 warnings 顯示風險。",
    }),
    warnings: z
      .array(z.string())
      .optional()
      .openapi({
        example: [
          "OTP 步行規劃暫時不可用，已降級使用 Valhalla 步行路線，指引品質可能不同",
        ],
        description: "路線引擎降級或硬性無障礙條件無法完全滿足時的使用者警示",
      }),
    hazardAdvisory: RouteHazardAdvisorySchema.optional().openapi({
      description:
        "選填：只有已成功查到仍有效、verified 且至少一人確認的回報，並可用候選的地面幾何精確比對時才出現。欄位缺席表示本次未有可安全主張的比對結果，不代表沒有障礙。",
    }),
    departureDate: z.string().optional().openapi({
      example: "2026-07-29",
      description:
        "僅在今日班次已過、路線滾到隔日最早班次時出現（YYYY-MM-DD）；前端應提示「今日班次已過」。",
    }),
    accessibilityScore: z
      .number()
      .optional()
      .openapi({
        example: 74,
        description:
          "0–100 以實證為基礎的路線無障礙分數。" +
          "65% 無障礙（設施品質＋關鍵設施）＋35% 行程時間。" +
          "≥80 優、60–79 良、40–59 普通、20–39 差、<20 危險。",
      }),
    accessibilityLabel: z
      .enum(["excellent", "good", "fair", "poor", "critical"])
      .optional()
      .openapi({
        example: "good",
        description: "accessibilityScore 的可讀標籤",
      }),
    scoreComponents: ScoreComponentsSchema.optional().openapi({
      description: "accessibilityScore 的子項目拆解",
    }),
    accessibilitySummary: z.string().optional().openapi({
      example: "全程設有電梯，步行約 450 公尺、路面大致平坦，適合輪椅通行",
      description:
        "依 mode 客製的單句中文通行結論（輪椅重電梯坡道、視障重導盲/語音號誌、長者重步行距離與轉乘）；前端可直接顯示，取代等級對照的通用文案。",
    }),
    dataConfidence: z
      .enum(["high", "medium", "low"])
      .optional()
      .openapi({
        example: "low",
        description:
          "無障礙資料覆蓋信心：依沿途有 a11y 資料的路段比例（high ≥ 2/3、medium ≥ 1/3、low < 1/3）。" +
          "low 表示分數為保守估計（資料稀疏），與『真的無障礙差』不同。",
      }),
    scoreWarnings: z
      .array(z.string())
      .optional()
      .openapi({
        example: ["沿途無障礙資料不足，分數為保守估計"],
        description:
          "影響分數可信度或需提醒使用者的訊息（如資料不足、步行過長）",
      }),
    totalWalkDistanceM: z.number().optional().openapi({
      example: 736,
      description: "全程步行距離（公尺），供前端顯示與排序透明度",
    }),
    facilities: z.record(z.string(), OsmA11ySchema).optional().openapi({
      description:
        "僅 compact 格式：以 osmId 為鍵、去重後的設施字典；各段透過 a11yRefs 參照。",
    }),
    attribution: z.string().optional().openapi({
      example: "© OpenStreetMap contributors",
      description: "道路路線資料來源標示；前端應顯示",
    }),
  })
  .strict()
  .openapi("AccessibleRoute");

export const AccessibleRouteDataSchema = z
  .object({
    origin: CoordSchema.openapi({ example: { lat: 25.041, lng: 121.567 } }),
    destination: CoordSchema.openapi({
      example: { lat: 25.034, lng: 121.564 },
    }),
    city: z.string().openapi({ example: "Taipei" }),
    travelMode: z
      .enum(["transit", "drive", "motorcycle", "walk"])
      .optional()
      .openapi({ example: "drive", description: "本次規劃使用的交通工具" }),
    waypoints: z
      .array(CoordSchema)
      .optional()
      .openapi({ description: "解析後的中途點座標（依序）" }),
    routes: z.array(AccessibleRouteSchema),
    intent: RouteIntentSchema.optional().openapi({
      description:
        "僅當請求使用自然語言 query 時出現；包含由查詢解析出的 RouteIntent（起點、終點、模式、出發時間、偏好）。",
    }),
    slopeConstraint: z
      .object({
        requestedMaxPercent: z.number().openapi({ example: 5 }),
        enforced: z
          .boolean()
          .openapi({ description: "要求的坡度上限是否真的被實際選路引擎執行" }),
        note: z.string().openapi({
          example: ROUTE_WARNING.CSR_SLOPE_LIMIT_NOT_ENFORCED,
        }),
      })
      .optional()
      .openapi({
        description:
          "僅當請求或 profile 帶有 maxSlopePercent 時出現；誠實回報該限制是否真的被執行，避免前端誤以為坡度篩選已生效。",
      }),
    metroAlerts: z.array(MetroAlertResultSchema).optional().openapi({
      description:
        "僅當路線搭乘的捷運系統目前有異常營運公告時出現；依捷運系統分組。單一路段相關的公告另行挂在 METRO leg 的 alerts。",
    }),
    transitAlerts: z.array(MatchedAlertSchema).optional().openapi({
      description:
        "僅當路線搭乘的大眾運輸（公車、捷運、臺鐵、高鐵）目前有異常營運或通阻公告時出現。",
    }),
  })
  .openapi("AccessibleRouteData");

export const AccessibleRouteResponseSchema = z
  .object({
    ok: z.boolean().openapi({ example: true }),
    status: z.enum(["success", "error"]).openapi({ example: "success" }),
    code: z.number().openapi({ example: 200 }),
    message: z.string().openapi({ example: "已找到無障礙路線" }),
    data: AccessibleRouteDataSchema.optional(),
    accessToken: z.string().optional(),
  })
  .openapi("AccessibleRouteResponse");

export const RouteFailureDataSchema = z
  .object({
    reason: z
      .enum([
        ROUTE_REASON.OUT_OF_RANGE,
        ROUTE_REASON.OUT_OF_COVERAGE,
        ROUTE_REASON.NO_ACCESSIBLE_ROUTE,
        ROUTE_REASON.NO_ROUTE,
        ROUTE_REASON.UPSTREAM_TIMEOUT,
      ])
      .openapi({
        description:
          `${ROUTE_REASON.OUT_OF_RANGE}: ${ROUTE_MSG.OUT_OF_RANGE}；` +
          `${ROUTE_REASON.OUT_OF_COVERAGE}: ${ROUTE_MSG.OUT_OF_COVERAGE}；` +
          `${ROUTE_REASON.NO_ACCESSIBLE_ROUTE}: ${ROUTE_MSG.NO_ACCESSIBLE_ROUTE}；` +
          `${ROUTE_REASON.NO_ROUTE}: ${ROUTE_MSG.NO_ROUTE}；` +
          `${ROUTE_REASON.UPSTREAM_TIMEOUT}: ${ROUTE_MSG.UPSTREAM_TIMEOUT}。`,
      }),
    maxDistanceKm: z.number().optional().openapi({
      example: 100,
      description:
        "僅 reason=OUT_OF_RANGE 時出現；此次請求允許的相鄰點總距離上限（公里）。",
    }),
  })
  .strict()
  .openapi("RouteFailureData");

const ValidationErrorDataSchema = z
  .object({
    errors: z.array(
      z
        .object({
          path: z.string().openapi({ example: "origin" }),
          message: z.string().openapi({ example: "Invalid input" }),
        })
        .strict(),
    ),
  })
  .strict();

export const ErrorResponseSchema = z
  .object({
    ok: z.boolean().openapi({ example: false }),
    status: z.enum(["success", "error"]).openapi({ example: "error" }),
    code: z.number().openapi({ example: 400 }),
    message: z.string().openapi({ example: "缺少參數或座標無法解析" }),
    data: z
      .union([RouteFailureDataSchema, ValidationErrorDataSchema])
      .optional(),
    accessToken: z.string().optional(),
  })
  .strict()
  .openapi("ErrorResponse");

registry.registerPath({
  method: "post",
  path: "/a11y/accessible-route",
  tags: ["Accessibility"],
  summary: "無障礙路線規劃",
  description:
    "規劃起訖點間無障礙路線。travelMode=transit（預設）並行搜尋公車、捷運、高鐵與台鐵，且 transit itinerary 的 WALK legs 維持 OTP2；純 walk 在台北 CSR bbox 內且啟用時以 CSR 為 primary，CSR 在範圍內無法選路時改以 warnings 標記 OTP2 fallback，bbox 外或 CSR 停用時 OTP2 本來就是 primary。只有 OTP2 步行不可用時才以 warnings 標記後降級至 Valhalla pedestrian。drive／motorcycle 主體走自架 Valhalla（自由流時間、不含即時路況）。支援最多 5 個中途點（waypoints），回傳最多 3 筆。選填帶 Bearer token：帶時，未明確傳入的 mode/avoidStairs/requireElevator/needsAccessibleToilet/needsHandrail/maxSlopePercent 會從登入者已儲存的 a11y-profile 推導；不帶則完全公開不受影響；帶但無效/過期回 401/403。",
  security: [{ bearerAuth: [] }, {}],
  request: {
    body: {
      content: { "application/json": { schema: AccessibleRouteBodySchema } },
      required: true,
    },
  },
  responses: {
    200: {
      description: "依無障礙分數排序的最多 3 筆路線（公車／捷運／高鐵／台鐵）",
      content: {
        "application/json": { schema: AccessibleRouteResponseSchema },
      },
    },
    400: {
      description: "缺少參數或座標無法解析",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
    401: { description: "帶了 Bearer token 但已過期" },
    403: { description: "Bearer token 無效" },
    422: {
      description:
        `${ROUTE_REASON.OUT_OF_RANGE}（${ROUTE_MSG.OUT_OF_RANGE}）、` +
        `${ROUTE_REASON.OUT_OF_COVERAGE}（${ROUTE_MSG.OUT_OF_COVERAGE}）、` +
        `${ROUTE_REASON.NO_ACCESSIBLE_ROUTE}（${ROUTE_MSG.NO_ACCESSIBLE_ROUTE}）或 ` +
        `${ROUTE_REASON.NO_ROUTE}（${ROUTE_MSG.NO_ROUTE}）`,
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
    500: {
      description: "伺服器錯誤",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
    503: {
      description:
        `${ROUTE_REASON.UPSTREAM_TIMEOUT}（${ROUTE_MSG.UPSTREAM_TIMEOUT}）：` +
        "CSR、OTP2 或 Valhalla 路線規劃上游暫時不可用",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
  },
});
