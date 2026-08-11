import { extendZodWithOpenApi } from "@asteasolutions/zod-to-openapi";
import { z } from "zod";
import { registry } from "../../openapi/registry";

extendZodWithOpenApi(z);

const coordString = (label: string) =>
  z.string().regex(/^-?\d+(\.\d+)?$/, `Must be a valid ${label}`);

/**
 * Response language. Accepts any zh-* / en-* tag — the controller normalizes
 * `zh-tw`, `zh-Hant-TW` and `en-US` — while anything else is a 400 rather than
 * a silent fallback, so a typo surfaces instead of quietly returning Chinese.
 *
 * The primary subtag is spelled out as character classes rather than carrying an
 * `i` flag: zod-to-openapi copies the flag into the emitted `pattern`, which is
 * not valid JSON Schema and breaks client-side validators.
 */
const langString = () =>
  z
    .string()
    .regex(/^([Zz][Hh]|[Ee][Nn])(-[A-Za-z0-9]+)*$/, "lang 只接受 zh-TW 或 en")
    .optional()
    .openapi({
      example: "zh-TW",
      description: "回傳語言，zh-TW（預設）或 en。影響名稱、地址與 typeLabel。",
    });

const PlaceGeoPointSchema = z
  .object({
    type: z.literal("Point").openapi({ example: "Point" }),
    coordinates: z
      .tuple([z.number(), z.number()])
      .openapi({ example: [121.5654, 25.033], description: "[lng, lat]" }),
  })
  .openapi("PlaceGeoPoint");

const AccessibilitySchema = z
  .object({
    status: z
      .enum(["accessible", "limited", "unknown"])
      .openapi({
        example: "unknown",
        description: "場所本身的無障礙判定；附近設施不會改變此判定。",
      }),
    wheelchair: z
      .enum(["yes", "limited", "no"])
      .nullable()
      .openapi({ example: null, description: "既有輪椅可用性欄位；無資料為 null" }),
    wheelchairAccess: z
      .boolean()
      .nullable()
      .openapi({
        example: null,
        description: "場所本身輪椅可進入：true=來源明確確認有，false=來源明確確認沒有，null=未調查或來源無法判斷。",
      }),
    elevator: z
      .boolean()
      .nullable()
      .openapi({
        example: null,
        description: "場所本身電梯：true=來源明確確認有，false=來源明確確認沒有，null=未調查或來源無法判斷。",
      }),
    ramp: z
      .boolean()
      .nullable()
      .openapi({
        example: null,
        description: "場所本身坡道：true=來源明確確認有，false=來源明確確認沒有，null=未調查或來源無法判斷。",
      }),
    accessibleToilet: z
      .boolean()
      .nullable()
      .openapi({
        example: null,
        description: "場所本身無障礙廁所：true=來源明確確認有，false=來源明確確認沒有，null=未調查或來源無法判斷。",
      }),
    nearbyFacilityCount: z
      .number()
      .int()
      .nonnegative()
      .openapi({
        example: 0,
        description: "本地 DB 半徑內的無障礙設施數，僅供附近設施展示，不是場所本身的無障礙證據。",
      }),
    source: z
      .enum(["local-db", "google", "osm", "none"])
      .openapi({
        example: "none",
        description: "場所本身無障礙訊號的資料來源；附近本地設施不會作為場所證據。",
      }),
  })
  .strict()
  .openapi("PlaceAccessibility");

const PlaceSourceSchema = z.enum(["osm", "google"]);

export const AutocompleteItemSchema = z
  .object({
    id: z
      .string()
      .openapi({ example: "osm:node:123456", description: "前綴 id：google:<id> 或 osm:<type>:<id>" }),
    source: PlaceSourceSchema.openapi({ example: "osm" }),
    primaryText: z.string().openapi({ example: "台北101" }),
    secondaryText: z
      .string()
      .nullable()
      .openapi({ example: "台北市信義區", description: "OSM 為完整地址；Google 為預測副標" }),
    placeClass: z
      .string()
      .nullable()
      .openapi({ example: "tourism", description: "OSM 字彙的 class，供前端選圖示" }),
    placeType: z.string().nullable().openapi({ example: "attraction" }),
    typeLabel: z.string().nullable().openapi({ example: "景點", description: "中文類型標籤" }),
    location: PlaceGeoPointSchema.nullable().openapi({
      description: "OSM 有座標；Google 預測階段恆為 null",
    }),
    distanceMeters: z
      .number()
      .nullable()
      .openapi({
        example: 1200,
        description: "直線距離（公式直線距離，非實際行走距離），相對於查詢參數 lat/lng 計算；未帶 lat/lng 或地點本身無座標時為 null。",
      }),
  })
  .strict()
  .openapi("AutocompleteItem");

