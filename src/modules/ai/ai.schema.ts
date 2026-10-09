import { extendZodWithOpenApi } from "@asteasolutions/zod-to-openapi";
import { z } from "zod";
import { registry } from "../../openapi/registry";
import { AgentLanguageSchema } from "../../schemas/agent-language.schema";
import { RouteIntentSchema } from "../../schemas/route-intent.schema";
import { ToolSummarySchema } from "../agent/conversation-context";
import {
  AccessibleRouteDataSchema,
  AccessibleRouteSchema,
} from "../accessible-route/accessible-route.schema";
import {
  RouteConversationFields,
  RoutingPreferencesSchema,
} from "../../schemas/agent-route.schema";

extendZodWithOpenApi(z);

export const IntentBodySchema = z
  .object({
    query: z.string().min(1).openapi({
      description: "自然語言的交通查詢",
      example: "我要從台中火車站坐到高鐵新竹站，我坐輪椅",
    }),
  })
  .strict();

const IntentResponseSchema = z
  .object({
    ok: z.boolean().openapi({ example: true }),
    status: z.enum(["success", "error"]).openapi({ example: "success" }),
    code: z.number().openapi({ example: 200 }),
    message: z.string().openapi({ example: "OK" }),
    data: RouteIntentSchema.optional(),
    accessToken: z.string().optional(),
  })
  .openapi("IntentResponse");

const IntentErrorSchema = z
  .object({
    ok: z.boolean().openapi({ example: false }),
    status: z.enum(["success", "error"]).openapi({ example: "error" }),
    code: z.number().openapi({ example: 400 }),
    message: z
      .string()
      .openapi({ example: "無法解析您的查詢，請改用『從 A 到 B』的描述方式" }),
    data: z.unknown().optional(),
  })
  .openapi("IntentErrorResponse");

export const ExplainBodySchema = z
  .object({
    route: z
      .object({
        routeName: z.string().optional(),
        totalMinutes: z.number().optional(),
        transferCount: z.number().optional(),
        legs: z.array(z.record(z.string(), z.unknown())).optional(),
      })
      .passthrough()
      .openapi({
        description:
          "由 POST /a11y/accessible-route 回傳的 AccessibleRoute 物件",
      }),
    mode: z
      .enum(["wheelchair", "elderly", "visual_impaired", "normal"])
      .default("normal")
      .openapi({ example: "wheelchair" }),
    language: z.enum(["zh-TW", "en"]).default("zh-TW").openapi({
      example: "zh-TW",
    }),
  })
  .strict();

const RouteExplanationSchema = z
  .object({
    summary: z.string().openapi({
      example: "建議搭乘台鐵轉高鐵，全程均有電梯，約 95 分鐘抵達",
    }),
    accessibilityHighlights: z.array(z.string()).openapi({
      example: ["台中站設有無障礙電梯通往月台", "高鐵新竹站 5 號出口有坡道"],
    }),
    warnings: z.array(z.string()).openapi({ example: [] }),
    alternatives: z.string().nullable().openapi({
      example: null,
      description: "備援建議；無警告時為 null",
    }),
  })
  .openapi("RouteExplanation");

const ExplainResponseSchema = z
  .object({
    ok: z.boolean().openapi({ example: true }),
    status: z.enum(["success", "error"]).openapi({ example: "success" }),
    code: z.number().openapi({ example: 200 }),
    message: z.string().openapi({ example: "OK" }),
    data: RouteExplanationSchema.optional(),
    accessToken: z.string().optional(),
  })
  .openapi("ExplainResponse");

registry.registerPath({
  method: "post",
  path: "/ai/explain",
  tags: ["AI"],
  summary: "路線說明生成",
  description: "為規劃路線生成可讀說明：摘要、無障礙重點、警告與備援建議。",
  request: {
    body: {
      content: { "application/json": { schema: ExplainBodySchema } },
      required: true,
    },
  },
  responses: {
    200: {
      description: "生成的路線說明",
      content: { "application/json": { schema: ExplainResponseSchema } },
    },
    500: {
      description: "伺服器錯誤或模型未產生可用說明",
      content: { "application/json": { schema: IntentErrorSchema } },
    },
  },
});

