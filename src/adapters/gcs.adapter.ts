import { getRetentionConfig } from "../config/retention";
import { Storage } from "@google-cloud/storage";

let storage: Storage | null = null;

function client(): Storage {
  if (!storage) {
    storage = new Storage(
      process.env.GCS_KEY_FILE ? { keyFilename: process.env.GCS_KEY_FILE } : {},
    );
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
export async function uploadHazardPhoto(
  buffer: Buffer,
  reportId: string,
  mimeType: string,
): Promise<{ url: string; storagePath: string }> {
  const bucketName = process.env.GCS_BUCKET_NAME ?? "";
  const ext = mimeToPhotoExt(mimeType);
  const storagePath = `reports/${reportId}.${ext}`;

  await client()
    .bucket(bucketName)
    .file(storagePath)
    .save(buffer, {
      contentType: mimeType,
      resumable: false,
      metadata: { cacheControl: hazardPhotoCacheControl() },
    });

  return {
    url: `https://storage.googleapis.com/${bucketName}/${storagePath}`,
    storagePath,
  };
}

/**
 * Cache-Control for hazard photos. Kept short (≤ the retention safety margin)
 * because a public object served with a long max-age can outlive its deletion
 * in browser and intermediary caches.
 *
 * @returns The header value
 */
export function hazardPhotoCacheControl(): string {
  return `public, max-age=${getRetentionConfig().hazardPhotoCacheMaxAgeSec}`;
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
  await client()
    .bucket(bucketName)
    .file(storagePath)
    .delete({ ignoreNotFound: true });
}
