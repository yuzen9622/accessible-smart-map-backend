import { ImageAnnotatorClient } from "@google-cloud/vision";
import { HAZARD_AI } from "../config/hazard-ai";
import { withDeadline } from "../utils/with-deadline";

let annotator: ImageAnnotatorClient | null = null;
function client(): ImageAnnotatorClient {
  if (!annotator) {
    annotator = new ImageAnnotatorClient(
      process.env.GCS_KEY_FILE ? { keyFilename: process.env.GCS_KEY_FILE } : {},
    );
  }
  return annotator;
}

export class VisionCheckError extends Error {
  constructor(
    public readonly code: string,
    public readonly retryable = false,
    public readonly circuitBreak = false,
  ) {
    super(code);
    this.name = "VisionCheckError";
  }
}
function visionFailure(error: unknown): VisionCheckError {
  if (error instanceof VisionCheckError) return error;
  const code = Number((error as { code?: unknown })?.code);
  if ([7, 16, 401, 403].includes(code))
    return new VisionCheckError("VISION_PERMISSION_DENIED", false, true);
  if ([3, 5, 400, 404].includes(code))
    return new VisionCheckError("VISION_RESPONSE_ERROR");
  return new VisionCheckError("VISION_UNAVAILABLE", true);
}

const LIKELIHOOD: Record<string, number> = {
  VERY_UNLIKELY: 1,
  UNLIKELY: 2,
  POSSIBLE: 3,
  LIKELY: 4,
  VERY_LIKELY: 5,
};
function likelihood(value: unknown): number | null {
  if (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= 1 &&
    value <= 5
  )
    return value;
  return typeof value === "string" ? (LIKELIHOOD[value] ?? null) : null;
}

export interface VisionPrefilter {
  passed: boolean;
  detectedLabels: string[];
  safeSearchBlocked: boolean;
}

/** RPC and per-image failures are NOT successful safety checks. */
export async function prefilterImage(
  buffer: Buffer,
  options: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<VisionPrefilter> {
  const timeoutMs = Math.min(
    options.timeoutMs ?? HAZARD_AI.providerTimeoutMs,
    HAZARD_AI.providerTimeoutMs,
  );
  try {
    const [batch] = await withDeadline(
      () =>
        client().batchAnnotateImages(
          {
            requests: [
              {
                image: { content: buffer },
                features: [
                  { type: "LABEL_DETECTION", maxResults: 10 },
                  { type: "OBJECT_LOCALIZATION", maxResults: 10 },
                  { type: "SAFE_SEARCH_DETECTION" },
                ],
              },
            ],
          },
          { timeout: timeoutMs, retry: null },
        ),
      { signal: options.signal, timeoutMs },
      () => new VisionCheckError("VISION_TIMEOUT", true),
    );
    const result = batch.responses?.[0];
    if (!result) throw new VisionCheckError("VISION_RESPONSE_ERROR", true);
    if (result.error && (result.error.code || result.error.message))
      throw visionFailure(result.error);
    const safe = result.safeSearchAnnotation;
    if (!safe) throw new VisionCheckError("VISION_SAFETY_INCOMPLETE", true);
    const adult = likelihood(safe.adult),
      violence = likelihood(safe.violence);
    const racy = likelihood(safe.racy),
      spoof = likelihood(safe.spoof);
    if (adult === null || violence === null || racy === null || spoof === null)
      throw new VisionCheckError("VISION_SAFETY_INCOMPLETE", true);
    const safeSearchBlocked =
      adult >= 4 || violence >= 4 || racy >= 4 || spoof >= 5;
    const labels = [
      ...(result.labelAnnotations ?? []).map((l) => l.description ?? ""),
      ...(result.localizedObjectAnnotations ?? []).map((o) => o.name ?? ""),
    ]
      .filter(Boolean)
      .map((s) => s.slice(0, 80));
    return {
      passed: !safeSearchBlocked,
      detectedLabels: Array.from(new Set(labels)).slice(0, 12),
      safeSearchBlocked,
    };
  } catch (error) {
    throw visionFailure(error);
  }
}
