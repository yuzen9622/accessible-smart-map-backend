import { beforeEach, describe, expect, it, vi } from "vitest";

const mockSave = vi.fn().mockResolvedValue(undefined);
const mockDelete = vi.fn().mockResolvedValue(undefined);
const mockFile = vi.fn().mockReturnValue({
  save: mockSave,
  delete: mockDelete,
});
const mockBucket = vi.fn().mockReturnValue({
  file: mockFile,
});

vi.mock("@google-cloud/storage", () => ({
  Storage: class {
    bucket = mockBucket;
  },
}));

import {
  deleteHazardPhoto,
  mimeToPhotoExt,
  uploadHazardPhoto,
} from "./gcs.adapter";

beforeEach(() => {
  vi.clearAllMocks();
  process.env.GCS_BUCKET_NAME = "test-hazard-bucket";
});

describe("mimeToPhotoExt", () => {
  it("maps image/jpeg to jpg", () => {
    expect(mimeToPhotoExt("image/jpeg")).toBe("jpg");
  });

  it("maps image/png to png", () => {
    expect(mimeToPhotoExt("image/png")).toBe("png");
  });

  it("maps image/webp to webp", () => {
    expect(mimeToPhotoExt("image/webp")).toBe("webp");
  });

  it("maps image/heic to heic", () => {
    expect(mimeToPhotoExt("image/heic")).toBe("heic");
  });

  it("maps image/heif to heif", () => {
    expect(mimeToPhotoExt("image/heif")).toBe("heif");
  });

  it("defaults unknown MIME type to jpg", () => {
    expect(mimeToPhotoExt("application/octet-stream")).toBe("jpg");
    expect(mimeToPhotoExt("")).toBe("jpg");
  });
});

describe("uploadHazardPhoto", () => {
  const formats = [
    { mime: "image/jpeg", expectedExt: "jpg" },
    { mime: "image/png", expectedExt: "png" },
    { mime: "image/webp", expectedExt: "webp" },
    { mime: "image/heic", expectedExt: "heic" },
    { mime: "image/heif", expectedExt: "heif" },
  ];

  for (const { mime, expectedExt } of formats) {
    it(`uploads ${mime} with .${expectedExt} extension to bucket`, async () => {
      const buffer = Buffer.from("photo-bytes");
      const reportId = "report-123";

      const res = await uploadHazardPhoto(buffer, reportId, mime);

      expect(mockBucket).toHaveBeenCalledWith("test-hazard-bucket");
      expect(mockFile).toHaveBeenCalledWith(
        `reports/report-123.${expectedExt}`,
      );
      expect(mockSave).toHaveBeenCalledWith(buffer, {
        contentType: mime,
        resumable: false,
        metadata: { cacheControl: "public, max-age=31536000" },
      });
      expect(res).toEqual({
        url: `https://storage.googleapis.com/test-hazard-bucket/reports/report-123.${expectedExt}`,
        storagePath: `reports/report-123.${expectedExt}`,
      });
    });
  }
});

describe("deleteHazardPhoto", () => {
  it("deletes file ignoring not-found errors", async () => {
    await deleteHazardPhoto("reports/report-123.webp");

    expect(mockBucket).toHaveBeenCalledWith("test-hazard-bucket");
    expect(mockFile).toHaveBeenCalledWith("reports/report-123.webp");
    expect(mockDelete).toHaveBeenCalledWith({ ignoreNotFound: true });
  });
});
