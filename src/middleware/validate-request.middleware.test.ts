import express from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { validateRequest } from "./validate-request.middleware";

function appFor(body: z.ZodType) {
  const app = express();
  app.use(express.json());
  app.post("/check", validateRequest({ body }), (req, res) => {
    res.json(req.validated?.body);
  });
  return app;
}

describe("structured validation errors", () => {
  it("keeps the legacy envelope and adds a code with safe constraint parameters", async () => {
    const app = appFor(
      z.object({ password: z.string().min(8, "密碼至少 8 個字元") }),
    );
    const res = await request(app).post("/check").send({ password: "secret" });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({
      ok: false,
      code: 400,
      message: "Invalid request.",
      data: {
        reason: "VALIDATION_FAILED",
        errors: [
          {
            path: "password",
            message: "密碼至少 8 個字元",
            code: "VALIDATION_TOO_SMALL",
            params: { minimum: 8, inclusive: true, type: "string" },
          },
        ],
      },
    });
    expect(JSON.stringify(res.body)).not.toContain("secret");
    expect(res.body.data.errors[0]).not.toHaveProperty("input");
  });

  it("reports different failure categories without echoing rejected values", async () => {
    const schema = z
      .object({
        count: z.number().max(2),
        email: z.string().email(),
        language: z.enum(["en", "zh-TW"]),
      })
      .strict();
    const res = await request(appFor(schema)).post("/check").send({
      count: 5,
      email: "private-invalid-email",
      language: "secret-invalid-language",
      extra: "private-value",
    });
    expect(res.body.data.errors.map((e: { code: string }) => e.code)).toEqual([
      "VALIDATION_TOO_BIG",
      "VALIDATION_INVALID_FORMAT",
      "VALIDATION_INVALID_VALUE",
      "VALIDATION_UNRECOGNIZED_KEYS",
    ]);
    expect(res.body.data.errors[0].params.maximum).toBe(2);
    expect(res.body.data.errors[1].params.format).toBe("email");
    for (const value of [
      "private-invalid-email",
      "secret-invalid-language",
      "private-value",
    ]) {
      expect(JSON.stringify(res.body)).not.toContain(value);
    }
  });

  it("retains a custom error as a generic actionable category without serializing custom params", async () => {
    const schema = z
      .object({ token: z.string() })
      .superRefine((_value, ctx) => {
        ctx.addIssue({
          code: "custom",
          path: ["token"],
          message: "Invalid token",
          params: { token: "do-not-leak" },
        });
      });
    const res = await request(appFor(schema))
      .post("/check")
      .send({ token: "private-token" });
    expect(res.body.data.errors).toEqual([
      { path: "token", message: "Invalid token", code: "VALIDATION_CUSTOM" },
    ]);
  });

  it("preserves parsed values on valid requests", async () => {
    const res = await request(
      appFor(z.object({ count: z.coerce.number().default(1) })),
    )
      .post("/check")
      .send({ count: "2" });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ count: 2 });
  });
});
