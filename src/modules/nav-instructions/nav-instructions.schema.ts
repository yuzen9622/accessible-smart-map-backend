import { extendZodWithOpenApi } from "@asteasolutions/zod-to-openapi";
import { z } from "zod";
import { registry } from "../../openapi/registry";

extendZodWithOpenApi(z);

const NavCoordSchema = z.tuple([z.number(), z.number()]);

const NavWalkStepSchema = z
  .looseObject({
    location: NavCoordSchema,
    instruction: z.string().optional(),
    relativeDirection: z.string().optional(),
    absoluteDirection: z.string().nullish(),
    streetName: z.string().optional(),
    bogusName: z.boolean().optional(),
    stairs: z.boolean().optional(),
    distanceM: z.number().optional(),
  })
  .openapi("NavWalkStep");

const NavRoadStepSchema = z
  .looseObject({
    instruction: z.string(),
    polyline: z.array(NavCoordSchema),
    distanceM: z.number().optional(),
    maneuver: z.string().optional(),
  })
  .openapi("NavRoadStep");

const NavLegSchema = z
  .looseObject({
    type: z.string(),
    polyline: z.array(NavCoordSchema),
    steps: z.array(z.union([NavWalkStepSchema, NavRoadStepSchema])).optional(),
    exitInfo: z
      .looseObject({
        exitNumber: z.string().optional(),
        type: z.string().optional(),
      })
      .nullish(),
  })
  .openapi("NavLeg");

const NavRouteSchema = z
  .looseObject({
    routeId: z.string().optional(),
    legs: z.array(NavLegSchema),
  })
  .openapi("NavRoute");

export const NavInstructionsRequestSchema = z
  .object({
    route: NavRouteSchema.optional().openapi({
      description:
        "由 /accessible-route 回傳的路線物件（前端原樣 passthrough）；完整欄位見 AccessibleRoute。" +
        "此處只驗證產生指引時實際讀取的欄位，其餘欄位（設施陣列、評分、未來新增欄位）一律原樣容忍，" +
        "以免規劃器輸出演進時導航入口誤擋。未支援的 leg 型別與空 legs 由服務層回 400（reason 為 " +
        "UNSUPPORTED_LEG_TYPE / INVALID_ROUTE_INPUT）。",
    }),
    routeToken: z.string().trim().min(1).max(256).optional().openapi({
      description:
        "由 /accessible-route 回傳、30 分鐘內有效的 routeToken；與 route 同時提供時優先使用 token 對應的伺服器端路線。",
      example: "M2F1...short-lived-capability",
    }),
    userHeading: z.number().min(0).max(359).optional().openapi({
      description:
        "使用者當前朝向（度，正北 = 0，順時針），由陀螺儀取得。提供時後端填入 relativeDirection；省略則為 null。",
      example: 45,
    }),
    language: z.enum(["zh-TW"]).default("zh-TW").openapi({
      description: "輸出語言（預留，目前僅支援 zh-TW）。",
    }),
  })
  .strict()
  .refine((body) => body.route !== undefined || body.routeToken !== undefined, {
    message: "請提供 route 或 routeToken",
  })
  .openapi("NavInstructionsRequest");

const RelativeDirectionEnum = z
  .enum([
    "正前方",
    "左前方",
    "右前方",
    "左側",
    "右側",
    "左後方",
    "右後方",
    "正後方",
  ])
  .openapi("RelativeDirection");

const NavInstructionSchema = z
  .object({
    text: z.string(),
    type: z.enum([
      "turn",
      "transit_board",
      "transit_alight",
      "facility",
      "depart",
      "arrive",
    ]),
    bearing: z.number().nullable(),
    relativeDirection: RelativeDirectionEnum.nullable(),
    distanceM: z.number().nullable().openapi({
      description: "完成本步 maneuver 後、到下一步之前要行進的距離（公尺）",
    }),
    streetName: z.string().nullable(),
    legType: z.enum([
      "WALK",
      "DRIVE",
      "MOTORCYCLE",
      "BUS",
      "METRO",
      "THSR",
      "TRA",
    ]),
    stairs: z.boolean().openapi({
      description:
        "此逐步指引對應的步行段是否含樓梯；非步行指引固定為 false。僅代表該段含樓梯，不代表整個 distanceM 都是樓梯。",
    }),
    legIndex: z.number().int().nonnegative().openapi({
      description: "此指引來源在 route.legs 中的索引",
    }),
    polylineIndex: z.number().nullable(),
    cumulativeDistanceM: z.number().nonnegative().openapi({
      description: "抵達此 maneuver 起點前已累積的可量測行進距離（公尺）",
    }),
  })
  .openapi("NavInstruction");

const NavInstructionsDataSchema = z
  .object({
    instructions: z.array(NavInstructionSchema),
    initialBearing: z.number(),
    totalSteps: z.number(),
    warnings: z.array(
      z.enum([
        "WALK_STEPS_UNAVAILABLE",
        "ORS_STEPS_UNAVAILABLE",
        "ROAD_STEPS_UNAVAILABLE",
      ]),
    ),
  })
  .openapi("NavInstructionsData");

const NavInstructionsResponseSchema = z
  .object({
    ok: z.boolean(),
    status: z.string(),
    code: z.number(),
    message: z.string(),
    data: NavInstructionsDataSchema,
  })
  .openapi("NavInstructionsResponse");

const NavErrorResponseSchema = z
  .object({
    ok: z.literal(false),
    status: z.literal("error"),
    code: z.number(),
    message: z.string(),
    data: z.object({ reason: z.string() }).optional(),
  })
  .openapi("NavInstructionsErrorResponse");

registry.registerPath({
  method: "post",
  path: "/a11y/route/instructions",
  tags: ["Accessibility"],
  summary: "路線逐步導航指引產生",
  description:
    "以 /accessible-route 回傳的 routeToken（優先）或完整 route 轉為可語音朗讀的逐步指引。所有正常步行段源自 OTP；停機降級的 Valhalla 步行仍支援相同輸出。步行指引以 stairs 標示該段含樓梯並在 text 加入定性提示，不代表整段 distanceM 都是樓梯。若缺少 steps 仍回傳 200 概略指引。WALK 過渡期同時回 WALK_STEPS_UNAVAILABLE 與 legacy ORS_STEPS_UNAVAILABLE，車行回 ROAD_STEPS_UNAVAILABLE。",
  request: {
    body: {
      content: { "application/json": { schema: NavInstructionsRequestSchema } },
      required: true,
    },
  },
  responses: {
    200: {
      description: "逐步指引陣列（含起始方位角與警告）",
      content: {
        "application/json": { schema: NavInstructionsResponseSchema },
      },
    },
    400: {
      description: "route.legs 為空或含未支援的 leg 型別（例如 FERRY）",
      content: { "application/json": { schema: NavErrorResponseSchema } },
    },
    500: {
      description: "伺服器錯誤",
      content: { "application/json": { schema: NavErrorResponseSchema } },
    },
  },
});
