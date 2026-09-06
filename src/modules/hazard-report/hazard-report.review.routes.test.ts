import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import request from "supertest";

vi.mock("./hazard-report.service", () => ({
  findReviewQueue: vi.fn(),
  submitManualReview: vi.fn(),
}));

import {
  buildAuthorizationHeader,
  startTestServer,
  stopTestServer,
} from "../../../tests/helpers/test-helpers";
import {
  buildDbUser,
  stubAuthUserLookup,
} from "../../../tests/helpers/real-auth";
import * as service from "./hazard-report.service";
import { ResponseCode } from "../../types/code";
import { HAZARD_MSG } from "../../constants/messages";

let app: Awaited<ReturnType<typeof startTestServer>>;
const QUEUE_URL = "/api/v1/a11y/reports/review-queue";
const reviewUrl = (id: string) => `/api/v1/a11y/reports/${id}/review`;
const REPORT_ID = "66a1f2c3e4b5a6d7c8e9f0d4";

function adminAuth() {
  stubAuthUserLookup(buildDbUser({ role: "admin" }));
  return buildAuthorizationHeader();
}

function memberAuth() {
  stubAuthUserLookup(buildDbUser({ role: "user" }));
  return buildAuthorizationHeader();
}

beforeAll(async () => {
  app = await startTestServer();
});

afterAll(async () => {
  await stopTestServer(app);
});

beforeEach(() => {
  vi.restoreAllMocks();
  vi.mocked(service.findReviewQueue).mockReset();
  vi.mocked(service.submitManualReview).mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("GET /a11y/reports/review-queue", () => {
  it("rejects a request without a token with 403 (auth middleware, before controller)", async () => {
    const res = await request(app).get(QUEUE_URL);
    expect(res.status).toBe(ResponseCode.FORBIDDEN);
    expect(vi.mocked(service.findReviewQueue)).not.toHaveBeenCalled();
  });

  it("rejects a non-admin user with 403 (require-admin middleware, before controller)", async () => {
    const auth = memberAuth();
    const res = await request(app).get(QUEUE_URL).set("Authorization", auth);
    expect(res.status).toBe(ResponseCode.FORBIDDEN);
    expect(vi.mocked(service.findReviewQueue)).not.toHaveBeenCalled();
  });

  it("returns 200 with the queue for an admin", async () => {
    const auth = adminAuth();
    vi.mocked(service.findReviewQueue).mockResolvedValue({
      ok: true,
      httpCode: ResponseCode.OK,
      message: "找到 1 筆待人工審核的回報",
      data: {
        reports: [{ _id: REPORT_ID, status: "pending" }],
        total: 1,
        nextCursor: null,
      },
    });

    const res = await request(app).get(QUEUE_URL).set("Authorization", auth);

    expect(res.status).toBe(200);
    expect(res.body.data.reports).toHaveLength(1);
    expect(res.body.data.nextCursor).toBeNull();
    expect(vi.mocked(service.findReviewQueue)).toHaveBeenCalledWith({
      limit: undefined,
      cursor: undefined,
    });
  });

  it("passes limit and cursor through to the service", async () => {
    const auth = adminAuth();
    vi.mocked(service.findReviewQueue).mockResolvedValue({
      ok: true,
      httpCode: ResponseCode.OK,
      message: "找到 0 筆待人工審核的回報",
      data: { reports: [], total: 0, nextCursor: null },
    });

    await request(app)
      .get(QUEUE_URL)
      .query({ limit: 5, cursor: REPORT_ID })
      .set("Authorization", auth);

    expect(vi.mocked(service.findReviewQueue)).toHaveBeenCalledWith({
      limit: 5,
      cursor: REPORT_ID,
    });
  });
});

describe("POST /a11y/reports/:id/review", () => {
  it("rejects a request without a token with 403", async () => {
    const res = await request(app)
      .post(reviewUrl(REPORT_ID))
      .send({ decision: "verified" });
    expect(res.status).toBe(ResponseCode.FORBIDDEN);
    expect(vi.mocked(service.submitManualReview)).not.toHaveBeenCalled();
  });

  it("rejects a non-admin user with 403", async () => {
    const auth = memberAuth();
    const res = await request(app)
      .post(reviewUrl(REPORT_ID))
      .set("Authorization", auth)
      .send({ decision: "verified" });
    expect(res.status).toBe(ResponseCode.FORBIDDEN);
    expect(vi.mocked(service.submitManualReview)).not.toHaveBeenCalled();
  });

  it("rejects an invalid decision value with 400 (schema validation)", async () => {
    const auth = adminAuth();
    const res = await request(app)
      .post(reviewUrl(REPORT_ID))
      .set("Authorization", auth)
      .send({ decision: "approved" });
    expect(res.status).toBe(ResponseCode.INVALID_INPUT);
    expect(vi.mocked(service.submitManualReview)).not.toHaveBeenCalled();
  });

  it("rejects an unknown body field with 400 (strict schema)", async () => {
    const auth = adminAuth();
    const res = await request(app)
      .post(reviewUrl(REPORT_ID))
      .set("Authorization", auth)
      .send({ decision: "verified", extra: "nope" });
    expect(res.status).toBe(ResponseCode.INVALID_INPUT);
    expect(vi.mocked(service.submitManualReview)).not.toHaveBeenCalled();
  });

  it("submits a verified decision for an admin and returns 200", async () => {
    const auth = adminAuth();
    vi.mocked(service.submitManualReview).mockResolvedValue({
      ok: true,
      httpCode: ResponseCode.OK,
      message: HAZARD_MSG.REVIEWED,
      data: { report: { _id: REPORT_ID, status: "verified" } },
    });

    const res = await request(app)
      .post(reviewUrl(REPORT_ID))
      .set("Authorization", auth)
      .send({ decision: "verified", note: "現場確認施工鐵板仍在" });

    expect(res.status).toBe(200);
    expect(res.body.data.report.status).toBe("verified");
    expect(vi.mocked(service.submitManualReview)).toHaveBeenCalledWith({
      reportId: REPORT_ID,
      reviewerId: "test-user-id",
      decision: "verified",
      note: "現場確認施工鐵板仍在",
    });
  });

  it("propagates a 404 domain failure from the service", async () => {
    const auth = adminAuth();
    vi.mocked(service.submitManualReview).mockResolvedValue({
      ok: false,
      httpCode: ResponseCode.NOT_FOUND,
      message: HAZARD_MSG.REPORT_NOT_FOUND,
      data: { reason: "REPORT_NOT_FOUND" },
    });

    const res = await request(app)
      .post(reviewUrl(REPORT_ID))
      .set("Authorization", auth)
      .send({ decision: "rejected" });

    expect(res.status).toBe(ResponseCode.NOT_FOUND);
    expect(res.body.data.reason).toBe("REPORT_NOT_FOUND");
  });
});
