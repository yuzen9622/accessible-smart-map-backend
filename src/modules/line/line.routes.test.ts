import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";

// Spread-actual so the real SignatureValidationFailed class is preserved
// (the route-level error handler relies on `instanceof`), overriding only the
// signature middleware to branch on a test header.
vi.mock("@line/bot-sdk", async (orig) => {
  const actual = (await orig()) as typeof import("@line/bot-sdk");
  return {
    ...actual,
    middleware: () => (req: any, _res: any, next: any) => {
      if (req.headers["x-line-signature"] !== "valid-sig") {
        return next(new actual.SignatureValidationFailed("signature validation failed"));
      }
      try {
        req.body = JSON.parse(Buffer.isBuffer(req.body) ? req.body.toString() : JSON.stringify(req.body));
      } catch {
        req.body = {};
      }
      next();
    },
  };
});

vi.mock("./line.service", () => ({
  getRoutePreview: vi.fn().mockResolvedValue({
    ok: true,
    httpCode: 200,
    message: "OK",
    data: { sessionId: "s1", routes: [] },
  }),
  handleEvents: vi.fn().mockResolvedValue(undefined),
}));

import { buildTestApp } from "../../../tests/helpers/test-helpers";
import * as service from "./line.service";
import { ResponseCode } from "../../types/code";

const app = buildTestApp();
const URL = "/api/v1/line/webhook";

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(service.getRoutePreview).mockResolvedValue({
    ok: true,
    httpCode: ResponseCode.OK,
    message: "OK",
    data: { sessionId: "s1", routes: [] },
  } as any);
  vi.mocked(service.handleEvents).mockResolvedValue(undefined);
});

describe("POST /line/webhook", () => {
  it("returns 401 when the signature is invalid (error handler, controller not reached)", async () => {
    const res = await request(app)
      .post(URL)
      .set("Content-Type", "application/json")
      .send(JSON.stringify({ events: [] }));
    expect(res.status).toBe(ResponseCode.UNAUTHORIZED);
    expect(vi.mocked(service.handleEvents)).not.toHaveBeenCalled();
  });

  it("acks 200 and delegates events to the service on a valid signature", async () => {
    const events = [{ type: "follow", replyToken: "r1", source: { type: "user", userId: "U1" } }];
    const res = await request(app)
      .post(URL)
      .set("Content-Type", "application/json")
      .set("x-line-signature", "valid-sig")
      .send(JSON.stringify({ events }));
    expect(res.status).toBe(200);
    expect(vi.mocked(service.handleEvents)).toHaveBeenCalledWith(events);
  });
});

describe("GET /line/route-preview", () => {
  it("returns 400 when sessionId is missing", async () => {
    const res = await request(app).get("/api/v1/line/route-preview");

    expect(res.status).toBe(ResponseCode.INVALID_INPUT);
    expect(vi.mocked(service.getRoutePreview)).not.toHaveBeenCalled();
  });

  it("delegates to the service and returns the route preview envelope", async () => {
    const res = await request(app).get("/api/v1/line/route-preview?sessionId=a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6");

    expect(res.status).toBe(ResponseCode.OK);
    expect(vi.mocked(service.getRoutePreview)).toHaveBeenCalledWith("a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6", undefined, undefined, undefined);
    expect(res.body).toMatchObject({
      ok: true,
      status: "success",
      code: ResponseCode.OK,
      message: "OK",
      data: { sessionId: "s1", routes: [] },
    });
  });

  it("passes service errors through the standard envelope", async () => {
    vi.mocked(service.getRoutePreview).mockResolvedValue({
      ok: false,
      httpCode: ResponseCode.NOT_FOUND,
      message: "找不到進行中的求救紀錄",
    } as any);

    const res = await request(app).get("/api/v1/line/route-preview?sessionId=f1f2f3f4f5f6f7f8f9f0f1f2f3f4f5f6");

    expect(res.status).toBe(ResponseCode.NOT_FOUND);
    expect(res.body).toMatchObject({
      ok: false,
      status: "error",
      code: ResponseCode.NOT_FOUND,
      message: "找不到進行中的求救紀錄",
    });
  });
});
