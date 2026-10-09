import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const mock = vi.hoisted(() => ({ batch: vi.fn() }));
vi.mock("@google-cloud/vision", () => ({
  ImageAnnotatorClient: class {
    batchAnnotateImages = mock.batch;
  },
}));
import { prefilterImage } from "./vision.adapter";
const safe = { adult: 1, violence: 1, racy: 1, spoof: 1 };
function response(extra = {}) {
  return [{ responses: [{ safeSearchAnnotation: safe, ...extra }] }];
}
beforeEach(() => {
  vi.clearAllMocks();
  mock.batch.mockResolvedValue(response());
});
afterEach(() => vi.useRealTimers());
describe("fail-closed Vision RPC", () => {
  it("requests safety and object hints with native retries disabled", async () => {
    expect(await prefilterImage(Buffer.from("bytes"))).toMatchObject({
      passed: true,
      safeSearchBlocked: false,
    });
    expect(mock.batch.mock.calls[0][1]).toEqual({
      timeout: 10000,
      retry: null,
    });
  });
  it("accepts known string likelihood enums and bounds hint labels", async () => {
    mock.batch.mockResolvedValue(
      response({
        safeSearchAnnotation: {
          adult: "VERY_UNLIKELY",
          violence: "UNLIKELY",
          racy: "POSSIBLE",
          spoof: "VERY_UNLIKELY",
        },
        labelAnnotations: Array.from({ length: 15 }, (_, i) => ({
          description: `${i}${"x".repeat(90)}`,
        })),
      }),
    );
    const result = await prefilterImage(Buffer.from("bytes"));
    expect(result.passed).toBe(true);
    expect(result.detectedLabels).toHaveLength(12);
    expect(result.detectedLabels.every((x) => x.length <= 80)).toBe(true);
  });
  it.each([
    undefined,
    {},
    { ...safe, adult: 0 },
    { ...safe, spoof: "UNKNOWN" },
  ])("rejects incomplete safety (%j)", async (annotation) => {
    mock.batch.mockResolvedValue(
      response({ safeSearchAnnotation: annotation }),
    );
    await expect(prefilterImage(Buffer.from("bytes"))).rejects.toMatchObject({
      code: "VISION_SAFETY_INCOMPLETE",
      retryable: true,
    });
  });
  it("blocks likely unsafe photos", async () => {
    mock.batch.mockResolvedValue(
      response({ safeSearchAnnotation: { ...safe, adult: 4 } }),
    );
    expect(await prefilterImage(Buffer.from("bytes"))).toMatchObject({
      passed: false,
      safeSearchBlocked: true,
    });
  });
  it("checks per-image failures even on a successful batch RPC", async () => {
    mock.batch.mockResolvedValue(
      response({ error: { code: 3, message: "private detail" } }),
    );
    await expect(prefilterImage(Buffer.from("bytes"))).rejects.toMatchObject({
      code: "VISION_RESPONSE_ERROR",
      retryable: false,
    });
    mock.batch.mockResolvedValue([{ responses: [] }]);
    await expect(prefilterImage(Buffer.from("bytes"))).rejects.toMatchObject({
      code: "VISION_RESPONSE_ERROR",
    });
  });
  it("treats credentials as a circuit-breaking failure", async () => {
    mock.batch.mockRejectedValue({ code: 7, message: "secret" });
    await expect(prefilterImage(Buffer.from("bytes"))).rejects.toMatchObject({
      code: "VISION_PERMISSION_DENIED",
      retryable: false,
      circuitBreak: true,
    });
  });
  it("has a local timeout even when the SDK promise does not settle", async () => {
    vi.useFakeTimers();
    mock.batch.mockReturnValue(new Promise(() => {}));
    const assertion = expect(
      prefilterImage(Buffer.from("bytes"), { timeoutMs: 5 }),
    ).rejects.toMatchObject({ code: "VISION_TIMEOUT", retryable: true });
    await vi.advanceTimersByTimeAsync(5);
    await assertion;
  });
});
