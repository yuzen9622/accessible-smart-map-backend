import { extendZodWithOpenApi } from "@asteasolutions/zod-to-openapi";
import { z } from "zod";
import { VALIDATION_CODES } from "../constants/validation";

extendZodWithOpenApi(z);

export const ValidationIssueSchema = z
  .object({
    path: z.string(),
    message: z.string().openapi({
      description: "人類可讀的相容備援；前端優先使用 code 與 params。",
    }),
    code: z.enum(VALIDATION_CODES),
    params: z
      .record(z.string(), z.union([z.string(), z.number(), z.boolean()]))
      .optional()
      .openapi({
        description:
          "白名單結構限制：minimum、maximum、inclusive、type、expected、format、divisor；不含輸入值。",
      }),
  })
  .openapi("ValidationIssue");

const errorEnvelope = {
  ok: z.literal(false),
  status: z.literal("error"),
  code: z.number().openapi({ description: "HTTP 狀態碼；不是業務錯誤代碼。" }),
  message: z.string(),
};

export const ValidationErrorResponseSchema = z
  .object({
    ...errorEnvelope,
    data: z.object({
      reason: z.literal("VALIDATION_FAILED"),
      errors: z.array(ValidationIssueSchema),
    }),
  })
  .openapi("ValidationErrorResponse");

export const ApiErrorResponseSchema = z
  .object({
    ...errorEnvelope,
    data: z.object({ reason: z.string() }).passthrough(),
  })
  .openapi("ReasonErrorResponse");