export const ToolCallSchema = z
  .object({
    id: z.string(),
    type: z.literal("function"),
    function: z.object({
      name: z.string(),
      arguments: z.string().openapi({ description: "JSON 字串格式的工具參數" }),
    }),
  })
  .openapi("ToolCall");

export const ChatMessageSchema = z
  .object({
    role: z.enum(["system", "user", "assistant", "tool"]),
    content: z.string().nullable().optional(),
    name: z
      .string()
      .optional()
      .openapi({ description: "role 為 tool 時必填，對應工具名稱" }),
    tool_calls: z.array(ToolCallSchema).optional(),
    tool_call_id: z
      .string()
      .optional()
      .openapi({ description: "role 為 tool 時必填" }),
    tool_summaries: z.array(ToolSummarySchema).max(8).optional().openapi({
      description:
        "assistant 訊息這一輪工具結果的摘要（取自 tool_result 事件的 summary），切換文字／語音時讓模型接得上「剛剛那個」",
    }),
  })
  .openapi("ChatMessage");

export const AgentChatRequestSchema = z
  .object({
    language: AgentLanguageSchema.optional().openapi({
      description:
        "前端目前的介面語言：zh-TW（臺灣繁體中文）或 en（英文）。每次請求重新傳入；省略時沿用依對話判斷語言的行為。",
      example: "en",
    }),
    routeContractVersion: RouteConversationFields.routeContractVersion.openapi({
      description: "AI 路線契約版本，目前為 1；成功工具結果回傳相同版本。",
    }),
    routeContext: RouteConversationFields.routeContext.openapi({
      description:
        "目前查看的伺服器路線 token；null 明確清除，省略相容舊客戶端。無效 token 不會觸發重新規劃。",
    }),
    routingPreferences: RouteConversationFields.routingPreferences.openapi({
      description:
        "表單與個人設定預設；已選路線的 canonical 條件優先，本輪明示修改才建立新規劃。",
    }),
    messages: z
      .array(ChatMessageSchema)
      .min(1)
      .openapi({
        description: "對話歷程，格式與 OpenAI Chat Completions API 一致",
        example: [
          { role: "user", content: "我坐輪椅，從台北車站到台北101怎麼去？" },
        ],
      }),
    stream: z
      .boolean()
      .optional()
      .default(false)
      .openapi({ description: "是否啟用 SSE 串流回應", example: true }),
    temperature: z
      .number()
      .min(0)
      .max(2)
      .optional()
      .default(0.2)
      .openapi({ example: 0.2 }),
    userLocation: z
      .object({
        latitude: z.number().openapi({ example: 25.0478 }),
        longitude: z.number().openapi({ example: 121.517 }),
      })
      .optional()
      .openapi({
        description: "使用者目前位置，供路線規劃與無障礙設施查詢使用",
      }),
  })
  .openapi("AgentChatRequest");

export const MemoryCategorySchema = z
  .enum(["preference", "place", "habit", "context"])
  .openapi("MemoryCategory");

export const MemorySensitivitySchema = z
  .enum(["low", "medium", "high"])
  .openapi("MemorySensitivity");

export const MemoryIdParamsSchema = z
  .object({
    id: z
      .string()
      .regex(/^[a-f\d]{24}$/i)
      .openapi({
        description: "MongoDB ObjectId",
        example: "665f1c2b9a0b4d0012a34567",
      }),
  })
  .strict()
  .openapi("MemoryIdParams");

export const MemoryListQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(100).optional().default(100),
  })
  .strict()
  .openapi("MemoryListQuery");

export const CreateMemoryBodySchema = z
  .object({
    content: z.string().min(1).max(240).openapi({
      example: "使用者偏好少走樓梯，路線規劃時優先找電梯。",
    }),
    category: MemoryCategorySchema,
    sensitivity: MemorySensitivitySchema.optional(),
    expiresAt: z.string().datetime().optional(),
  })
  .strict()
  .openapi("CreateMemoryBody");