const AddressComponentsSchema = z
  .object({
    road: z.string().nullable().openapi({ example: "信義路五段" }),
    district: z.string().nullable().openapi({ example: "信義區" }),
    city: z.string().nullable().openapi({ example: "臺北市" }),
    postcode: z.string().nullable().openapi({ example: "110" }),
  })
  .strict()
  .openapi("PlaceAddressComponents");

const NearbyFacilityBriefSchema = z
  .object({
    id: z.string().openapi({ example: "66a1f2c3e4b5a6d7c8e9f0d4" }),
    name: z.string().openapi({ example: "市政府站無障礙廁所" }),
    address: z.string().nullable().openapi({ example: "台北市信義區市府路45號" }),
    category: z.string().openapi({ example: "toilet" }),
    typeLabel: z.string().openapi({ example: "無障礙廁所" }),
    distanceMeters: z.number().openapi({ example: 120 }),
    source: z
      .enum(["government", "osm"])
      .openapi({ example: "government", description: "這筆設施資料的來源資料集" }),
    lastVerifiedAt: z
      .string()
      .nullable()
      .openapi({
        example: null,
        description: "資料集匯入/更新時間；來源本身不附時間戳記時為 null，不代表資料是最新的。",
      }),
  })
  .strict()
  .openapi("NearbyFacilityBrief");

export const PlaceResultSchema = z
  .object({
    id: z.string().openapi({ example: "google:ChIJ...", description: "前綴 id" }),
    source: PlaceSourceSchema.openapi({ example: "google" }),
    name: z.string().openapi({ example: "台北101" }),
    fullAddress: z.string().nullable().openapi({ example: "台北市信義區信義路五段7號" }),
    addressComponents: AddressComponentsSchema,
    location: PlaceGeoPointSchema,
    placeClass: z.string().nullable().openapi({ example: "tourism" }),
    placeType: z.string().nullable().openapi({ example: "attraction" }),
    typeLabel: z.string().nullable().openapi({ example: "景點" }),
    distanceMeters: z
      .number()
      .nullable()
      .openapi({
        example: 1200,
        description: "直線距離（公式直線距離，非實際行走距離），相對於查詢參數 lat/lng 計算；未帶 lat/lng 時為 null。",
      }),
    rating: z.number().nullable().openapi({ example: 4.5, description: "Google 才有" }),
    accessibility: AccessibilitySchema,
    nearbyFacilities: z
      .object({
        toilets: z.array(NearbyFacilityBriefSchema),
        metro: z.array(NearbyFacilityBriefSchema),
      })
      .strict()
      .openapi("PlaceNearbyFacilities"),
    reviewKey: z
      .object({
        placeId: z.string().openapi({ example: "node/123456" }),
        placeType: z
          .enum(["osm", "a11y", "bathroom", "welfare", "parking", "google"])
          .openapi({ example: "osm" }),
      })
      .strict()
      .openapi("PlaceReviewKey"),
    externalLinks: z
      .object({
        osm: z.string().nullable().openapi({ example: "https://www.openstreetmap.org/node/123456" }),
        google: z.string().nullable().openapi({ example: null }),
      })
      .strict()
      .openapi("PlaceExternalLinks"),
    attribution: z
      .string()
      .nullable()
      .openapi({ example: "© OpenStreetMap contributors", description: "資料來源授權標註" }),
  })
  .strict()
  .openapi("PlaceResult");

