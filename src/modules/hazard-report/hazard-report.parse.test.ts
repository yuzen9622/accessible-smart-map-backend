import { describe, it, expect } from "vitest";
import {
  parseAiVerifyResult,
  parseExifDateTime,
  parsePhotoExif,
} from "./hazard-report.parse";

describe("parseAiVerifyResult", () => {
  it("parses a clean JSON verdict", () => {
    const r = parseAiVerifyResult(
      '{"verdict":"verified","confidence":0.87,"reason":"街景實拍"}',
    );
    expect(r).toEqual({
      verdict: "verified",
      confidence: 0.87,
      reason: "街景實拍",
    });
  });

  it("tolerates code fences and surrounding prose", () => {
    const r = parseAiVerifyResult(
      '判斷如下：```json\n{"verdict":"suspicious","confidence":0.4,"reason":"障礙不明確"}\n```',
    );
    expect(r.verdict).toBe("suspicious");
    expect(r.confidence).toBe(0.4);
  });

  it("clamps confidence into [0,1]", () => {
    expect(
      parseAiVerifyResult('{"verdict":"rejected","confidence":5,"reason":"x"}')
        .confidence,
    ).toBe(1);
    expect(
      parseAiVerifyResult('{"verdict":"rejected","confidence":-2,"reason":"x"}')
        .confidence,
    ).toBe(0);
  });

  it("degrades unknown / non-JSON payloads to skipped", () => {
    expect(parseAiVerifyResult("沒有 JSON").verdict).toBe("skipped");
    expect(parseAiVerifyResult('{"verdict":"weird"}').verdict).toBe("skipped");
  });
});

describe("parseExifDateTime", () => {
  it("applies the photo's own offset tag", () => {
    expect(
      parseExifDateTime("2026:06:25 22:30:00", "+08:00")?.toISOString(),
    ).toBe("2026-06-25T14:30:00.000Z");
  });

  it("assumes Asia/Taipei (UTC+8) when the photo has no offset tag", () => {
    expect(parseExifDateTime("2026:06:25 22:30:00")?.toISOString()).toBe(
      "2026-06-25T14:30:00.000Z",
    );
  });

  it("handles negative and compact offsets", () => {
    expect(
      parseExifDateTime("2026:06:25 09:00:00", "-0530")?.toISOString(),
    ).toBe("2026-06-25T14:30:00.000Z");
  });

  it("returns null for missing or malformed input", () => {
    expect(parseExifDateTime(null)).toBeNull();
    expect(parseExifDateTime("not a date")).toBeNull();
  });
});

describe("parsePhotoExif", () => {
  it("passes a buffer with no readable EXIF (missing time is allowed)", async () => {
    const r = await parsePhotoExif(
      Buffer.from("not an image"),
      25,
      121,
      new Date(),
    );
    expect(r.timestampFresh).toBe(true);
    expect(r.rawExifTime).toBeUndefined();
    expect(r.gpsPresent).toBe(false);
    expect(r.gpsMatchesClaimed).toBe(false);
  });
});
