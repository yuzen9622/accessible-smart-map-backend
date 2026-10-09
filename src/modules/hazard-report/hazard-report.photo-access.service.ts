import { readHazardPhoto } from "../../adapters/gcs.adapter";
import { ResponseCode, ResponseMessage } from "../../types/code";
import { findReportById } from "./hazard-report.repository";
import { normalizeHazardPhoto } from "./hazard-report.photo";
import type { PhotoMimeType, ServiceResult } from "./hazard-report.types";

const PHOTO_UNAVAILABLE = "PHOTO_UNAVAILABLE";
const PHOTO_NOT_FOUND = "PHOTO_NOT_FOUND";

/** Only the configured bucket and this report's own key may be read. */
export function resolvePhotoKey(
  id: string,
  report: { photoStoragePath?: string; photoUrl?: string },
): string | undefined {
  let key = report.photoStoragePath;
  if (!key && report.photoUrl) {
    const bucket = process.env.GCS_BUCKET_NAME;
    if (!bucket) return undefined;
    try {
      const url = new URL(report.photoUrl);
      if (
        url.origin !== "https://storage.googleapis.com" ||
        url.username ||
        url.password ||
        url.search ||
        url.hash ||
        !url.pathname.startsWith(`/${bucket}/`)
      )
        return undefined;
      key = url.pathname.slice(bucket.length + 2);
    } catch {
      return undefined;
    }
  }
  return key &&
    new RegExp(`^reports/${id.toLowerCase()}\\.(jpg|png|webp|heic|heif)$`).test(
      key,
    )
    ? key
    : undefined;
}

function failure(
  httpCode: ResponseCode,
  reason: string,
): ServiceResult & { ok: false } {
  return {
    ok: false,
    httpCode,
    message:
      httpCode === ResponseCode.NOT_FOUND
        ? ResponseMessage.NOT_FOUND
        : ResponseMessage.SERVICE_UNAVAILABLE,
    data: { reason },
  };
}

/** Authorize before GCS I/O; recheck after I/O so concurrent scrubbing wins. */
export async function getPrivateReportPhoto(
  id: string,
  identity: { userId: string; admin: boolean },
  signal?: AbortSignal,
): Promise<
  | (ServiceResult & { ok: false })
  | { ok: true; buffer: Buffer; mimeType: "image/jpeg" }
> {
  const mayRead = (report: Awaited<ReturnType<typeof findReportById>>) =>
    report &&
    !report.contentScrubbedAt &&
    !report.deidentifiedAt &&
    (identity.admin || report.reporterId === identity.userId);
  try {
    const report = await findReportById(id);
    if (!mayRead(report))
      return failure(ResponseCode.NOT_FOUND, PHOTO_NOT_FOUND);
    const key = resolvePhotoKey(id, report!);
    if (!key) return failure(ResponseCode.NOT_FOUND, PHOTO_NOT_FOUND);
    const bytes = await readHazardPhoto(key, { signal });
    const ext = key.slice(key.lastIndexOf(".") + 1);
    const mime = `image/${ext === "jpg" ? "jpeg" : ext}` as PhotoMimeType;
    // Bounded full decode strips legacy metadata and converts HEIC/HEIF too.
    // No response headers are committed until storage/decode succeeds.
    const photo = await normalizeHazardPhoto(bytes, mime, { signal });
    const current = await findReportById(id);
    if (!mayRead(current) || resolvePhotoKey(id, current!) !== key)
      return failure(ResponseCode.NOT_FOUND, PHOTO_NOT_FOUND);
    return { ok: true, buffer: photo.buffer, mimeType: photo.mimeType };
  } catch (error) {
    const code = (error as { code?: string })?.code;
    return code === "GCS_OBJECT_MISSING"
      ? failure(ResponseCode.NOT_FOUND, PHOTO_NOT_FOUND)
      : failure(ResponseCode.SERVICE_UNAVAILABLE, PHOTO_UNAVAILABLE);
  }
}
