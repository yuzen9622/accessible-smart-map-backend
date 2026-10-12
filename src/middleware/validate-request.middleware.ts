import type { NextFunction, Request, Response } from "express";
import type { ZodIssue, ZodType } from "zod";
import { VALIDATION_CODES } from "../constants/validation";
import { ResponseCode } from "../types/code";
import { sendResponse } from "../config/lib";

interface ValidateSchemas {
  body?: ZodType;
  query?: ZodType;
  params?: ZodType;
}

/** Only schema-owned scalar constraints are public; custom issue params are not. */
function publicIssue(issue: ZodIssue) {
  const code = Object.prototype.hasOwnProperty.call(
    VALIDATION_CODES,
    issue.code,
  )
    ? VALIDATION_CODES[issue.code as keyof typeof VALIDATION_CODES]
    : VALIDATION_CODES.invalid;
  const params: Record<string, string | number | boolean> = {};
  const bound = (value: number | bigint) =>
    typeof value === "bigint"
      ? String(value)
      : Number.isFinite(value)
        ? value
        : undefined;
  if (issue.code === "too_small" || issue.code === "too_big") {
    const key = issue.code === "too_small" ? "minimum" : "maximum";
    const value = bound(
      issue.code === "too_small" ? issue.minimum : issue.maximum,
    );
    if (value !== undefined) params[key] = value;
    params.inclusive = issue.inclusive ?? false;
    params.type = issue.origin;
  } else if (issue.code === "invalid_type") {
    params.expected = issue.expected;
  } else if (issue.code === "invalid_format") {
    params.format = issue.format;
  } else if (issue.code === "not_multiple_of") {
    const divisor = bound(issue.divisor);
    if (divisor !== undefined) params.divisor = divisor;
  }
  return {
    path: issue.path.join("."),
    message: issue.message,
    code,
    ...(Object.keys(params).length ? { params } : {}),
  };
}

export function validateRequest(schemas: ValidateSchemas) {
  return (req: Request, res: Response, next: NextFunction) => {
    const errors: ReturnType<typeof publicIssue>[] = [];
    const validated: Record<string, unknown> = {};

    const targets: [keyof ValidateSchemas, unknown][] = [
      ["body", req.body],
      ["query", req.query],
      ["params", req.params],
    ];

    for (const [key, value] of targets) {
      const schema = schemas[key];
      if (!schema) continue;
      const result = schema.safeParse(value);
      if (!result.success) {
        result.error.issues.forEach((issue) => {
          errors.push(publicIssue(issue));
        });
      } else {
        validated[key] = result.data;
      }
    }

    if (errors.length > 0) {
      return sendResponse(
        res,
        false,
        "error",
        ResponseCode.INVALID_INPUT,
        "Invalid request.",
        { reason: "VALIDATION_FAILED", errors },
      );
    }

    req.validated = validated;
    if ("body" in validated) req.body = validated.body;
    if ("query" in validated) {
      // Express 5: req.query is a prototype getter (parsed lazily from the URL)
      // and can no longer be assigned. Shadow it with an own property so
      // controllers keep reading the validated, coerced value from req.query.
      Object.defineProperty(req, "query", {
        value: validated.query,
        configurable: true,
        enumerable: true,
        writable: true,
      });
    }
    if ("params" in validated)
      req.params = validated.params as Request["params"];
    next();
  };
}
