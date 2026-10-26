import { extendZodWithOpenApi } from "@asteasolutions/zod-to-openapi";
import { z } from "zod";
import { DEFAULT_LANG, SUPPORTED_LANGS } from "../../types/lang";
import { registry } from "../../openapi/registry";
import { NavInstructionsDataSchema } from "../../schemas/nav-instructions-data.schema";
import {
  ApiErrorResponseSchema,
  ValidationErrorResponseSchema,
} from "../../schemas/api-error.schema";

extendZodWithOpenApi(z);

export const NavInstructionsRequestSchema = z
  .object({
    routeToken: z.string().trim().min(1).max(256).openapi({
      description:
        "由 /accessible-route 回傳、最多30分鐘有效的 routeToken；導航指引只採用伺服器保存且完整性驗證通過的路線，不接受前端回傳整包 route。含步行時即時查證ACTIVE圖與來源資格，不因快取TTL沿用已退役路線；舊格式、損壞或資格失效須重新規劃。",
      example: "M2F1...short-lived-capability",
    }),
    userHeading: z.number().min(0).max(359).optional().openapi({
      description:
        "使用者當前朝向（度，正北 = 0，順時針），由陀螺儀取得。提供時後端填入 relativeDirection；省略則為 null。",
      example: 45,
    }),
    language: z.enum(SUPPORTED_LANGS).default(DEFAULT_LANG).openapi({
      description:
        "指引文字與相對方向的語言：zh-TW 或 en，預設 zh-TW。路名、站名等專有名稱保留路線資料原文。",
    }),
  })
  .strict()
  .openapi("NavInstructionsRequest");

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
  .union([ValidationErrorResponseSchema, ApiErrorResponseSchema])
  .openapi("NavInstructionsErrorResponse");

registry.registerPath({
  method: "post",
  path: "/a11y/route/instructions",
  tags: ["Accessibility"],
  summary: "路線逐步導航指引產生",
  description:
    "以 /accessible-route 回傳的 routeToken 讀取完整性及來源資格仍有效的伺服器路線，轉為可語音朗讀的逐步指引；不接受前端傳入完整 route。所有 WALK（包含大眾運輸接駁）皆依來源合格的全國PostGIS/CSR圖選定邊與設施產生指引，不以未驗證的OTP2或Valhalla步行替代。保留圖內實際選中的電梯、階梯、手扶梯、電動步道、閘門及進出站語義，未知資料不推定安全。stairs表示該段含階梯，不代表整段distanceM都是階梯；輪椅階梯備援仍保留需協助警告，不宣稱可獨立通行。steepSlope標示較陡坡段；已合格路線若缺少steps仍回200概略指引，WALK同時保留WALK_STEPS_UNAVAILABLE與legacy ORS_STEPS_UNAVAILABLE，車行回ROAD_STEPS_UNAVAILABLE。另回傳的場域venueLeg不屬此戶外導航指引。",
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
      description:
        "routeToken缺漏、無效、過期、舊格式或保存內容損壞；步行圖已退役／來源資格無法即時查證；或路線含未支援的leg型別（例如FERRY）。須重新規劃，不信任缺少必經WALK的快取。",
      content: { "application/json": { schema: NavErrorResponseSchema } },
    },
    500: {
      description: "伺服器錯誤",
      content: { "application/json": { schema: NavErrorResponseSchema } },
    },
  },
});
