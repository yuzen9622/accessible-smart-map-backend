import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";

vi.mock("./user.service", () => ({
  getConfig: vi.fn(),
  updateConfig: vi.fn(),
}));

import {
  buildTestApp,
  buildAuthorizationHeader,
} from "../../../tests/helpers/test-helpers";
import { stubAuthUserLookup } from "../../../tests/helpers/real-auth";
import * as userService from "./user.service";
import { ResponseCode } from "../../types/code";

const app = buildTestApp();
const BASE = "/api/v1/user";
const auth = buildAuthorizationHeader();

const getConfig = vi.mocked(userService.getConfig);
const updateConfig = vi.mocked(userService.updateConfig);

beforeEach(() => {
  vi.resetAllMocks();
  // Real auth path: the JWT is verified for real; only the lowest-level DB
  // seam the middleware reads (User.findById) is stubbed.
  stubAuthUserLookup();
});

/**
 * Regression guard for the config IDOR: the endpoints must derive the target
 * account from the JWT (`req.auth.userId`), never from a body-supplied
 * `user_id`. The strict schemas reject any client-supplied `user_id`, and the
 * controllers pass the authenticated id to the service layer.
 */
describe("GET/POST /user/config (IDOR guard)", () => {
  it("rejects a body-supplied user_id on read", async () => {
    const res = await request(app)
      .post(`${BASE}/config`)
      .set("Authorization", auth)
      .send({ user_id: "victim-account-id" });

    expect(res.status).toBe(ResponseCode.INVALID_INPUT);
    expect(getConfig).not.toHaveBeenCalled();
  });

  it("reads the config of the authenticated user, not of a supplied id", async () => {
    getConfig.mockResolvedValue({
      user_id: "test-user-id",
      language: "zh-TW",
    } as any);

    const res = await request(app)
      .post(`${BASE}/config`)
      .set("Authorization", auth)
      .send({});

    expect(res.status).toBe(ResponseCode.OK);
    expect(getConfig).toHaveBeenCalledWith("test-user-id");
    expect(getConfig).not.toHaveBeenCalledWith("victim-account-id");
  });

  it("rejects a body-supplied user_id on update", async () => {
    const res = await request(app)
      .post(`${BASE}/config/update`)
      .set("Authorization", auth)
      .send({ user_id: "victim-account-id", language: "en" });

    expect(res.status).toBe(ResponseCode.INVALID_INPUT);
    expect(updateConfig).not.toHaveBeenCalled();
  });

  it("updates the config of the authenticated user, not of a supplied id", async () => {
    updateConfig.mockResolvedValue({
      user_id: "test-user-id",
      language: "en",
    } as any);

    const res = await request(app)
      .post(`${BASE}/config/update`)
      .set("Authorization", auth)
      .send({ language: "en", darkMode: "dark" });

    expect(res.status).toBe(ResponseCode.OK);
    expect(updateConfig).toHaveBeenCalledWith("test-user-id", {
      language: "en",
      darkMode: "dark",
    });
    expect(updateConfig).not.toHaveBeenCalledWith(
      "victim-account-id",
      expect.anything(),
    );
  });
});
