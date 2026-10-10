import { z } from "zod";
import { extendZodWithOpenApi } from "@asteasolutions/zod-to-openapi";
import { registry } from "../../openapi/registry";

extendZodWithOpenApi(z);

export const TargetSchema = z
  .object({
    targetType: z.enum(["review", "hazard_report"]),
    targetId: z
      .string()
      .regex(/^[a-f\d]{24}$/i)
      .transform((id) => id.toLowerCase()),
  })
  .strict();
export const Reasons = [
  "inappropriate_image",
  "harassment",
  "personal_information",
  "spam",
  "misinformation",
  "other",
] as const;
export const ReportSchema = TargetSchema.extend({
  reason: z.enum(Reasons),
  details: z.string().trim().max(1000).default(""),
  language: z.enum(["zh-TW", "en"]).default("zh-TW"),
}).refine((v) => v.reason !== "other" || v.details.length > 0, {
  path: ["details"],
  message: "Details required for other",
});
export const IdSchema = z.object({ id: z.string().regex(/^[a-f\d]{24}$/i) });
export const DecisionSchema = z
  .object({
    requestId: z.string().uuid(),
    action: z.enum([
      "dismiss",
      "hide",
      "restore",
      "restrict_author",
      "unrestrict_author",
    ]),
    note: z.string().trim().min(1).max(1000),
  })
  .strict();
export type TargetInput = z.infer<typeof TargetSchema>;
export type ReportInput = z.infer<typeof ReportSchema>;
export type DecisionInput = z.infer<typeof DecisionSchema>;

export const CasesQuerySchema = z
  .object({
    cursor: z
      .string()
      .regex(/^[a-f\d]{24}$/i)
      .optional(),
  })
  .strict();

const Admission = z
  .object({
    state: z.enum(["pending", "admitted", "rejected"]),
    hour: z.number(),
    reason: z.string().optional(),
    history: z.array(
      z.object({
        state: z.string(),
        hour: z.number(),
        at: z.string(),
        reason: z.string().optional(),
      }),
    ),
  })
  .optional();
const Receipt = z.object({
  caseNumber: z.string(),
  receivedAt: z.string(),
  confirmationEmail: z.enum(["queued", "unavailable"]),
  duplicate: z.boolean(),
});
const BlockList = z.object({
  items: z.array(
    z.object({
      blockId: z.string(),
      label: z.enum(["review", "hazard_report"]),
      createdAt: z.string(),
    }),
  ),
});
const Envelope = (data: z.ZodType) =>
  z.object({
    ok: z.boolean(),
    status: z.string(),
    code: z.number(),
    message: z.string(),
    data,
  });
const routes = [
  {
    method: "post" as const,
    path: "/content-reports",
    summary: "提交內容檢舉並排程團隊／使用者確認信",
    body: ReportSchema,
    output: Receipt,
  },
  {
    method: "get" as const,
    path: "/user/blocks",
    summary: "自己的封鎖名單（不透明編號與中性標籤）",
    output: BlockList,
  },
  {
    method: "put" as const,
    path: "/user/blocks",
    summary: "封鎖指定內容作者（冪等）",
    body: TargetSchema,
    output: z.null(),
  },
  {
    method: "delete" as const,
    path: "/user/blocks/{id}",
    summary: "依封鎖編號解除自己的封鎖（冪等）",
    params: IdSchema,
    output: z.null(),
  },
  {
    method: "get" as const,
    path: "/content-reports",
    summary: "管理者：案件與寄信狀態，50 筆游標分頁",
    query: CasesQuerySchema,
    output: z.object({
      items: z.array(
        z.object({
          caseNumber: z.string(),
          status: z.string(),
          reason: z.string(),
          receivedAt: z.string(),
          admission: Admission,
          pendingDecisions: z.number(),
          delivery: z.object({ team: z.string(), reporter: z.string() }),
        }),
      ),
      nextCursor: z.string().nullable(),
    }),
  },
  {
    method: "get" as const,
    path: "/content-reports/{id}",
    summary: "管理者：檢視案件必要證據與操作紀錄",
    params: IdSchema,
    output: z.object({
      caseNumber: z.string(),
      targetType: z.string(),
      targetId: z.string(),
      reason: z.string(),
      details: z.string(),
      snapshot: z.string(),
      status: z.string(),
      receivedAt: z.string(),
      delivery: z.object({ team: z.string(), reporter: z.string() }),
      admission: Admission,
      decisions: z.array(
        z.object({
          requestId: z.string(),
          actorId: z.string(),
          action: z.string(),
          note: z.string(),
          at: z.string(),
          state: z
            .enum(["pending", "applied", "superseded", "failed"])
            .optional(),
          expectedVersion: z.number().optional(),
          completedAt: z.string().optional(),
          reason: z.string().optional(),
          attempts: z.number().optional(),
          nextAttemptAt: z.string().optional(),
          receiptCleanupPending: z.boolean().optional(),
        }),
      ),
    }),
  },
  {
    method: "post" as const,
    path: "/content-reports/{id}/decision",
    summary: "管理者：可恢復處分與稽核（支援 standalone MongoDB）",
    params: IdSchema,
    body: DecisionSchema,
    output: z.null(),
  },
];
for (const route of routes)
  registry.registerPath({
    method: route.method,
    path: route.path,
    tags: ["Content Safety"],
    summary: route.summary,
    security: [{ bearerAuth: [] }],
    request: {
      ...("params" in route ? { params: route.params } : {}),
      ...("query" in route ? { query: route.query } : {}),
      ...("body" in route && route.body
        ? {
            body: {
              required: true,
              content: { "application/json": { schema: route.body } },
            },
          }
        : {}),
    },
    responses: {
      200: {
        description: "成功；確認信 queued 表示已排程，不保證送達信箱",
        content: { "application/json": { schema: Envelope(route.output) } },
      },
      400: {
        description:
          "輸入錯誤、自我檢舉／封鎖、無可封鎖帳號或重用不同內容的 requestId、處分版本已被新決定取代",
      },
      401: { description: "Access token 過期" },
      403: { description: "未登入、失效 session 或非管理者" },
      404: { description: "內容不可見或案件不存在" },
      429: { description: "限流；每帳號每小時最多 20 個新案件" },
      503: {
        description:
          "處理待恢復或容量已達上限；處分須沿用相同 requestId 重試並查案件狀態。未回報完成。",
      },
      500: { description: "儲存失敗，未回報受理／處分成功" },
    },
  });
