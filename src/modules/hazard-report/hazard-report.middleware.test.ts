import express from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";
import {
  ALLOWED_PHOTO_MIME_TYPES,
  uploadPhoto,
} from "./hazard-report.middleware";
import { HAZARD_MSG, HAZARD_REASON } from "../../constants/messages";
import { ResponseCode } from "../../types/code";

function createTestApp() {
  const app = express();
  app.post("/test-upload", uploadPhoto, (req, res) => {
    res.status(200).json({
      ok: true,
      file: req.file
        ? {
            mimetype: req.file.mimetype,
            originalname: req.file.originalname,
            size: req.file.size,
          }
        : null,
    });
  });
  return app;
}

describe("ALLOWED_PHOTO_MIME_TYPES", () => {
  it("includes all 5 supported photo formats", () => {
    expect(ALLOWED_PHOTO_MIME_TYPES.has("image/jpeg")).toBe(true);
    expect(ALLOWED_PHOTO_MIME_TYPES.has("image/png")).toBe(true);
    expect(ALLOWED_PHOTO_MIME_TYPES.has("image/webp")).toBe(true);
    expect(ALLOWED_PHOTO_MIME_TYPES.has("image/heic")).toBe(true);
    expect(ALLOWED_PHOTO_MIME_TYPES.has("image/heif")).toBe(true);
    expect(ALLOWED_PHOTO_MIME_TYPES.size).toBe(5);
  });
});

describe("uploadPhoto middleware", () => {
  const app = createTestApp();

  const allowedFormats = [
    { name: "test.jpg", mime: "image/jpeg" },
    { name: "test.png", mime: "image/png" },
    { name: "test.webp", mime: "image/webp" },
    { name: "test.heic", mime: "image/heic" },
    { name: "test.heif", mime: "image/heif" },
  ];

  for (const { name, mime } of allowedFormats) {
    it(`accepts ${mime} photo`, async () => {
      const res = await request(app)
        .post("/test-upload")
        .attach("photo", Buffer.from("fake-image-data"), {
          filename: name,
          contentType: mime,
        });

      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(res.body.file.mimetype).toBe(mime);
    });
  }

  it("rejects image/gif with 400 and INVALID_PHOTO_TYPE", async () => {
    const res = await request(app)
      .post("/test-upload")
      .attach("photo", Buffer.from("fake-gif-data"), {
        filename: "test.gif",
        contentType: "image/gif",
      });

    expect(res.status).toBe(ResponseCode.INVALID_INPUT);
    expect(res.body.ok).toBe(false);
    expect(res.body.message).toBe(HAZARD_MSG.INVALID_PHOTO_TYPE);
    expect(res.body.data.reason).toBe(HAZARD_REASON.INVALID_PHOTO_TYPE);
  });

  it("rejects application/pdf with 400 and INVALID_PHOTO_TYPE", async () => {
    const res = await request(app)
      .post("/test-upload")
      .attach("photo", Buffer.from("%PDF-1.4"), {
        filename: "document.pdf",
        contentType: "application/pdf",
      });

    expect(res.status).toBe(ResponseCode.INVALID_INPUT);
    expect(res.body.ok).toBe(false);
    expect(res.body.message).toBe(HAZARD_MSG.INVALID_PHOTO_TYPE);
    expect(res.body.data.reason).toBe(HAZARD_REASON.INVALID_PHOTO_TYPE);
  });

  it("allows requests without photo attached to pass to next handler (controller handles PHOTO_REQUIRED)", async () => {
    const res = await request(app).post("/test-upload");
    expect(res.status).toBe(200);
    expect(res.body.file).toBeNull();
  });
});
