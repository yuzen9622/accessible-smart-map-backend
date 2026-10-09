import { getPrivateReportPhoto } from "./hazard-report.photo-access.service";
import express from "express";
import request from "supertest";
import sharp from "sharp";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

// Only external I/O is fake. HTTP, multipart, EXIF, real codec/hash, MongoDB,
// durable claim/fencing, strict model parser and policy are production code.
const io = vi.hoisted(() => ({
  photos: new Map<string, Buffer>(),
  uploads: vi.fn(),
  vision: vi.fn(),
  gemini: vi.fn(),
}));
vi.mock("../../config/redis", () => ({
  redisClient: undefined,
  redisReady: async () => {},
}));
vi.mock("../../config/ai", () => ({ model: "isolated-test-model" }));
vi.mock("../../adapters/gcs.adapter", () => ({
  getHazardPhotoStoragePath: (id: string) => `reports/${id}.jpg`,
  uploadHazardPhoto: async (bytes: Buffer, id: string) => {
    const storagePath = `reports/${id}.jpg`;
    io.uploads();
    io.photos.set(storagePath, Buffer.from(bytes));
    return { storagePath, url: `https://example.invalid/${storagePath}` };
  },
  readHazardPhoto: async (path: string) => {
    const bytes = io.photos.get(path);
    if (!bytes) throw new Error("isolated object absent");
    return bytes;
  },
  deleteHazardPhoto: async (path: string) => {
    io.photos.delete(path);
  },
}));
vi.mock("../../adapters/vision.adapter", () => ({ prefilterImage: io.vision }));
vi.mock("../../adapters/ai-vision.adapter", () => ({
  verifyImageWithGemini: io.gemini,
}));

import HazardReport from "../../model/hazard-report.model";
import { createHazardReportRouter } from "./hazard-report.router";
import { analyzeHazardPhoto } from "./hazard-report.ai-verify";
import { processAiJob, type AiWorkerDeps } from "./hazard-report.ai-worker";
import {
  claimNextAiJob,
  convergeStuckAiJobs,
} from "./hazard-report.ai-job.repository";
import { readHazardPhoto, deleteHazardPhoto } from "../../adapters/gcs.adapter";
import { findConfirmedWithin } from "./hazard-report.repository";
import {
  startMongoTest,
  clearMongoTestDatabase,
  stopMongoTest,
  type MongoTestContext,
} from "../../../tests/helpers/mongo-test-harness";

const URL = "/api/v1/a11y/reports";
const OBSERVATION = JSON.stringify({
  scene: "street",
  imageQuality: "usable",
  pathImpact: "blocked",
  claimMatch: "supported",
  visibleHazards: ["vehicle"],
  observations: ["PRIVATE_OCR <script>ALICE / PLATE-123"],
  limitations: ["PRIVATE_LOCATION"],
  requiredEvidence: [],
  confidence: 0.01,
});
const workerDeps: AiWorkerDeps = {
  readPhoto: readHazardPhoto,
  analyze: analyzeHazardPhoto,
  deletePhoto: deleteHazardPhoto,
  now: () => new Date(),
  random: () => 0,
};
const signal = new AbortController().signal;
let app: ReturnType<typeof express>;
let mongo: MongoTestContext | undefined;
let jpeg: Buffer;

function submit(bytes = jpeg, hazardType = "obstacle", lng = 121.5654) {
  return request(app)
    .post(URL)
    .field("hazardType", hazardType)
    .field("severity", "blocking")
    .field("latitude", "25.0330")
    .field("longitude", String(lng))
    .attach("photo", bytes, {
      filename: "synthetic.jpg",
      contentType: "image/jpeg",
    });
}
async function publicReport(id: string) {
  const response = await request(app).get(`${URL}/${id}`);
  expect(response.status).toBe(200);
  const report = response.body.data.report;
  for (const key of [
    "aiReviewJob",
    "photoIntake",
    "photoStoragePath",
    "photoUrl",
    "imageHash",
    "reporterId",
  ]) {
    expect(report).not.toHaveProperty(key);
  }
  expect(JSON.stringify(report)).not.toContain("PRIVATE_");
  expect(report.hasPhoto).toBe(true);
  return report;
}
async function runClaim() {
  const job = await claimNextAiJob(new Date(), "http-test-lease");
  expect(job).not.toBeNull();
  return processAiJob(job!, workerDeps, signal);
}

beforeAll(async () => {
  mongo = await startMongoTest();
  jpeg = await sharp({
    create: { width: 64, height: 32, channels: 3, background: "#186fcd" },
  })
    .jpeg()
    .toBuffer();
  app = express();
  app.use(express.json());
  app.use("/api/v1/a11y", createHazardReportRouter());
});
beforeEach(async () => {
  await clearMongoTestDatabase();
  await HazardReport.createIndexes();
  io.photos.clear();
  io.uploads.mockClear();
  io.vision.mockReset().mockResolvedValue({
    passed: true,
    safeSearchBlocked: false,
    detectedLabels: ["Street"],
  });
  io.gemini.mockReset().mockResolvedValue(OBSERVATION);
});
afterAll(async () => {
  await stopMongoTest(mongo);
});

