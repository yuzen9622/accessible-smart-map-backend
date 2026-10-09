import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { normalizeHazardPhoto } from "./hazard-report.photo";

const image = () =>
  sharp({
    create: {
      width: 64,
      height: 32,
      channels: 3,
      background: { r: 24, g: 111, b: 205 },
    },
  });

describe("real bounded photo decoding", () => {
  for (const format of ["jpeg", "png", "webp"] as const) {
    it(`decodes ${format} and produces a metadata-free, hashed JPEG`, async () => {
      const input = await image()
        .toFormat(format)
        .withMetadata({ orientation: 6 })
        .toBuffer();
      const result = await normalizeHazardPhoto(input, `image/${format}`);
      const meta = await sharp(result.buffer).metadata();
      expect(result.mimeType).toBe("image/jpeg");
      expect(meta.format).toBe("jpeg");
      expect(meta.width).toBe(32);
      expect(meta.height).toBe(64);
      expect(meta.exif).toBeUndefined();
      expect(meta.orientation).toBeUndefined();
      expect(result.imageHash).toBe(
        createHash("sha256").update(result.buffer).digest("hex"),
      );
    });
  }
  for (const format of ["heic", "heif"] as const) {
    it(`decodes actual HEVC ${format} bytes (not a MIME stub)`, async () => {
      const input = readFileSync(
        join(__dirname, "fixtures", `synthetic.${format}`),
      );
      const result = await normalizeHazardPhoto(input, `image/${format}`);
      const meta = await sharp(result.buffer).metadata();
      expect([meta.width, meta.height, meta.format]).toEqual([64, 32, "jpeg"]);
      expect(meta.exif).toBeUndefined();
    });
  }
  it("rejects a declared MIME that does not match real bytes", async () => {
    await expect(
      normalizeHazardPhoto(await image().png().toBuffer(), "image/jpeg"),
    ).rejects.toMatchObject({ code: "IMAGE_INVALID" });
  });
  it("rejects corrupt and truncated photos before any external I/O", async () => {
    for (const bytes of [
      Buffer.alloc(0),
      Buffer.from("not an image"),
      Buffer.from([255, 216, 255, 0, 0]),
    ]) {
      await expect(
        normalizeHazardPhoto(bytes, "image/jpeg"),
      ).rejects.toMatchObject({ code: "IMAGE_INVALID" });
    }
  });
  it("rejects unsupported GIF even when it is called a JPEG", async () => {
    await expect(
      normalizeHazardPhoto(Buffer.from("GIF89a\x01\x00\x01\x00"), "image/jpeg"),
    ).rejects.toMatchObject({ code: "IMAGE_UNSUPPORTED" });
  });
  it("rejects excessive byte size", async () => {
    await expect(
      normalizeHazardPhoto(Buffer.alloc(10 * 1024 * 1024 + 1), "image/jpeg"),
    ).rejects.toMatchObject({ code: "IMAGE_TOO_LARGE" });
  });
  it("checks the pixel bound before allocating full pixel output", async () => {
    const huge = await sharp({
      create: { width: 5001, height: 4000, channels: 3, background: "#ffffff" },
    })
      .png()
      .toBuffer();
    await expect(normalizeHazardPhoto(huge, "image/png")).rejects.toMatchObject(
      { code: "IMAGE_TOO_LARGE" },
    );
  });
  it("bounds output dimensions without upscaling", async () => {
    const input = await sharp({
      create: { width: 2000, height: 1000, channels: 3, background: "#abc123" },
    })
      .png()
      .toBuffer();
    const result = await normalizeHazardPhoto(input, "image/png");
    expect((await sharp(result.buffer).metadata()).width).toBe(1600);
  });
  it("can cancel a running codec without blocking the HTTP thread", async () => {
    const abort = new AbortController();
    const promise = normalizeHazardPhoto(
      await image().png().toBuffer(),
      "image/png",
      { signal: abort.signal },
    );
    // acquire() yields before starting the worker, so abort is deterministic.
    abort.abort();
    await expect(promise).rejects.toBeDefined();
  });
});
