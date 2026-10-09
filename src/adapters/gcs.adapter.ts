import { Storage } from "@google-cloud/storage";
import { HAZARD_AI } from "../config/hazard-ai";
import type { Readable, Writable } from "node:stream";

export class HazardPhotoStorageError extends Error {
  constructor(
    public readonly code: string,
    public readonly retryable = false,
    public readonly circuitBreak = false,
  ) {
    super(code);
    this.name = "HazardPhotoStorageError";
  }
}

function storageFailure(error: unknown): HazardPhotoStorageError {
  if (error instanceof HazardPhotoStorageError) return error;
  const code = Number((error as { code?: unknown })?.code);
  if (code === 404) return new HazardPhotoStorageError("GCS_OBJECT_MISSING");
  if (code === 401 || code === 403)
    return new HazardPhotoStorageError("GCS_PERMISSION_DENIED", false, true);
  if (code === 400) return new HazardPhotoStorageError("GCS_INVALID_RESPONSE");
  return new HazardPhotoStorageError("GCS_TEMPORARILY_UNAVAILABLE", true);
}

interface PhotoIoOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
  maxBytes?: number;
}

/** Complete or destroy a stream, bounded locally even during SDK failures. */
function streamDone<T>(
  stream: Readable | Writable,
  event: "end" | "finish",
  options: PhotoIoOptions,
  value: () => T,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", abort);
    };
    const abort = () =>
      stream.destroy(new HazardPhotoStorageError("GCS_ABORTED", true));
    const timer = setTimeout(() => {
      stream.destroy(new HazardPhotoStorageError("GCS_TIMEOUT", true));
    }, options.timeoutMs ?? HAZARD_AI.providerTimeoutMs);
    options.signal?.addEventListener("abort", abort, { once: true });
    stream.once("error", (error) => {
      cleanup();
      reject(storageFailure(error));
    });
    stream.once(event, () => {
      cleanup();
      resolve(value());
    });
    stream.once("close", () => {
      cleanup();
      reject(new HazardPhotoStorageError("GCS_STREAM_CLOSED", true));
    });
    if (options.signal?.aborted) abort();
  });
}

let storage: Storage | null = null;

function client(): Storage {
  if (!storage) {
    storage = new Storage({
      ...(process.env.GCS_KEY_FILE
        ? { keyFilename: process.env.GCS_KEY_FILE }
        : {}),
      retryOptions: { autoRetry: false, maxRetries: 0 },
    });
  }
  return storage;
}

/**
 * Maps an image MIME type to its standard file extension. Defaults to "jpg".
 *
 * @param mimeType The photo MIME type.
 * @returns The file extension without dot.
 */
export function mimeToPhotoExt(mimeType: string): string {
  switch (mimeType) {
    case "image/png":
      return "png";
    case "image/webp":
      return "webp";
    case "image/heic":
      return "heic";
    case "image/heif":
      return "heif";
    case "image/jpeg":
    default:
      return "jpg";
  }
}

/**
 * Uploads a hazard-report photo to the configured GCS bucket under
 * `reports/{reportId}.{ext}` and returns its public URL and storage path.
 *
 * @param buffer Raw photo bytes.
 * @param reportId The report's ObjectId string, used as the object name.
 * @param mimeType The photo MIME type (`image/jpeg`, `image/png`, `image/webp`, `image/heic`, `image/heif`).
 * @returns The public URL and the bucket-internal storage path.
 */
export function getHazardPhotoStoragePath(
  reportId: string,
  mimeType: string,
): string {
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(reportId))
    throw new HazardPhotoStorageError("GCS_INVALID_PATH");
  return `reports/${reportId}.${mimeToPhotoExt(mimeType)}`;
}

