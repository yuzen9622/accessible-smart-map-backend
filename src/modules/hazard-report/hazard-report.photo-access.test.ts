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
import {
  resolvePhotoKey,
  getPublicReportPhoto as readPublicPhoto,
  getPrivateReportPhoto as readPrivatePhoto,
} from "./hazard-report.photo-access.service";
import { HAZARD_AI } from "../../config/hazard-ai";
import { toReportView } from "./hazard-report.view";

const id = "000000000000000000000001";
const key = `reports/${id}.jpg`;
const url = `/api/v1/a11y/reports/${id}/photo`;
const app = express();
app.set("trust proxy", "loopback");
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

let publicRequest = 0;
const publicUrl = `${url}/public`;
const getPublic = () =>
  request(app)
    .get(publicUrl)
    .set("X-Forwarded-For", `198.51.100.${++publicRequest}`);
const approve = () => {
  row.status = "verified";
  row.expiredAt = new Date(Date.now() + 60_000);
  row.aiReview = { state: "completed", decision: "supported" };
};

describe("public report photo HTTP contract", () => {
  beforeEach(approve);

  it("serves approved photos anonymously without redirects, ETag or caching", async () => {
    const response = await getPublic();
    expect(response.status).toBe(200);
    expect(response.headers["content-type"]).toBe("image/jpeg");
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.headers["x-content-type-options"]).toBe("nosniff");
    expect(response.headers.location).toBeUndefined();
    expect(response.headers.etag).toBeUndefined();
    expect((await sharp(response.body).metadata()).format).toBe("jpeg");
    expect(io.auth).not.toHaveBeenCalled();
    expect(io.find).toHaveBeenCalledTimes(2);
    expect(io.read).toHaveBeenCalledWith(key, {
      signal: expect.any(AbortSignal),
    });
  });

  it("does not require authentication even when a stale or another user's token is attached", async () => {
    for (const token of ["other", "expired", "invalid"]) {
      expect(
        (await getPublic().set("Authorization", `Bearer ${token}`)).status,
      ).toBe(200);
    }
    expect(io.auth).not.toHaveBeenCalled();
  });

  it.each([
    ["pending", { status: "pending" }],
    ["rejected", { status: "rejected" }],
    ["expired status", { status: "expired" }],
    ["elapsed expiry with verified status", { expiredAt: new Date(0) }],
    ["missing expiry", { expiredAt: undefined }],
    ["invalid expiry", { expiredAt: new Date(NaN) }],
    [
      "queued with stale support",
      { aiReview: { state: "queued", decision: "supported" } },
    ],
    [
      "processing with stale support",
      { aiReview: { state: "processing", decision: "supported" } },
    ],
    [
      "failed with stale support",
      { aiReview: { state: "failed", decision: "supported" } },
    ],
    [
      "cancelled with stale support",
      { aiReview: { state: "cancelled", decision: "supported" } },
    ],
    [
      "needs evidence",
      { aiReview: { state: "completed", decision: "needs_evidence" } },
    ],
    [
      "unsupported",
      { aiReview: { state: "completed", decision: "unsupported" } },
    ],
    ["platform hidden", { moderationHiddenAt: new Date() }],
    ["scrubbed", { contentScrubbedAt: new Date() }],
    ["deidentified", { deidentifiedAt: new Date() }],
    ["uploading", { photoIntake: { state: "uploading" } }],
    ["cleanup", { photoIntake: { state: "cleanup" } }],
    ["no photo", { photoStoragePath: undefined }],
    ["manual rejection", { manualReview: { decision: "rejected" } }],
    [
      "known unsafe image",
      { aiVerification: { prefilter: { safeSearchBlocked: true } } },
    ],
  ])("hides %s before storage I/O", async (_name, overrides) => {
    Object.assign(row, overrides);
    // A legacy verified verdict must never bypass a non-completed v2 review.
    if (!row.aiVerification) row.aiVerification = { verdict: "verified" };
    const response = await getPublic();
    expect(response.status).toBe(404);
    expect(response.body.data.reason).toBe("PHOTO_NOT_FOUND");
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(io.read).not.toHaveBeenCalled();
    expect(toReportView(row, false).publicPhotoUrl).toBeNull();
  });

  it("hides absent reports and rejects malformed ids at the edge", async () => {
    io.find.mockResolvedValueOnce(null);
    expect((await getPublic()).status).toBe(404);
    expect(
      (await request(app).get(publicUrl.replace(id, "invalid"))).status,
    ).toBe(400);
    expect(io.read).not.toHaveBeenCalled();
  });

  it("allows explicit legacy AI approval but not community-only verified reports", async () => {
    delete row.aiReview;
    row.aiVerification = { verdict: "verified" };
    expect((await getPublic()).status).toBe(200);
    row.aiVerification = { verdict: "skipped" };
    io.read.mockClear();
    expect((await getPublic()).status).toBe(404);
    expect(io.read).not.toHaveBeenCalled();
    expect(toReportView(row, false).publicPhotoUrl).toBeNull();
  });

  it("preserves explicit human approval without requiring an AI approval", async () => {
    row.aiReview = { state: "cancelled" };
    row.manualReview = { decision: "verified" };
    expect((await getPublic()).status).toBe(200);
  });

  it.each([
    ["hidden", { moderationHiddenAt: new Date() }],
    ["rejected", { status: "rejected" }],
    ["scrubbed", { contentScrubbedAt: new Date() }],
    ["deidentified", { deidentifiedAt: new Date() }],
    [
      "revoked approval",
      { aiReview: { state: "failed", decision: "supported" } },
    ],
    ["replaced photo", { photoStoragePath: `reports/${id}.png` }],
  ])(
    "does not serve bytes when %s during storage I/O",
    async (_name, overrides) => {
      io.read.mockImplementationOnce(async () => {
        Object.assign(row, overrides);
        return jpeg;
      });
      const response = await getPublic();
      expect(response.status).toBe(404);
      expect(response.headers["content-type"]).toContain("application/json");
    },
  );

  it("rechecks the clock when expiry passes during storage I/O", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const now = Date.now();
      row.expiredAt = new Date(now + 1_000);
      io.read.mockImplementationOnce(async () => {
        vi.setSystemTime(now + 1_000);
        return jpeg;
      });
      expect((await getPublic()).status).toBe(404);
      expect(toReportView(row, true).publicPhotoUrl).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps expired and rejected photos private for the reporter and administrators", async () => {
    for (const status of ["expired", "rejected"]) {
      row.status = status;
      expect((await getPublic()).status).toBe(404);
      for (const token of ["owner", "admin"]) {
        const response = await request(app)
          .get(url)
          .set("X-Forwarded-For", `198.51.100.${++publicRequest}`)
          .set("Authorization", `Bearer ${token}`);
        expect(response.status).toBe(200);
        expect(response.headers["cache-control"]).toBe("private, no-store");
      }
    }
  });

  it("maps missing objects and provider/decode failures without leaking storage details", async () => {
    io.read.mockRejectedValueOnce({ code: "GCS_OBJECT_MISSING" });
    expect((await getPublic()).status).toBe(404);
    io.read.mockRejectedValueOnce(new Error("secret bucket credentials"));
    const response = await getPublic();
    expect(response.status).toBe(503);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(JSON.stringify(response.body)).not.toContain("credentials");
    io.read.mockResolvedValueOnce(Buffer.from("invalid-image"));
    expect((await getPublic()).status).toBe(503);
  });

  it("bounds download/decode concurrency and rejects an overflowing byte-free queue", async () => {
    let activeDownloads = 0;
    let peakDownloads = 0;
    const releases: Array<() => void> = [];
    io.read.mockImplementation(
      () =>
        new Promise<Buffer>((resolve) => {
          activeDownloads++;
          peakDownloads = Math.max(peakDownloads, activeDownloads);
          releases.push(() => {
            activeDownloads--;
            resolve(jpeg);
          });
        }),
    );
    const count = HAZARD_AI.decodeConcurrency + HAZARD_AI.decodeQueueLimit;
    const reads = Array.from({ length: count }, (_, index) =>
      index === 0
        ? readPrivatePhoto(id, { userId: "owner", admin: false })
        : readPublicPhoto(id),
    );
    try {
      await vi.waitFor(() =>
        expect(io.read).toHaveBeenCalledTimes(HAZARD_AI.decodeConcurrency),
      );
      expect(io.find).toHaveBeenCalledTimes(HAZARD_AI.decodeConcurrency);
      expect(await readPublicPhoto(id)).toMatchObject({
        ok: false,
        httpCode: 503,
        data: { reason: "PHOTO_UNAVAILABLE" },
      });
      expect(io.read).toHaveBeenCalledTimes(HAZARD_AI.decodeConcurrency);
      for (let index = 0; index < count; index++) {
        await vi.waitFor(() => expect(releases[index]).toBeDefined());
        releases[index]();
      }
      expect((await Promise.all(reads)).every((result) => result.ok)).toBe(
        true,
      );
      expect(peakDownloads).toBe(HAZARD_AI.decodeConcurrency);
    } finally {
      // Ensure a failing assertion does not strand shared capacity for later tests.
      io.read.mockResolvedValue(jpeg);
      releases.splice(0).forEach((release) => release());
      await Promise.all(reads);
    }
  });

  it("cancels queued requests before DB/GCS work and recovers their queue slots", async () => {
    const releases: Array<() => void> = [];
    io.read.mockImplementation(
      () =>
        new Promise<Buffer>((resolve) => releases.push(() => resolve(jpeg))),
    );
    const active = Array.from({ length: HAZARD_AI.decodeConcurrency }, () =>
      readPublicPhoto(id),
    );
    const aborts = Array.from(
      { length: HAZARD_AI.decodeQueueLimit },
      () => new AbortController(),
    );
    const queued = aborts.map((abort) => readPublicPhoto(id, abort.signal));
    try {
      await vi.waitFor(() =>
        expect(io.read).toHaveBeenCalledTimes(HAZARD_AI.decodeConcurrency),
      );
      aborts.forEach((abort) => abort.abort());
      expect(
        (await Promise.all(queued)).every(
          (result) => !result.ok && result.httpCode === 503,
        ),
      ).toBe(true);
      expect(io.find).toHaveBeenCalledTimes(HAZARD_AI.decodeConcurrency);
      io.read.mockResolvedValue(jpeg);
      const replacement = readPublicPhoto(id);
      releases.forEach((release) => release());
      expect(
        (await Promise.all([...active, replacement])).every(
          (result) => result.ok,
        ),
      ).toBe(true);
    } finally {
      aborts.forEach((abort) => abort.abort());
      io.read.mockResolvedValue(jpeg);
      releases.forEach((release) => release());
      await Promise.all([...active, ...queued]);
    }
  });

  it("releases active capacity after an aborted download or a dependency failure", async () => {
    const abort = new AbortController();
    io.read.mockImplementationOnce(
      (_key, { signal }) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener(
            "abort",
            () => reject(new Error("cancelled")),
            { once: true },
          );
        }),
    );
    const cancelled = readPublicPhoto(id, abort.signal);
    await vi.waitFor(() => expect(io.read).toHaveBeenCalledTimes(1));
    abort.abort();
    expect(await cancelled).toMatchObject({ ok: false, httpCode: 503 });
    io.find.mockRejectedValueOnce(new Error("DB down"));
    expect(await readPublicPhoto(id)).toMatchObject({
      ok: false,
      httpCode: 503,
    });
    expect(
      (
        await Promise.all(
          Array.from({ length: HAZARD_AI.decodeConcurrency }, () =>
            readPublicPhoto(id),
          ),
        )
      ).every((result) => result.ok),
    ).toBe(true);
  });

  it("times out queued reads without retaining their queue capacity", async () => {
    const releases: Array<() => void> = [];
    io.read.mockImplementation(
      () =>
        new Promise<Buffer>((resolve) => releases.push(() => resolve(jpeg))),
    );
    const active = Array.from({ length: HAZARD_AI.decodeConcurrency }, () =>
      readPublicPhoto(id),
    );
    let queued: ReturnType<typeof readPublicPhoto> | undefined;
    try {
      await vi.waitFor(() =>
        expect(io.read).toHaveBeenCalledTimes(HAZARD_AI.decodeConcurrency),
      );
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      queued = readPublicPhoto(id);
      await vi.advanceTimersByTimeAsync(HAZARD_AI.providerTimeoutMs);
      expect(await queued).toMatchObject({ ok: false, httpCode: 503 });
      expect(io.find).toHaveBeenCalledTimes(HAZARD_AI.decodeConcurrency);
    } finally {
      vi.useRealTimers();
      io.read.mockResolvedValue(jpeg);
      releases.forEach((release) => release());
      await Promise.all([...active, ...(queued ? [queued] : [])]);
    }
    expect((await readPublicPhoto(id)).ok).toBe(true);
  });

  it("supplies the same public URL to public and owner DTOs only while eligible", () => {
    for (const owner of [false, true]) {
      expect(toReportView(row, owner).publicPhotoUrl).toBe(publicUrl);
      expect(toReportView({}, owner).publicPhotoUrl).toBeNull();
      expect(
        toReportView({ ...row, _id: "invalid" }, owner).publicPhotoUrl,
      ).toBeNull();
      expect(
        toReportView({ ...row, expiredAt: new Date(0) }, owner),
      ).toMatchObject({
        hasPhoto: true,
        publicPhotoUrl: null,
      });
    }
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
  it("does not interpret a malformed report id as a key-matching regular expression", () => {
    expect(resolvePhotoKey(".*", { photoStoragePath: key })).toBeUndefined();
    expect(
      resolvePhotoKey(id, { photoStoragePath: `${key}\n` }),
    ).toBeUndefined();
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
