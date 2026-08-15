import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import { ResponseCode } from "../../types/code";
import { REVIEW_MSG } from "../../constants/messages";

vi.mock("../../config/auth", async () => {
  const { createAuthModuleMock } =
    await import("../../../tests/helpers/auth-mock");
  return createAuthModuleMock();
});

vi.mock("./review.service", async (orig) => ({
  ...((await orig()) as object),
  createReview: vi.fn(),
  findByPlace: vi.fn(),
  updateReview: vi.fn(),
  deleteReview: vi.fn(),
  getAiSummary: vi.fn(),
}));

import {
  buildTestApp,
  buildAuthorizationHeader,
} from "../../../tests/helpers/test-helpers";
import * as service from "./review.service";

const app = buildTestApp();
const BASE = "/api/v1/a11y/reviews";
const AUTH = buildAuthorizationHeader({
  _id: "user-abc",
  email: "user@test.com",
});

const VALID_REVIEW = {
  _id: "66a1f2c3e4b5a6d7c8e9f0d4",
  userId: "user-abc",
  rating: 4,
  passageWidthRating: 4,
  toiletRating: 4,
  elevatorRating: 4,
  serviceRating: 4,
  entranceAccessibility: "step_free" as const,
  toiletTurningRoom: true,
  wheelchairTableHeight: true,
  adequateAisleWidth: true,
  staffHelpfulnessRating: 4,
  aggregateAccessibilityScore: 4.2,
  comment: "不錯",
  createdAt: new Date(),
};
const VALID_CREATE_BODY = {
  placeId: "node/123456",
  placeType: "osm",
  passageWidthRating: 4,
  toiletRating: 4,
  elevatorRating: 4,
  serviceRating: 4,
  entranceAccessibility: "step_free",
  toiletTurningRoom: true,
  wheelchairTableHeight: true,
  adequateAisleWidth: true,
  staffHelpfulnessRating: 4,
  comment: "不錯",
};
const VALID_LIST_QUERY = { placeId: "node/123456", placeType: "osm" };

beforeEach(() => {
  vi.resetAllMocks();
});