export async function uploadHazardPhoto(
  buffer: Buffer,
  reportId: string,
  mimeType: string,
  options: PhotoIoOptions = {},
): Promise<{ url: string; storagePath: string }> {
  const bucketName = process.env.GCS_BUCKET_NAME ?? "";
  const storagePath = getHazardPhotoStoragePath(reportId, mimeType);
  if (buffer.length > HAZARD_AI.imageMaxBytes)
    throw new HazardPhotoStorageError("GCS_IMAGE_TOO_LARGE");
  options.signal?.throwIfAborted();
  const stream = client()
    .bucket(bucketName)
    .file(storagePath)
    .createWriteStream({
      contentType: mimeType,
      resumable: false,
      timeout: options.timeoutMs ?? HAZARD_AI.uploadTimeoutMs,
      metadata: { cacheControl: hazardPhotoCacheControl() },
    });
  const completion = streamDone(
    stream,
    "finish",
    {
      ...options,
      timeoutMs: options.timeoutMs ?? HAZARD_AI.uploadTimeoutMs,
    },
    () => undefined,
  );
  stream.end(buffer);
  await completion;
  return {
    url: `https://storage.googleapis.com/${bucketName}/${storagePath}`,
    storagePath,
  };
}

/** Read DB-owned canonical keys only; never fetch arbitrary public URLs. */
export async function readHazardPhoto(
  storagePath: string,
  options: PhotoIoOptions = {},
): Promise<Buffer> {
  if (!/^reports\/[0-9a-f]{24}\.(jpg|png|webp|heic|heif)$/.test(storagePath))
    throw new HazardPhotoStorageError("GCS_INVALID_PATH");
  options.signal?.throwIfAborted();
  const maxBytes = Math.min(
    options.maxBytes ?? HAZARD_AI.imageMaxBytes,
    HAZARD_AI.imageMaxBytes,
  );
  const stream = client()
    .bucket(process.env.GCS_BUCKET_NAME ?? "")
    .file(storagePath)
    .createReadStream({ decompress: false, validation: "crc32c" });
  let length = 0;
  const chunks: Buffer[] = [];
  const result = streamDone(stream, "end", options, () =>
    Buffer.concat(chunks, length),
  );
  stream.on("data", (chunk: Buffer) => {
    length += chunk.length;
    if (length > maxBytes)
      stream.destroy(new HazardPhotoStorageError("GCS_IMAGE_TOO_LARGE"));
    else chunks.push(chunk);
  });
  return result;
}

/**
 * Private photos must not persist in browser or intermediary caches.
 *
 * @returns The header value
 */
export function hazardPhotoCacheControl(): string {
  return "private, no-store";
}

/**
 * Lists hazard photo object names, one page at a time.
 *
 * @param pageToken Token from the previous page, if any
 * @returns Object names and the next page token
 */
export async function listHazardPhotoPage(
  pageToken?: string,
): Promise<{ names: string[]; nextPageToken?: string }> {
  const bucketName = process.env.GCS_BUCKET_NAME ?? "";
  const [files, nextQuery] = await client().bucket(bucketName).getFiles({
    prefix: "reports/",
    maxResults: 500,
    pageToken,
    autoPaginate: false,
  });
  return {
    names: files.map((file) => file.name),
    nextPageToken: (nextQuery as { pageToken?: string } | null)?.pageToken,
  };
}

/**
 * Rewrites one hazard photo's Cache-Control to the current policy value.
 *
 * @param storagePath The bucket-internal path
 */
export async function setHazardPhotoCacheControl(
  storagePath: string,
): Promise<void> {
  const bucketName = process.env.GCS_BUCKET_NAME ?? "";
  await client()
    .bucket(bucketName)
    .file(storagePath)
    .setMetadata({ cacheControl: hazardPhotoCacheControl() });
}

/**
 * Deletes a hazard-report photo from the bucket. No-op if the object is gone.
 *
 * @param storagePath The bucket-internal path returned by `uploadHazardPhoto`.
 */
export async function deleteHazardPhoto(storagePath: string): Promise<void> {
  const bucketName = process.env.GCS_BUCKET_NAME ?? "";
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      client()
        .bucket(bucketName)
        .file(storagePath)
        .delete({ ignoreNotFound: true }),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new HazardPhotoStorageError("GCS_TIMEOUT", true)),
          HAZARD_AI.providerTimeoutMs,
        );
      }),
    ]);
  } catch (error) {
    throw storageFailure(error);
  } finally {
    clearTimeout(timer);
  }
}
