import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";

vi.mock("../../config/auth", async () => {
  const { createAuthModuleMock } =
    await import("../../../tests/helpers/auth-mock");
  return createAuthModuleMock();
});

vi.mock("./emergency-contact.service", () => ({
  listContacts: vi.fn(),
  createContact: vi.fn(),
  deleteContact: vi.fn(),
}));

import {
  buildTestApp,
  buildAuthorizationHeader,
} from "../../../tests/helpers/test-helpers";
import * as service from "./emergency-contact.service";
import { ResponseCode } from "../../types/code";
import { CONTACT_MSG, CONTACT_REASON } from "../../constants/messages";

const app = buildTestApp();
const URL = "/api/v1/user/emergency-contacts";
const auth = buildAuthorizationHeader();

beforeEach(() => {
  vi.resetAllMocks();
});

describe("Emergency contact routes — auth", () => {
  it("rejects GET without a token with 403 (auth middleware, before controller)", async () => {
    const res = await request(app).get(URL);
    expect(res.status).toBe(ResponseCode.FORBIDDEN);
    expect(vi.mocked(service.listContacts)).not.toHaveBeenCalled();
  });

  it("rejects POST without a token with 403", async () => {
    const res = await request(app).post(URL).send({ name: "媽媽" });
    expect(res.status).toBe(ResponseCode.FORBIDDEN);
    expect(vi.mocked(service.createContact)).not.toHaveBeenCalled();
  });
});

describe("GET /user/emergency-contacts", () => {
  it("returns 200 with the contacts list", async () => {
    vi.mocked(service.listContacts).mockResolvedValue({
      ok: true,
      httpCode: ResponseCode.OK,
      message: CONTACT_MSG.LIST_OK,
      data: { contacts: [] },
    });
    const res = await request(app).get(URL).set("Authorization", auth);
    expect(res.status).toBe(200);
    expect(res.body.data.contacts).toEqual([]);
    expect(vi.mocked(service.listContacts)).toHaveBeenCalledWith(
      "test-user-id",
    );
  });
});

describe("POST /user/emergency-contacts", () => {
  it("returns 201 with bindUrl and bindCode on success", async () => {
    vi.mocked(service.createContact).mockResolvedValue({
      ok: true,
      httpCode: ResponseCode.CREATED,
      message: CONTACT_MSG.CREATED,
      data: {
        contact: {
          _id: "c1",
          name: "媽媽",
          bindStatus: "pending",
          bindCodeExpiresAt: new Date().toISOString(),
        },
        bindUrl: "https://line.me/R/ti/p/@xxxxxxx",
        bindCode: "K7X2QD",
      },
    });
    const res = await request(app)
      .post(URL)
      .set("Authorization", auth)
      .send({ name: "媽媽" });
    expect(res.status).toBe(201);
    expect(res.body.data.bindUrl).toBe("https://line.me/R/ti/p/@xxxxxxx");
    expect(res.body.data.bindCode).toBe("K7X2QD");
    expect(vi.mocked(service.createContact)).toHaveBeenCalledWith({
      userId: "test-user-id",
      name: "媽媽",
    });
  });

  it("returns 400 CONTACT_LIMIT_REACHED when the cap is hit", async () => {
    vi.mocked(service.createContact).mockResolvedValue({
      ok: false,
      httpCode: ResponseCode.INVALID_INPUT,
      message: CONTACT_MSG.CONTACT_LIMIT_REACHED,
      data: { reason: CONTACT_REASON.CONTACT_LIMIT_REACHED },
    });
    const res = await request(app)
      .post(URL)
      .set("Authorization", auth)
      .send({ name: "哥哥" });
    expect(res.status).toBe(400);
    expect(res.body.data.reason).toBe(CONTACT_REASON.CONTACT_LIMIT_REACHED);
  });

  it("rejects an empty name with 400 at the schema (service not called)", async () => {
    const res = await request(app)
      .post(URL)
      .set("Authorization", auth)
      .send({ name: "" });
    expect(res.status).toBe(ResponseCode.INVALID_INPUT);
    expect(vi.mocked(service.createContact)).not.toHaveBeenCalled();
  });
});

describe("DELETE /user/emergency-contacts/:id", () => {
  it("returns 403 NOT_CONTACT_OWNER when deleting another user's contact", async () => {
    vi.mocked(service.deleteContact).mockResolvedValue({
      ok: false,
      httpCode: ResponseCode.FORBIDDEN,
      message: CONTACT_MSG.NOT_CONTACT_OWNER,
      data: { reason: CONTACT_REASON.NOT_CONTACT_OWNER },
    });
    const res = await request(app)
      .delete(`${URL}/507f1f77bcf86cd799439011`)
      .set("Authorization", auth);
    expect(res.status).toBe(403);
    expect(res.body.data.reason).toBe(CONTACT_REASON.NOT_CONTACT_OWNER);
  });

  it("returns 200 on success", async () => {
    vi.mocked(service.deleteContact).mockResolvedValue({
      ok: true,
      httpCode: ResponseCode.OK,
      message: CONTACT_MSG.DELETED,
      data: null,
    });
    const res = await request(app)
      .delete(`${URL}/507f1f77bcf86cd799439011`)
      .set("Authorization", auth);
    expect(res.status).toBe(ResponseCode.OK);
    expect(res.body.message).toBe(CONTACT_MSG.DELETED);
  });
});
