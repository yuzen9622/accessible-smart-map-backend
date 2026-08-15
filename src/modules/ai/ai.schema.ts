import { extendZodWithOpenApi } from "@asteasolutions/zod-to-openapi";
import { z } from "zod";
import { registry } from "../../openapi/registry";
import { RouteIntentSchema } from "../../schemas/route-intent.schema";

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
  })
  .openapi("ChatMessage");

export const AgentChatRequestSchema = z
  .object({
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
    `無障礙導航 AI 對話代理。後端擔任 **Agent Orchestrator**，負責工具呼叫迴圈：\n\n` +
    `1. 收到使用者訊息後，後端以 OpenAI SDK 呼叫 LLM\n` +
    `2. 若模型要求呼叫工具（planAccessibleRoute、findA11yPlaces 等），後端在本地執行工具並將結果送回模型\n` +
    `3. 重複直到模型生成最終文字回答\n\n` +
    `**stream: true** — 回應為 \`text/event-stream\` SSE 流，包含四種事件類型：\n` +
    `- \`event: tool_call\` — 工具開始執行通知 \`{ name, arguments }\`\n` +
    `- \`event: tool_result\` — 工具執行結果 \`{ name, result }\`\n` +
    `- \`data: {...}\` (message 事件) — OpenAI 格式文字 delta chunks\n` +
    `- \`data: [DONE]\` — 串流結束\n` +
    `- \`event: error\` — 串流過程中發生錯誤 \`{ code: 500, message: string }\`；之後仍會發送 \`data: [DONE]\`\n\n` +
    `**stream: false** — 回應為標準 JSON（ApiResponse 格式）`,
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
              "SSE 串流。每筆 data 為 OpenAI ChatCompletionChunk JSON；工具事件另以 event: tool_call / tool_result 發送",
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