// ─── POST /reviews ───────────────────────────────────────────────
describe("POST /api/v1/a11y/reviews", () => {
  it("returns 201 when review is created", async () => {
    vi.mocked(service.createReview).mockResolvedValue({
      ok: true,
      httpCode: ResponseCode.CREATED,
      message: REVIEW_MSG.CREATED,
      data: { review: VALID_REVIEW },
    });

    const res = await request(app)
      .post(BASE)
      .set("Authorization", AUTH)
      .send(VALID_CREATE_BODY);

    expect(res.status).toBe(ResponseCode.CREATED);
    expect(res.body.ok).toBe(true);
    expect(res.body).toMatchObject({
      ok: true,
      status: "success",
      code: ResponseCode.CREATED,
      message: REVIEW_MSG.CREATED,
      data: { review: { aggregateAccessibilityScore: 4.2 } },
    });
    expect(vi.mocked(service.createReview)).toHaveBeenCalledWith(
      "user-abc",
      expect.objectContaining({
        entranceAccessibility: "step_free",
        toiletTurningRoom: true,
        wheelchairTableHeight: true,
        adequateAisleWidth: true,
        staffHelpfulnessRating: 4,
      }),
    );
  });

  it("returns 400 when already reviewed", async () => {
    vi.mocked(service.createReview).mockResolvedValue({
      ok: false,
      httpCode: ResponseCode.INVALID_INPUT,
      message: REVIEW_MSG.ALREADY_REVIEWED,
    });

    const res = await request(app)
      .post(BASE)
      .set("Authorization", AUTH)
      .send(VALID_CREATE_BODY);

    expect(res.status).toBe(ResponseCode.INVALID_INPUT);
    expect(res.body.message).toBe(REVIEW_MSG.ALREADY_REVIEWED);
  });

  it("returns 400 when a sub-rating is out of range", async () => {
    const res = await request(app)
      .post(BASE)
      .set("Authorization", AUTH)
      .send({ ...VALID_CREATE_BODY, passageWidthRating: 6 });

    expect(res.status).toBe(ResponseCode.INVALID_INPUT);
    expect(vi.mocked(service.createReview)).not.toHaveBeenCalled();
  });

  it("returns the standard validation envelope for an invalid structured enum", async () => {
    const res = await request(app)
      .post(BASE)
      .set("Authorization", AUTH)
      .send({ ...VALID_CREATE_BODY, entranceAccessibility: "stairs" });

    expect(res.status).toBe(ResponseCode.INVALID_INPUT);
    expect(res.body).toMatchObject({
      ok: false,
      status: "error",
      code: ResponseCode.INVALID_INPUT,
      message: "Invalid request.",
      data: { errors: expect.any(Array) },
    });
    expect(vi.mocked(service.createReview)).not.toHaveBeenCalled();
  });

  it("returns 400 for a structured rating outside its range", async () => {
    const res = await request(app)
      .post(BASE)
      .set("Authorization", AUTH)
      .send({ ...VALID_CREATE_BODY, staffHelpfulnessRating: 6 });

    expect(res.status).toBe(ResponseCode.INVALID_INPUT);
    expect(vi.mocked(service.createReview)).not.toHaveBeenCalled();
  });

  it("returns 400 for an unknown structured field", async () => {
    const res = await request(app)
      .post(BASE)
      .set("Authorization", AUTH)
      .send({ ...VALID_CREATE_BODY, untrustedScore: 5 });

    expect(res.status).toBe(ResponseCode.INVALID_INPUT);
    expect(vi.mocked(service.createReview)).not.toHaveBeenCalled();
  });

  it("returns 400 when placeId is missing", async () => {
    const { placeId: _, ...body } = VALID_CREATE_BODY;
    const res = await request(app)
      .post(BASE)
      .set("Authorization", AUTH)
      .send(body);
    expect(res.status).toBe(ResponseCode.INVALID_INPUT);
    expect(vi.mocked(service.createReview)).not.toHaveBeenCalled();
  });

  it("returns 403 when no auth header", async () => {
    const res = await request(app).post(BASE).send(VALID_CREATE_BODY);
    expect(res.status).toBe(ResponseCode.FORBIDDEN);
    expect(vi.mocked(service.createReview)).not.toHaveBeenCalled();
  });
});

// ─── GET /reviews ────────────────────────────────────────────────
describe("GET /api/v1/a11y/reviews", () => {
  it("returns 200 with review list", async () => {
    vi.mocked(service.findByPlace).mockResolvedValue({
      ok: true,
      httpCode: ResponseCode.OK,
      message: REVIEW_MSG.LIST_OK,
      data: {
        items: [VALID_REVIEW],
        avgRating: 4,
        totalCount: 1,
        page: 1,
        totalPages: 1,
      },
    });

    const res = await request(app).get(BASE).query(VALID_LIST_QUERY);
    expect(res.status).toBe(200);
    expect(res.body.data.items).toHaveLength(1);
    expect(vi.mocked(service.findByPlace)).toHaveBeenCalledWith(
      expect.objectContaining({
        placeId: "node/123456",
        placeType: "osm",
        page: 1,
        limit: 10,
      }),
    );
  });

  it("passes a numeric minAggregateScore filter to the service", async () => {
    vi.mocked(service.findByPlace).mockResolvedValue({
      ok: true,
      httpCode: ResponseCode.OK,
      message: REVIEW_MSG.LIST_OK,
      data: {
        items: [VALID_REVIEW],
        avgRating: 4,
        totalCount: 1,
        page: 1,
        totalPages: 1,
      },
    });

    const res = await request(app)
      .get(BASE)
      .query({ ...VALID_LIST_QUERY, minAggregateScore: "3.5" });

    expect(res.status).toBe(ResponseCode.OK);
    expect(vi.mocked(service.findByPlace)).toHaveBeenCalledWith(
      expect.objectContaining({ minAggregateScore: 3.5 }),
    );
  });

  it("returns 400 for minAggregateScore outside its bounds", async () => {
    const res = await request(app)
      .get(BASE)
      .query({ ...VALID_LIST_QUERY, minAggregateScore: 5.1 });
    expect(res.status).toBe(ResponseCode.INVALID_INPUT);
    expect(vi.mocked(service.findByPlace)).not.toHaveBeenCalled();
  });

  it("returns 400 when placeId is missing", async () => {
    const res = await request(app).get(BASE).query({ placeType: "osm" });
    expect(res.status).toBe(ResponseCode.INVALID_INPUT);
    expect(vi.mocked(service.findByPlace)).not.toHaveBeenCalled();
  });

  it("returns 400 when placeType is invalid", async () => {
    const res = await request(app)
      .get(BASE)
      .query({ ...VALID_LIST_QUERY, placeType: "invalid" });
    expect(res.status).toBe(ResponseCode.INVALID_INPUT);
    expect(vi.mocked(service.findByPlace)).not.toHaveBeenCalled();
  });
});

