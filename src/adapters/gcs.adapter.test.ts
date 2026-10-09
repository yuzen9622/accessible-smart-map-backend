import { Readable, Writable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  write: vi.fn(),
  read: vi.fn(),
  delete: vi.fn(),
  file: vi.fn(),
  bucket: vi.fn(),
  constructor: vi.fn(),
}));
vi.mock("@google-cloud/storage", () => ({
  Storage: class {
    constructor(options: unknown) {
      mocks.constructor(options);
    }
    bucket = mocks.bucket;
  },
}));
import {
  deleteHazardPhoto,
  getHazardPhotoStoragePath,
  mimeToPhotoExt,
  readHazardPhoto,
  uploadHazardPhoto,
} from "./gcs.adapter";

let written: Buffer[];
const path = "reports/000000000000000000000001.jpg";
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("GCS_BUCKET_NAME", "test-hazard-bucket");
  written = [];
  mocks.write.mockImplementation(
    () =>
      new Writable({
        write(chunk, _enc, cb) {
          written.push(Buffer.from(chunk));
          cb();
        },
      }),
  );
  mocks.read.mockImplementation(() =>
    Readable.from([Buffer.from("photo-bytes")]),
  );
  mocks.delete.mockResolvedValue(undefined);
  mocks.file.mockReturnValue({
    createWriteStream: mocks.write,
    createReadStream: mocks.read,
    delete: mocks.delete,
  });
  mocks.bucket.mockReturnValue({ file: mocks.file });
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe("photo extensions and guarded object paths", () => {
  for (const [mime, ext] of [
    ["jpeg", "jpg"],
    ["png", "png"],
    ["webp", "webp"],
    ["heic", "heic"],
    ["heif", "heif"],
  ]) {
    it(`maps ${mime}`, () => expect(mimeToPhotoExt(`image/${mime}`)).toBe(ext));
  }
  it("retains unknown MIME fallback", () => {
    expect(mimeToPhotoExt("application/octet-stream")).toBe("jpg");
    expect(mimeToPhotoExt("")).toBe("jpg");
  });
  it("rejects traversal and URLs before contacting storage", () => {
    for (const id of ["../secret", "https://example.com", "", "a/b"])
      expect(() => getHazardPhotoStoragePath(id, "image/jpeg")).toThrow(
        "GCS_INVALID_PATH",
      );
    expect(mocks.bucket).not.toHaveBeenCalled();
  });
});

describe("bounded uploads", () => {
  for (const [mime, ext] of [
    ["jpeg", "jpg"],
    ["png", "png"],
    ["webp", "webp"],
    ["heic", "heic"],
    ["heif", "heif"],
  ]) {
    it(`streams ${mime} bytes with correct path and cache policy`, async () => {
      const buffer = Buffer.from("photo-bytes");
      const res = await uploadHazardPhoto(
        buffer,
        "report-123",
        `image/${mime}`,
      );
      expect(mocks.bucket).toHaveBeenCalledWith("test-hazard-bucket");
      expect(mocks.file).toHaveBeenCalledWith(`reports/report-123.${ext}`);
      expect(mocks.write).toHaveBeenCalledWith({
        contentType: `image/${mime}`,
        resumable: false,
        timeout: 40000,
        metadata: { cacheControl: "private, no-store" },
      });
      expect(Buffer.concat(written)).toEqual(buffer);
      expect(res).toEqual({
        url: `https://storage.googleapis.com/test-hazard-bucket/reports/report-123.${ext}`,
        storagePath: `reports/report-123.${ext}`,
      });
    });
  }
  it("does not return success on a stream permission error", async () => {
    mocks.write.mockImplementation(
      () =>
        new Writable({
          write(_chunk, _enc, cb) {
            cb(
              Object.assign(new Error("private provider detail"), {
                code: 403,
              }),
            );
          },
        }),
    );
    await expect(
      uploadHazardPhoto(Buffer.from("x"), "id", "image/jpeg"),
    ).rejects.toMatchObject({
      code: "GCS_PERMISSION_DENIED",
      retryable: false,
      circuitBreak: true,
    });
  });
  it("destroys a stalled upload at its local deadline", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    mocks.write.mockImplementation(() => new Writable({ write() {} }));
    const promise = uploadHazardPhoto(Buffer.from("x"), "id", "image/jpeg", {
      timeoutMs: 5,
    });
    const assertion = expect(promise).rejects.toMatchObject({
      code: "GCS_TIMEOUT",
    });
    await vi.advanceTimersByTimeAsync(5);
    await assertion;
  });
});

describe("bounded canonical reads", () => {
  it("reads only the stored canonical key with CRC validation", async () => {
    expect(await readHazardPhoto(path)).toEqual(Buffer.from("photo-bytes"));
    expect(mocks.read).toHaveBeenCalledWith({
      decompress: false,
      validation: "crc32c",
    });
  });
  it("does not fetch arbitrary URLs, alternate formats or traversal", async () => {
    for (const key of [
      "https://example.com/image.jpg",
      "reports/../secret",
      "reports/report-123.jpg",
      path.replace(".jpg", ".svg"),
    ])
      await expect(readHazardPhoto(key)).rejects.toMatchObject({
        code: "GCS_INVALID_PATH",
      });
    expect(mocks.bucket).not.toHaveBeenCalled();
  });
  it("destroys oversized responses instead of buffering unlimited content", async () => {
    await expect(readHazardPhoto(path, { maxBytes: 3 })).rejects.toMatchObject({
      code: "GCS_IMAGE_TOO_LARGE",
    });
  });
  it("maps a missing object to terminal failure without provider detail", async () => {
    mocks.read.mockImplementation(
      () =>
        new Readable({
          read() {
            this.destroy(
              Object.assign(new Error("private path"), { code: 404 }),
            );
          },
        }),
    );
    await expect(readHazardPhoto(path)).rejects.toMatchObject({
      code: "GCS_OBJECT_MISSING",
      retryable: false,
    });
  });
  it("destroys an aborted response", async () => {
    mocks.read.mockImplementation(() => new Readable({ read() {} }));
    const controller = new AbortController();
    const promise = readHazardPhoto(path, { signal: controller.signal });
    controller.abort();
    await expect(promise).rejects.toMatchObject({ code: "GCS_ABORTED" });
  });
});

describe("bounded idempotent deletion", () => {
  it("ignores object absence", async () => {
    await deleteHazardPhoto(path);
    expect(mocks.delete).toHaveBeenCalledWith({ ignoreNotFound: true });
  });
  it("propagates safe cleanup failures for tombstone retry", async () => {
    mocks.delete.mockRejectedValue(
      Object.assign(new Error("credentials"), { code: 403 }),
    );
    await expect(deleteHazardPhoto(path)).rejects.toMatchObject({
      code: "GCS_PERMISSION_DENIED",
      circuitBreak: true,
    });
  });
});
