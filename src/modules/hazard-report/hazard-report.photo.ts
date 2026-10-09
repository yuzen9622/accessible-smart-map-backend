import { createHash } from "node:crypto";
import { Worker } from "node:worker_threads";
import { HAZARD_AI } from "../../config/hazard-ai";
import { PHOTO_DECODER_SOURCE } from "./hazard-report.photo-worker";
import type { PhotoMimeType } from "./hazard-report.types";

export type PhotoErrorCode =
  | "IMAGE_INVALID"
  | "IMAGE_UNSUPPORTED"
  | "IMAGE_TOO_LARGE"
  | "PHOTO_PROCESSING_UNAVAILABLE";
export class PhotoNormalizationError extends Error {
  constructor(public readonly code: PhotoErrorCode) {
    super(code);
    this.name = "PhotoNormalizationError";
  }
}
export interface NormalizedHazardPhoto {
  buffer: Buffer;
  mimeType: "image/jpeg";
  imageHash: string;
}

/** Detect a supported container from bytes, never from a caller's file name. */
function imageKind(bytes: Buffer): "jpeg" | "png" | "webp" | "heif" | null {
  if (
    bytes.length >= 3 &&
    bytes[0] === 0xff &&
    bytes[1] === 0xd8 &&
    bytes[2] === 0xff
  )
    return "jpeg";
  if (
    bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  )
    return "png";
  if (
    bytes.length >= 12 &&
    bytes.toString("ascii", 0, 4) === "RIFF" &&
    bytes.toString("ascii", 8, 12) === "WEBP"
  )
    return "webp";
  if (bytes.length >= 16 && bytes.toString("ascii", 4, 8) === "ftyp") {
    const size = bytes.readUInt32BE(0);
    if (size < 16 || size > bytes.length || size > 512 || size % 4 !== 0)
      return null;
    const brands = [bytes.toString("ascii", 8, 12)];
    for (let i = 16; i < size; i += 4)
      brands.push(bytes.toString("ascii", i, i + 4));
    if (brands.some((b) => b === "avif" || b === "avis")) return null;
    if (
      brands.some((b) => /^(heic|heix|hevc|hevx|heim|heis|mif1|msf1)$/.test(b))
    )
      return "heif";
  }
  return null;
}

let active = 0;
const waiting: Array<() => void> = [];
async function acquire(): Promise<() => void> {
  if (active >= HAZARD_AI.decodeConcurrency) {
    if (waiting.length >= HAZARD_AI.decodeQueueLimit)
      throw new PhotoNormalizationError("PHOTO_PROCESSING_UNAVAILABLE");
    await new Promise<void>((resolve) => waiting.push(resolve));
  } else {
    active++;
  }
  return () => {
    const next = waiting.shift();
    if (next) next();
    else active--;
  };
}

/**
 * Complete decode and bounded JPEG normalization before ANY merge or vote.
 * The caller must inspect EXIF on original bytes first. No I/O or persistence.
 */
export async function normalizeHazardPhoto(
  bytes: Buffer,
  declaredMime: PhotoMimeType,
  options: { signal?: AbortSignal } = {},
): Promise<NormalizedHazardPhoto> {
  if (bytes.length === 0) throw new PhotoNormalizationError("IMAGE_INVALID");
  if (bytes.length > HAZARD_AI.uploadMaxBytes)
    throw new PhotoNormalizationError("IMAGE_TOO_LARGE");
  const kind = imageKind(bytes);
  if (!kind) {
    const recognizableOther =
      bytes.toString("ascii", 0, 3) === "GIF" ||
      bytes.toString("ascii", 4, 8) === "ftyp";
    throw new PhotoNormalizationError(
      recognizableOther ? "IMAGE_UNSUPPORTED" : "IMAGE_INVALID",
    );
  }
  const matches =
    kind === "heif"
      ? declaredMime === "image/heic" || declaredMime === "image/heif"
      : declaredMime === `image/${kind}`;
  if (!matches) throw new PhotoNormalizationError("IMAGE_INVALID");
  const release = await acquire();
  let worker: Worker | undefined;
  try {
    options.signal?.throwIfAborted();
    worker = new Worker(PHOTO_DECODER_SOURCE, {
      eval: true,
      execArgv: [],
      stdout: true,
      stderr: true,
      resourceLimits: {
        maxOldGenerationSizeMb: 96,
        maxYoungGenerationSizeMb: 16,
      },
      workerData: {
        bytes: Uint8Array.from(bytes),
        heif: kind === "heif",
        sharpPath: require.resolve("sharp"),
        heifPath: require.resolve("libheif-js/wasm-bundle"),
        limits: {
          maxPixels: HAZARD_AI.imageMaxPixels,
          maxBytes: HAZARD_AI.imageMaxBytes,
          maxDimension: HAZARD_AI.imageMaxDimension,
        },
      },
    });
    // Library diagnostics are not application logs and can contain raw input.
    worker.stdout?.resume();
    worker.stderr?.resume();
    const current = worker;
    const output = await new Promise<Buffer>((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timer);
        options.signal?.removeEventListener("abort", abort);
      };
      const abort = () => {
        cleanup();
        reject(new PhotoNormalizationError("PHOTO_PROCESSING_UNAVAILABLE"));
      };
      const timer = setTimeout(abort, HAZARD_AI.decodeTimeoutMs);
      options.signal?.addEventListener("abort", abort, { once: true });
      if (options.signal?.aborted) return abort();
      current.once(
        "message",
        (message: { bytes?: Uint8Array; code?: PhotoErrorCode }) => {
          cleanup();
          if (message.code)
            return reject(new PhotoNormalizationError(message.code));
          if (!message.bytes)
            return reject(new PhotoNormalizationError("IMAGE_INVALID"));
          resolve(Buffer.from(message.bytes));
        },
      );
      current.once("error", () => {
        cleanup();
        reject(new PhotoNormalizationError("IMAGE_INVALID"));
      });
      current.once("exit", () => {
        cleanup();
        // Even a clean codec exit without a message must settle the promise.
        reject(new PhotoNormalizationError("IMAGE_INVALID"));
      });
    });
    return {
      buffer: output,
      mimeType: "image/jpeg",
      imageHash: createHash("sha256").update(output).digest("hex"),
    };
  } finally {
    await worker?.terminate();
    release();
  }
}
