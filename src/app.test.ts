import { describe, it, expect } from "vitest";
import request from "supertest";

import { buildTestApp } from "../tests/helpers/test-helpers";

const app = buildTestApp();

describe("terminal error handler", () => {
  it("answers a malformed JSON body with the envelope, not Express's HTML page", async () => {
    const res = await request(app)
      .post("/api/v1/user/auth/login")
      .set("Content-Type", "application/json")
      .send('{"email":');

    expect(res.status).toBe(400);
    expect(res.headers["content-type"]).toMatch(/application\/json/);
    expect(res.body).toMatchObject({ ok: false, status: "error", code: 400 });
    expect(typeof res.body.message).toBe("string");
  });

  it("keeps a body-parser failure a client error rather than reporting it as ours", async () => {
    const res = await request(app)
      .post("/api/v1/a11y/reviews")
      .set("Content-Type", "application/json")
      .send("{not json at all");

    expect(res.status).toBeLessThan(500);
    expect(res.headers["content-type"]).toMatch(/application\/json/);
    expect(res.body.ok).toBe(false);
  });
});

describe("unmatched routes", () => {
  it("answers with the 404 envelope", async () => {
    const res = await request(app).get("/api/v1/definitely-not-a-route");

    expect(res.status).toBe(404);
    expect(res.headers["content-type"]).toMatch(/application\/json/);
    expect(res.body).toMatchObject({ ok: false, status: "error", code: 404 });
  });
});