export const AutocompleteQuerySchema = z
  .object({
    q: z.string().min(1).openapi({ example: "台北1", description: "使用者輸入的部分文字" }),
    sessiontoken: z
      .string()
      .optional()
      .openapi({ example: "b2c3d4e5-...", description: "前端產生的 session UUID，綁定計費" }),
    lat: coordString("latitude")
      .optional()
      .openapi({
        example: "25.0330",
        description: "距離計算的基準點緯度；不限定是使用者裝置 GPS，可以是地圖中心或任何參考座標，未提供時 distanceMeters 回 null。",
      }),
    lng: coordString("longitude")
      .optional()
      .openapi({
        example: "121.5654",
        description: "距離計算的基準點經度；與 lat 成對使用。",
      }),
    sources: z
      .string()
      .regex(/^(osm|google)(,(osm|google))*$/, "sources 只接受 osm / google，以逗號分隔")
      .optional()
      .openapi({ example: "osm,google", description: "來源白名單，預設兩者皆啟用" }),
    limit: z.coerce
      .number()
      .int()
      .min(1)
      .max(20)
      .optional()
      .openapi({ example: 8, description: "合併後的結果上限，預設 8" }),
    lang: langString(),
  })
  .strict();

export const DetailsParamsSchema = z
  .object({
    id: z
      .string()
      .regex(
        /^(google:.+|osm:(node|way|relation):\d+)$/,
        "id 必須是 google:<placeId> 或 osm:<node|way|relation>:<id>",
      )
      .openapi({ example: "osm:node:123456" }),
  })
  .strict();

export const DetailsQuerySchema = z
  .object({
    sessiontoken: z
      .string()
      .optional()
      .openapi({ example: "b2c3d4e5-...", description: "與 autocomplete 相同的 session UUID" }),
    lat: coordString("latitude")
      .optional()
      .openapi({
        example: "25.0330",
        description: "距離計算的基準點緯度；不限定是使用者裝置 GPS，可以是地圖中心或任何參考座標，未提供時 distanceMeters 回 null。",
      }),
    lng: coordString("longitude")
      .optional()
      .openapi({
        example: "121.5654",
        description: "距離計算的基準點經度；與 lat 成對使用。",
      }),
    lang: langString(),
  })
  .strict();

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

export const AutocompleteResponseSchema = ApiResponseSchema(
  z.array(AutocompleteItemSchema),
  "AutocompleteResponse",
);

export const PlaceDetailsResponseSchema = ApiResponseSchema(
  PlaceResultSchema,
  "PlaceDetailsResponse",
);

registry.registerPath({
  method: "get",
  path: "/a11y/search/autocomplete",
  tags: ["Accessibility"],
  summary: "地點搜尋自動完成",
  description:
    "逐字輸入時呼叫，合併 OSM（Nominatim）與 Google Places 兩路預測並去重。不含無障礙資訊；OSM 筆帶座標，Google 筆的 location 恆為 null。帶 sessiontoken 與後續 details 綁成一次 Google 計費。`lang=en` 時 Google 預測與 typeLabel 回英文，OSM 名稱取決於該物件是否有 name:en tag，沒有則回退原名。",
  request: { query: AutocompleteQuerySchema },
  responses: {
    200: {
      description: "預測清單（任一來源失敗時只掉該來源，仍回 200）",
      content: { "application/json": { schema: AutocompleteResponseSchema } },
    },
    400: { description: "缺少 q 或參數不合法" },
    500: { description: "伺服器錯誤" },
  },
});

registry.registerPath({
  method: "get",
  path: "/a11y/search/details/{id}",
  tags: ["Accessibility"],
  summary: "地點詳情與無障礙判定",
  description:
    "使用者點選某筆預測後呼叫，依 id 前綴分派到 Google Place Details 或 OSM lookup，取座標與欄位並就近查本地無障礙資料，回傳單一 PlaceResult（含三態徽章與附近設施）。nearbyFacilityCount 與 nearbyFacilities 僅展示附近資料，不是場所本身的無障礙證據，也不會推導 accessibility.status。osm: 開頭的 id 不會呼叫 Google、不消耗 session token。`lang=en` 時名稱、地址與 typeLabel 回英文；nearbyFacilities 的 name／address 來自本地中文資料集，僅 typeLabel 會翻譯。",
  request: { params: DetailsParamsSchema, query: DetailsQuerySchema },
  responses: {
    200: {
      description: "地點詳情",
      content: { "application/json": { schema: PlaceDetailsResponseSchema } },
    },
    400: { description: "id 前綴不合法或參數不合法" },
    404: { description: "查無此地點或無可用座標" },
    500: { description: "伺服器錯誤" },
  },
});
