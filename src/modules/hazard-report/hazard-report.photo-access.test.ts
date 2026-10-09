import cors from "cors";
import { getCorsOptions } from "../../config/cors";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import express from "express";
import request from "supertest";
import sharp from "sharp";
import {
  beforeAll,
  beforeEach,
  afterEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

const io = vi.hoisted(() => ({ find: vi.fn(), read: vi.fn(), auth: vi.fn() }));
vi.mock("./hazard-report.repository", async (original) => ({
  ...(await original<object>()),
  findReportById: io.find,
}));
vi.mock("../../adapters/gcs.adapter", async (original) => ({
  ...(await original<object>()),
  readHazardPhoto: io.read,
}));
vi.mock("../../config/auth", () => ({ authenticateToken: io.auth }));
vi.mock("../../config/redis", () => ({
  redisClient: undefined,
  redisReady: async () => {},
}));
vi.mock("../../config/ai", () => ({ model: "isolated-test" }));
import { createHazardReportRouter } from "./hazard-report.router";
import { resolvePhotoKey } from "./hazard-report.photo-access.service";
import { toReportView } from "./hazard-report.view";

const id = "000000000000000000000001";
const key = `reports/${id}.jpg`;
const url = `/api/v1/a11y/reports/${id}/photo`;
const app = express();
app.use((req, res, next) => cors(getCorsOptions())(req, res, next));
app.use("/api/v1/a11y", createHazardReportRouter());
let jpeg: Buffer;
let row: Record<string, unknown>;
beforeAll(async () => {
  jpeg = await sharp({
    create: { width: 16, height: 8, channels: 3, background: "#126789" },
  })
    .jpeg()
    .toBuffer();
});
beforeEach(() => {
  vi.stubEnv("GCS_BUCKET_NAME", "private-test-bucket");
  vi.clearAllMocks();
  row = {
    _id: id,
    reporterId: "owner",
    photoStoragePath: key,
    status: "expired",
  };
  io.find.mockImplementation(async () => row);
  io.read.mockResolvedValue(jpeg);
  io.auth.mockImplementation(async (token) =>
    token === "expired"
      ? { ok: false, expired: true }
      : token === "invalid"
        ? { ok: false, expired: false }
        : {
            ok: true,
            userId: token,
            user: { role: token === "admin" ? "admin" : "user" },
            sessionId: "session",
          },
  );
});
afterEach(() => vi.unstubAllEnvs());
const get = (token = "owner") =>
  request(app).get(url).set("Authorization", `Bearer ${token}`);

describe("private report photo HTTP contract (real router/service/decoder, isolated I/O)", () => {
  it("returns decodable bytes for the owner of an expired report, with private headers and no redirect or ETag", async () => {
    const response = await get();
    expect(response.status).toBe(200);
    expect(response.headers["content-type"]).toBe("image/jpeg");
    expect(response.headers["cache-control"]).toBe("private, no-store");
    expect(response.headers["x-content-type-options"]).toBe("nosniff");
    expect(response.headers.location).toBeUndefined();
    expect(response.headers.etag).toBeUndefined();
    expect((await sharp(response.body).metadata()).width).toBe(16);
    expect(io.read).toHaveBeenCalledWith(key, {
      signal: expect.any(AbortSignal),
    });
  });
  it("permits administrators", async () =>
    expect((await get("admin")).status).toBe(200));
  it("rejects anonymous requests before DB/storage", async () => {
    expect((await request(app).get(url)).status).toBe(401);
    expect(io.find).not.toHaveBeenCalled();
    expect(io.read).not.toHaveBeenCalled();
  });
  it("returns 401 for expired sessions and 403 for invalid tokens", async () => {
    expect((await get("expired")).status).toBe(401);
    expect((await get("invalid")).status).toBe(403);
    expect(io.read).not.toHaveBeenCalled();
  });
  it("hides other accounts' photos, including verified reports", async () => {
    row.status = "verified";
    expect((await get("other")).status).toBe(404);
    expect(io.read).not.toHaveBeenCalled();
  });
  it("rejects malformed ids at the edge", async () => {
    expect(
      (
        await request(app)
          .get(url.replace(id, "invalid"))
          .set("Authorization", "Bearer owner")
      ).status,
    ).toBe(400);
    expect(io.find).not.toHaveBeenCalled();
  });
  for (const state of ["absent", "missing-photo", "scrubbed", "deidentified"]) {
    it(`hides ${state} before storage`, async () => {
      if (state === "absent") io.find.mockResolvedValue(null);
      if (state === "missing-photo") delete row.photoStoragePath;
      if (state === "scrubbed") row.contentScrubbedAt = new Date();
      if (state === "deidentified") row.deidentifiedAt = new Date();
      expect((await get()).status).toBe(404);
      expect(io.read).not.toHaveBeenCalled();
    });
  }
  it("returns safe 404 for missing objects and retryable 503 for provider failures", async () => {
    io.read.mockRejectedValueOnce({ code: "GCS_OBJECT_MISSING" });
    expect((await get()).status).toBe(404);
    io.read.mockRejectedValueOnce(new Error("private bucket/key credentials"));
    const failed = await get();
    expect(failed.status).toBe(503);
    expect(failed.body.data.reason).toBe("PHOTO_UNAVAILABLE");
    expect(JSON.stringify(failed.body)).not.toContain("credentials");
    expect((await get()).status).toBe(200);
  });
  it("does not send bytes if retention scrubs during the download", async () => {
    io.read.mockImplementationOnce(async () => {
      row.contentScrubbedAt = new Date();
      return jpeg;
    });
    expect((await get()).status).toBe(404);
  });
  it("normalizes legacy WebP via the fixed bucket URL only", async () => {
    delete row.photoStoragePath;
    row.photoUrl = `https://storage.googleapis.com/private-test-bucket/reports/${id}.webp`;
    io.read.mockResolvedValueOnce(await sharp(jpeg).webp().toBuffer());
    const response = await get();
    expect(response.status).toBe(200);
    expect((await sharp(response.body).metadata()).format).toBe("jpeg");
  });
  for (const ext of ["png", "heic", "heif"] as const) {
    it(`serves browser-decodable JPEG for legacy ${ext}`, async () => {
      row.photoStoragePath = `reports/${id}.${ext}`;
      io.read.mockResolvedValueOnce(
        ext === "png"
          ? await sharp(jpeg).png().toBuffer()
          : readFileSync(join(__dirname, "fixtures", `synthetic.${ext}`)),
      );
      const response = await get();
      expect(response.status).toBe(200);
      expect((await sharp(response.body).metadata()).format).toBe("jpeg");
    });
  }
  it("allows configured credentialed GET/Authorization preflight and refuses other origins", async () => {
    vi.stubEnv("CORS_ORIGINS", "https://map-dev.yuzen.dev,*");
    const preflight = await request(app)
      .options(url)
      .set("Origin", "https://map-dev.yuzen.dev")
      .set("Access-Control-Request-Method", "GET")
      .set("Access-Control-Request-Headers", "authorization");
    expect(preflight.status).toBe(204);
    expect(preflight.headers["access-control-allow-origin"]).toBe(
      "https://map-dev.yuzen.dev",
    );
    expect(preflight.headers["access-control-allow-credentials"]).toBe("true");
    expect(preflight.headers["access-control-allow-methods"]).toContain("GET");
    expect(preflight.headers["access-control-allow-headers"]).toContain(
      "authorization",
    );
    const denied = await request(app)
      .options(url)
      .set("Origin", "https://evil.invalid")
      .set("Access-Control-Request-Method", "GET");
    expect(denied.headers["access-control-allow-origin"]).toBeUndefined();
  });
  it("rejects undecodable storage content before committing an image response", async () => {
    io.read.mockResolvedValueOnce(Buffer.from("<html>upstream failure</html>"));
    const response = await get();
    expect(response.status).toBe(503);
    expect(response.headers["content-type"]).toContain("application/json");
  });
});

describe("trusted paths and public DTOs", () => {
  it("rejects other buckets, arbitrary URLs, query strings, traversal and other reports' keys", () => {
    for (const photoUrl of [
      `https://storage.googleapis.com/other/reports/${id}.jpg`,
      `https://evil.test/private-test-bucket/reports/${id}.jpg`,
      `https://storage.googleapis.com/private-test-bucket/reports/${id}.jpg?token=secret`,
    ])
      expect(resolvePhotoKey(id, { photoUrl })).toBeUndefined();
    for (const photoStoragePath of [
      "../secret",
      "reports/000000000000000000000002.jpg",
      "https://evil.test/a.jpg",
    ])
      expect(resolvePhotoKey(id, { photoStoragePath })).toBeUndefined();
  });
  it("always supplies hasPhoto and strips storage URLs/keys, including owner views", () => {
    for (const owner of [false, true]) {
      const view = toReportView(
        { ...row, photoUrl: "https://private.invalid/photo" },
        owner,
      );
      expect(view.hasPhoto).toBe(true);
      expect(view).not.toHaveProperty("photoUrl");
      expect(view).not.toHaveProperty("photoStoragePath");
      expect(
        toReportView({ ...row, contentScrubbedAt: new Date() }, owner).hasPhoto,
      ).toBe(false);
      expect(toReportView({}, owner).hasPhoto).toBe(false);
    }
  });
});