describe("isolated real HTTP / Mongo hazard pipeline (external I/O fake, not product E2E)", () => {
  it("201 receipt → queued GET → real claim/parser/policy/CAS → supported GET and safe consumer visibility", async () => {
    const response = await submit();
    expect(response.status).toBe(201);
    const id = response.body.data.report._id;
    expect(response.body.data.report.reporterId).toMatch(/^ip:[a-f0-9]{32}$/);
    expect((await publicReport(id)).aiReview.state).toBe("queued");
    expect(io.vision).not.toHaveBeenCalled();
    expect(io.gemini).not.toHaveBeenCalled();
    expect((await runClaim()).outcome).toBe("completed");
    const result = await publicReport(id);
    const photo = await getPrivateReportPhoto(id, {
      userId: response.body.data.report.reporterId,
      admin: false,
    });
    expect(photo.ok).toBe(true);
    if (photo.ok)
      expect((await sharp(photo.buffer).metadata()).format).toBe("jpeg");
    expect(result.status).toBe("verified");
    expect(result.aiReview).toMatchObject({
      state: "completed",
      decision: "supported",
    });
    const nearby = await request(app)
      .get(URL)
      .query({ lat: 25.033, lng: 121.5654, radius: 500 });
    expect(nearby.status).toBe(200);
    expect(
      nearby.body.data.reports.map((r: { _id: string }) => r._id),
    ).toContain(id);
    // AI evidence is not an independent community confirmation for routing.
    expect(
      await findConfirmedWithin(
        { lat: 25.033, lng: 121.5654 },
        500,
        10,
        new Date(),
      ),
    ).toHaveLength(0);
    const selfVote = await request(app)
      .post(`${URL}/${id}/confirm`)
      .send({ action: "confirm" });
    expect(selfVote.status).toBe(400);
    expect(selfVote.body.data.reason).toBe("SELF_CONFIRMATION");
  });

  it("fully decodes before dedup: a corrupt same-location JPEG is rejected without a vote, upload or provider call", async () => {
    const response = await submit();
    const id = response.body.data.report._id;
    await runClaim();
    io.vision.mockClear();
    io.gemini.mockClear();
    io.uploads.mockClear();
    const invalid = await submit(Buffer.from([0xff, 0xd8, 0xff, 0x00]));
    expect(invalid.status).toBe(400);
    expect(invalid.body.data.reason).toBe("IMAGE_INVALID");
    expect(io.uploads).not.toHaveBeenCalled();
    expect(io.vision).not.toHaveBeenCalled();
    expect(io.gemini).not.toHaveBeenCalled();
    expect(await HazardReport.countDocuments()).toBe(1);
    expect((await publicReport(id)).confirmCount).toBe(0);
  });

  it("data_error cannot auto-pass and same-location evidence resubmission creates a new durable job", async () => {
    const first = await submit(jpeg, "data_error");
    expect(first.status).toBe(201);
    await runClaim();
    const old = await publicReport(first.body.data.report._id);
    expect(old.aiReview).toMatchObject({
      state: "completed",
      decision: "needs_evidence",
      reasonCode: "MAP_REFERENCE_REQUIRED",
    });
    const second = await submit(jpeg, "data_error");
    expect(second.status).toBe(201);
    expect(second.body.data.report._id).not.toBe(old._id);
    expect(second.body.data.report.aiReview.state).toBe("queued");
    expect((await publicReport(old._id)).confirmCount).toBe(0);
    expect(await HazardReport.countDocuments()).toBe(2);
  });

  it("provider permission failure is failed, never an unsupported content decision", async () => {
    const response = await submit();
    io.vision.mockRejectedValue(
      Object.assign(new Error("PRIVATE_PROVIDER_MESSAGE"), {
        code: "VISION_PERMISSION_DENIED",
        retryable: false,
        circuitBreak: true,
      }),
    );
    expect((await runClaim()).outcome).toBe("failed");
    const result = await publicReport(response.body.data.report._id);
    expect(result.status).toBe("pending");
    expect(result.aiReview.state).toBe("failed");
    expect(result.aiReview.decision).toBeUndefined();
    expect(io.gemini).not.toHaveBeenCalled();
  });

  it("daemon restart reclaims expired lease and fences the previous attempt's late decision", async () => {
    const response = await submit();
    const id = response.body.data.report._id;
    const previous = (await claimNextAiJob(new Date(), "dead-process"))!;
    await HazardReport.updateOne(
      { _id: id },
      { $set: { "aiReviewJob.leaseExpiresAt": new Date(0) } },
    );
    const successor = (await claimNextAiJob(new Date(), "new-process"))!;
    expect(successor.leaseToken).not.toBe(previous.leaseToken);
    expect(successor.attempts).toBe(previous.attempts + 1);
    expect((await processAiJob(successor, workerDeps, signal)).outcome).toBe(
      "completed",
    );
    expect((await processAiJob(previous, workerDeps, signal)).outcome).toBe(
      "dropped",
    );
    expect((await publicReport(id)).aiReview.decision).toBe("supported");
  });

  it("delayed is projected on deadline, then real convergence publishes failed without exposing job internals", async () => {
    const response = await submit();
    const id = response.body.data.report._id;
    await HazardReport.updateOne(
      { _id: id },
      { $set: { "aiReviewJob.deadlineAt": new Date(0) } },
    );
    expect((await publicReport(id)).aiReview.delayed).toBe(true);
    await convergeStuckAiJobs(new Date());
    expect((await publicReport(id)).aiReview.state).toBe("failed");
  });
});