// ─── PATCH /reviews/:id ───────────────────────────────────────────
describe("PATCH /api/v1/a11y/reviews/:id", () => {
  const validId = "66a1f2c3e4b5a6d7c8e9f0d4";

  it("returns 200 when update succeeds", async () => {
    vi.mocked(service.updateReview).mockResolvedValue({
      ok: true,
      httpCode: ResponseCode.OK,
      message: REVIEW_MSG.UPDATED,
      data: {
        review: {
          ...VALID_REVIEW,
          passageWidthRating: 5,
          entranceAccessibility: "ramp",
          staffHelpfulnessRating: 5,
          aggregateAccessibilityScore: 4.3,
        },
      },
    });

    const res = await request(app)
      .patch(`${BASE}/${validId}`)
      .set("Authorization", AUTH)
      .send({
        passageWidthRating: 5,
        entranceAccessibility: "ramp",
        staffHelpfulnessRating: 5,
      });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      ok: true,
      status: "success",
      code: ResponseCode.OK,
      message: REVIEW_MSG.UPDATED,
      data: { review: { aggregateAccessibilityScore: 4.3 } },
    });
    expect(vi.mocked(service.updateReview)).toHaveBeenCalledWith(
      validId,
      "user-abc",
      expect.objectContaining({
        passageWidthRating: 5,
        entranceAccessibility: "ramp",
        staffHelpfulnessRating: 5,
      }),
    );
  });

  it("returns 404 when review not found", async () => {
    vi.mocked(service.updateReview).mockResolvedValue({
      ok: false,
      httpCode: ResponseCode.NOT_FOUND,
      message: REVIEW_MSG.NOT_FOUND,
    });

    const res = await request(app)
      .patch(`${BASE}/${validId}`)
      .set("Authorization", AUTH)
      .send({ passageWidthRating: 5 });

    expect(res.status).toBe(ResponseCode.NOT_FOUND);
  });

  it("returns 403 when reviewer is not the owner", async () => {
    vi.mocked(service.updateReview).mockResolvedValue({
      ok: false,
      httpCode: ResponseCode.FORBIDDEN,
      message: REVIEW_MSG.FORBIDDEN,
    });

    const res = await request(app)
      .patch(`${BASE}/${validId}`)
      .set("Authorization", AUTH)
      .send({ passageWidthRating: 3 });

    expect(res.status).toBe(ResponseCode.FORBIDDEN);
  });

  it("returns 400 for malformed id", async () => {
    const res = await request(app)
      .patch(`${BASE}/not-an-id`)
      .set("Authorization", AUTH)
      .send({ passageWidthRating: 5 });

    expect(res.status).toBe(ResponseCode.INVALID_INPUT);
    expect(vi.mocked(service.updateReview)).not.toHaveBeenCalled();
  });

  it("returns 403 when no auth header", async () => {
    const res = await request(app)
      .patch(`${BASE}/${validId}`)
      .send({ passageWidthRating: 5 });
    expect(res.status).toBe(ResponseCode.FORBIDDEN);
    expect(vi.mocked(service.updateReview)).not.toHaveBeenCalled();
  });
});

