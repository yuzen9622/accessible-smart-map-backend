import { describe, it, expect, vi, beforeAll } from "vitest";
import jwt from "jsonwebtoken";
import type { Response } from "express";
import { REFRESH_TOKEN_TTL_MS, createRefreshToken } from "./jwt";
import { sendResponse } from "./lib";
import { ResponseCode } from "../types/code";
import type { IUser } from "../types";

const user = { _id: "u1", name: "n", email: "e@x.com" } as unknown as IUser;

function mockRes() {
  const res = {
    cookie: vi.fn(),
    status: vi.fn(),
    json: vi.fn(),
  };
  res.status.mockReturnValue(res);
  return res;
}

describe("refresh token TTL", () => {
  beforeAll(() => {
    process.env.JWT_REFRESH_SECRET = "test-refresh-secret";
  });

  it("signs refresh tokens that expire after REFRESH_TOKEN_TTL_MS", () => {
    const token = createRefreshToken(user, "sid-1", "jti-1");
    const decoded = jwt.decode(token) as { iat: number; exp: number };
    expect((decoded.exp - decoded.iat) * 1000).toBe(REFRESH_TOKEN_TTL_MS);
  });

  it("sets the web refresh cookie maxAge to the token lifetime", () => {
    const res = mockRes();
    const token = createRefreshToken(user, "sid-1", "jti-1");
    sendResponse(
      res as unknown as Response,
      true,
      "success",
      ResponseCode.OK,
      "ok",
      undefined,
      "access",
      token,
    );
    expect(res.cookie).toHaveBeenCalledWith(
      "refreshToken",
      token,
      expect.objectContaining({ maxAge: REFRESH_TOKEN_TTL_MS }),
    );
  });

  it("returns the same token in the body for mobile without a cookie", () => {
    const res = mockRes();
    const token = createRefreshToken(user, "sid-1", "jti-1");
    sendResponse(
      res as unknown as Response,
      true,
      "success",
      ResponseCode.OK,
      "ok",
      undefined,
      "access",
      token,
      "mobile",
    );
    expect(res.cookie).not.toHaveBeenCalled();
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ refreshToken: token }),
    );
  });
});