export const UpdateMemoryBodySchema = z
  .object({
    content: z.string().min(1).max(240).optional(),
    category: MemoryCategorySchema.optional(),
    sensitivity: MemorySensitivitySchema.optional(),
    expiresAt: z.string().datetime().nullable().optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, {
    message: "至少提供一個要更新的欄位",
  })
  .openapi("UpdateMemoryBody");

export const MemorySettingsBodySchema = z
  .object({
    memoryEnabled: z.boolean(),
  })
  .strict()
  .openapi("MemorySettingsBody");

const MemorySchema = z
  .object({
    id: z.string(),
    content: z.string(),
    category: MemoryCategorySchema,
    sensitivity: MemorySensitivitySchema,
    source: z.enum(["explicit_user", "agent_suggested", "distilled"]),
    createdAt: z.string(),
    updatedAt: z.string(),
    expiresAt: z.string().nullable(),
  })
  .openapi("UserMemory");

const MemoryListResponseSchema = z
  .object({
    ok: z.boolean().openapi({ example: true }),
    status: z.enum(["success", "error"]).openapi({ example: "success" }),
    code: z.number().openapi({ example: 200 }),
    message: z.string().openapi({ example: "取得記憶列表成功" }),
    data: z.object({ memories: z.array(MemorySchema) }),
  })
  .openapi("MemoryListResponse");

const MemoryResponseSchema = z
  .object({
    ok: z.boolean().openapi({ example: true }),
    status: z.enum(["success", "error"]).openapi({ example: "success" }),
    code: z.number().openapi({ example: 200 }),
    message: z.string().openapi({ example: "記憶已更新" }),
    data: z.object({ memory: MemorySchema }),
  })
  .openapi("MemoryResponse");

const MemorySettingsResponseSchema = z
  .object({
    ok: z.boolean().openapi({ example: true }),
    status: z.enum(["success", "error"]).openapi({ example: "success" }),
    code: z.number().openapi({ example: 200 }),
    message: z.string().openapi({ example: "取得記憶設定成功" }),
    data: z.object({ memoryEnabled: z.boolean() }),
  })
  .openapi("MemorySettingsResponse");

registry.registerPath({
  method: "get",
  path: "/ai/memories",
  tags: ["AI"],
  summary: "列出目前使用者的 AI 記憶",
  request: { query: MemoryListQuerySchema },
  responses: {
    200: {
      description: "使用者記憶列表",
      content: { "application/json": { schema: MemoryListResponseSchema } },
    },
  },
});

registry.registerPath({
  method: "post",
  path: "/ai/memories",
  tags: ["AI"],
  summary: "手動新增一筆 AI 記憶",
  request: {
    body: {
      content: { "application/json": { schema: CreateMemoryBodySchema } },
      required: true,
    },
  },
  responses: {
    201: {
      description: "已建立的記憶",
      content: { "application/json": { schema: MemoryResponseSchema } },
    },
  },
});

registry.registerPath({
  method: "patch",
  path: "/ai/memories/{id}",
  tags: ["AI"],
  summary: "修改指定 AI 記憶",
  request: {
    params: MemoryIdParamsSchema,
    body: {
      content: { "application/json": { schema: UpdateMemoryBodySchema } },
      required: true,
    },
  },
  responses: {
    200: {
      description: "已更新的記憶",
      content: { "application/json": { schema: MemoryResponseSchema } },
    },
    404: { description: "找不到記憶或無權存取" },
  },
});

registry.registerPath({
  method: "get",
  path: "/ai/memories/settings",
  tags: ["AI"],
  summary: "取得 AI 記憶設定",
  responses: {
    200: {
      description: "記憶設定",
      content: { "application/json": { schema: MemorySettingsResponseSchema } },
    },
  },
});

registry.registerPath({
  method: "patch",
  path: "/ai/memories/settings",
  tags: ["AI"],
  summary: "更新 AI 記憶設定",
  request: {
    body: {
      content: { "application/json": { schema: MemorySettingsBodySchema } },
      required: true,
    },
  },
  responses: {
    200: {
      description: "已更新的記憶設定",
      content: { "application/json": { schema: MemorySettingsResponseSchema } },
    },
  },
});

/** Shape of successful planAccessibleRoute results carried by SSE and WS. */
export const AiRoutePlanToolResultSchema = registry.register(
  "AiRoutePlanToolResult",
  AccessibleRouteDataSchema.extend({
    ok: z.literal(true),
    routeContractVersion: z.literal(1),
    planId: z.string().uuid(),
    selectedRouteId: z.string().min(1),
    origin: AccessibleRouteDataSchema.shape.origin.extend({ name: z.string() }),
    destination: AccessibleRouteDataSchema.shape.destination.extend({
      name: z.string(),
    }),
    mode: RoutingPreferencesSchema.shape.mode.unwrap(),
    routes: z.array(AccessibleRouteSchema).min(1),
    effectivePreferences: z
      .object({
        mode: RoutingPreferencesSchema.shape.mode.unwrap(),
        travelMode: z.enum(["transit", "walk", "drive", "motorcycle"]),
        transitPreference:
          RoutingPreferencesSchema.shape.transitPreference.unwrap(),
        maxTransfers: z.number().int().nonnegative(),
        avoidStairs: z.boolean(),
        requireElevator: z.boolean(),
        departureTime: RoutingPreferencesSchema.shape.departureTime,
        needsAccessibleToilet: z.boolean(),
        needsHandrail: z.boolean(),
        maxSlopePercent: z.number().optional(),
      })
      .strict(),
  }),
);

const AgentChatResponseSchema = z
  .object({
    ok: z.boolean().openapi({ example: true }),
    status: z.enum(["success", "error"]).openapi({ example: "success" }),
    code: z.number().openapi({ example: 200 }),
    message: z.string().openapi({ example: "OK" }),
    data: z
      .object({
        id: z.string(),
        object: z.string(),
        created: z.number(),
        model: z.string(),
        choices: z.array(z.record(z.string(), z.unknown())),
        usage: z.record(z.string(), z.unknown()).optional(),
      })
      .optional(),
  })
  .openapi("AgentChatResponse");

registry.registerPath({
  method: "post",
  path: "/ai/chat",
  tags: ["AI"],
  summary: "AI 對話代理（SSE 串流）",
  description:
    `無障礙導航 AI 對話代理，以 Gemini Interactions API 執行工具迴圈。路線工具只規劃一次：前端取得完整候選，模型取得同一份路線的摘要。\n\n` +
    `routeContext 以伺服器 routeToken 同步目前選擇；getNavInstructions 讀取此路線，不重新規劃。成功路線結果見 AiRoutePlanToolResult schema；無 token 時仍可顯示，不能自動再規劃以補 token。\n\n` +
    `**stream: true** — text/event-stream，包含五種事件：\n` +
    `- event: tool_call — { name, args, callId }\n` +
    `- event: tool_result — { name, result, summary, callId }；callId 對應同次 tool_call，result 是完整前端資料\n` +
    `- event: token — { text }；工具回合的暫時文字不輸出，回答回合完成後按 chunk 送出\n` +
    `- event: done — data 是字串 done（不是 JSON 或 [DONE]）\n` +
    `- event: error — { code, message }；連線仍有效時補 done\n\n` +
    `**stream: false** — 標準 ApiResponse 包文字 chat.completion，不含工具結果。`,
  request: {
    body: {
      content: { "application/json": { schema: AgentChatRequestSchema } },
      required: true,
    },
  },
  responses: {
    200: {
      description: "SSE stream (stream=true) 或 JSON (stream=false)",
      content: {
        "application/json": { schema: AgentChatResponseSchema },
        "text/event-stream": {
          schema: z.string().openapi({
            description:
              "SSE named events: token、tool_call、tool_result、error 的 data 為 JSON；done 的 data 為字串 done。",
          }),
        },
      },
    },
    400: {
      description: "請求參數驗證失敗",
      content: { "application/json": { schema: IntentErrorSchema } },
    },
    500: {
      description: "伺服器錯誤",
      content: { "application/json": { schema: IntentErrorSchema } },
    },
  },
});

registry.registerPath({
  method: "post",
  path: "/ai/intent",
  tags: ["AI"],
  summary: "自然語言意圖解析",
  description:
    "將自由形式交通查詢解析為結構化 RouteIntent：起點、終點、模式、出發時間與偏好。",
  request: {
    body: {
      content: { "application/json": { schema: IntentBodySchema } },
      required: true,
    },
  },
  responses: {
    200: {
      description: "解析後的 RouteIntent",
      content: { "application/json": { schema: IntentResponseSchema } },
    },
    400: {
      description: "查詢無法解析為路線意圖",
      content: { "application/json": { schema: IntentErrorSchema } },
    },
    500: {
      description: "伺服器錯誤",
      content: { "application/json": { schema: IntentErrorSchema } },
    },
  },
});