// ─── DELETE /reviews/:id ──────────────────────────────────────────
describe("DELETE /api/v1/a11y/reviews/:id", () => {
  const validId = "66a1f2c3e4b5a6d7c8e9f0d4";

  it("returns 200 when delete succeeds", async () => {
    vi.mocked(service.deleteReview).mockResolvedValue({
      ok: true,
      httpCode: ResponseCode.OK,
      message: REVIEW_MSG.DELETED,
    });

    const res = await request(app)
      .delete(`${BASE}/${validId}`)
      .set("Authorization", AUTH);

    expect(res.status).toBe(200);
    expect(res.body.message).toBe(REVIEW_MSG.DELETED);
    expect(vi.mocked(service.deleteReview)).toHaveBeenCalledWith(
      validId,
      "user-abc",
    );
  });

  it("returns 404 when review not found", async () => {
    vi.mocked(service.deleteReview).mockResolvedValue({
      ok: false,
      httpCode: ResponseCode.NOT_FOUND,
      message: REVIEW_MSG.NOT_FOUND,
    });

    const res = await request(app)
      .delete(`${BASE}/${validId}`)
      .set("Authorization", AUTH);

    expect(res.status).toBe(ResponseCode.NOT_FOUND);
  });

  it("returns 400 for malformed id", async () => {
    const res = await request(app)
      .delete(`${BASE}/bad-id`)
      .set("Authorization", AUTH);
    expect(res.status).toBe(ResponseCode.INVALID_INPUT);
    expect(vi.mocked(service.deleteReview)).not.toHaveBeenCalled();
  });

  it("returns 403 when no auth header", async () => {
    const res = await request(app).delete(`${BASE}/${validId}`);
    expect(res.status).toBe(ResponseCode.FORBIDDEN);
    expect(vi.mocked(service.deleteReview)).not.toHaveBeenCalled();
  });
});

// ─── GET /reviews/summary ─────────────────────────────────────────
describe("GET /api/v1/a11y/reviews/summary", () => {
  it("returns 200 with AI summary when reviews are sufficient", async () => {
    vi.mocked(service.getAiSummary).mockResolvedValue({
      ok: true,
      httpCode: ResponseCode.OK,
      message: REVIEW_MSG.SUMMARY_OK,
      data: {
        avgRating: 4.2,
        totalCount: 5,
        summary: "整體評價良好，電梯寬敞",
        highlights: ["電梯空間寬敞", "坡道坡度適中"],
      },
    });

    const res = await request(app)
      .get(`${BASE}/summary`)
      .query(VALID_LIST_QUERY);
    expect(res.status).toBe(200);
    expect(res.body.data.summary).toBe("整體評價良好，電梯寬敞");
    expect(vi.mocked(service.getAiSummary)).toHaveBeenCalledWith(
      "node/123456",
      "osm",
    );
  });

  it("returns 200 with null summary when reviews are insufficient", async () => {
    vi.mocked(service.getAiSummary).mockResolvedValue({
      ok: true,
      httpCode: ResponseCode.OK,
      message: REVIEW_MSG.SUMMARY_OK,
      data: { avgRating: 4.0, totalCount: 2, summary: null, highlights: null },
    });

    const res = await request(app)
      .get(`${BASE}/summary`)
      .query(VALID_LIST_QUERY);
    expect(res.status).toBe(200);
    expect(res.body.data.summary).toBeNull();
  });

  it("returns 400 when placeId is missing", async () => {
    const res = await request(app)
      .get(`${BASE}/summary`)
      .query({ placeType: "osm" });
    expect(res.status).toBe(ResponseCode.INVALID_INPUT);
    expect(vi.mocked(service.getAiSummary)).not.toHaveBeenCalled();
  });
});
