import { extendZodWithOpenApi } from "@asteasolutions/zod-to-openapi";
import { z } from "zod";
import { registry } from "../../openapi/registry";
import { NavInstructionsDataSchema } from "../../schemas/nav-instructions-data.schema";

extendZodWithOpenApi(z);

export const NavInstructionsRequestSchema = z
  .object({
    routeToken: z.string().trim().min(1).max(256).openapi({
      description:
        "由 /accessible-route 回傳、30 分鐘內有效的 routeToken；導航指引一律以伺服器端保存的路線產生，不接受前端回傳整包 route。",
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
    "以 /accessible-route 回傳的 routeToken 取出伺服器端路線，轉為可語音朗讀的逐步指引；不再接受前端傳入完整 route。台北 CSR-primary 的純步行路線由圖上選定的邊與設施型別（電梯／手扶梯／電動步道／閘門／進出站）推導出 turn-by-turn steps，但不含路名；transit itinerary 的 WALK legs 與 CSR fallback 的 OTP2 步行仍可帶 OTP steps，OTP2 不可用後的 Valhalla 步行也支援相同輸出。步行指引以 stairs 標示該段含樓梯並在 text 加入定性提示，不代表整段 distanceM 都是樓梯；steepSlope 以同樣方式標示坡度較陡的段落。若缺少 steps 仍回傳 200 概略指引。WALK 過渡期同時回 WALK_STEPS_UNAVAILABLE 與 legacy ORS_STEPS_UNAVAILABLE，車行回 ROAD_STEPS_UNAVAILABLE。",
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
        "routeToken 缺漏、無效或已過期，或路線含未支援的 leg 型別（例如 FERRY）",
      content: { "application/json": { schema: NavErrorResponseSchema } },
    },
    500: {
      description: "伺服器錯誤",
      content: { "application/json": { schema: NavErrorResponseSchema } },
    },
  },
});
