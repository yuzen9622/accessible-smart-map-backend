import { extendZodWithOpenApi } from "@asteasolutions/zod-to-openapi";
import { z } from "zod";

extendZodWithOpenApi(z);

/** Existing Places language aliases, without defaulting absent legacy requests. */
export const SourceLangQuerySchema = z
  .string()
  .regex(/^([Zz][Hh]|[Ee][Nn])(-[A-Za-z0-9]+)*$/, "lang 只接受 zh-TW 或 en")
  .optional()
  .openapi({
    example: "en",
    description:
      "顯示語言 zh-TW 或 en（接受 zh-*/en-* 標籤）；省略保留原行為。僅影響顯示欄位，原始名稱與 ID 不變；缺英文來源時保留原文。",
  });
