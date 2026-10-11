import { readHazardPhoto } from "../../adapters/gcs.adapter";
import { HAZARD_AI } from "../../config/hazard-ai";
import { ResponseCode, ResponseMessage } from "../../types/code";
import { findReportById } from "./hazard-report.repository";
import { normalizeHazardPhoto } from "./hazard-report.photo";
import type { PhotoMimeType, ServiceResult } from "./hazard-report.types";
import {
  isPublicReportPhoto,
  resolvePhotoKey,
} from "./hazard-report.photo-policy";

export { resolvePhotoKey } from "./hazard-report.photo-policy";

const PHOTO_UNAVAILABLE = "PHOTO_UNAVAILABLE";
const PHOTO_NOT_FOUND = "PHOTO_NOT_FOUND";

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

type PhotoAccessResult =
  | (ServiceResult & { ok: false })
  | { ok: true; buffer: Buffer; mimeType: "image/jpeg" };
type StoredReport = Awaited<ReturnType<typeof findReportById>>;

// Bound the whole DB/download/decode operation, not just codec workers.
// Queued requests hold no photo bytes. Public and private reads share capacity.
let activeReads = 0;
const waitingReads: Array<{ grant: () => void }> = [];
function releaseRead(): () => void {
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const next = waitingReads.shift();
    if (next)
      next.grant(); // Transfer this slot without incrementing activeReads.
    else activeReads--;
  };
}

async function acquireRead(signal?: AbortSignal): Promise<() => void> {
  signal?.throwIfAborted();
  if (activeReads < HAZARD_AI.decodeConcurrency) {
    activeReads++;
    return releaseRead();
  }
  if (waitingReads.length >= HAZARD_AI.decodeQueueLimit)
    throw new Error(PHOTO_UNAVAILABLE);
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", cancel);
    };
    const cancel = () => {
      const index = waitingReads.indexOf(entry);
      if (index < 0) return;
      waitingReads.splice(index, 1);
      cleanup();
      reject(new Error(PHOTO_UNAVAILABLE));
    };
    const entry = {
      grant: () => {
        cleanup();
        resolve(releaseRead());
      },
    };
    const timer = setTimeout(cancel, HAZARD_AI.providerTimeoutMs);
    timer.unref();
    waitingReads.push(entry);
    signal?.addEventListener("abort", cancel, { once: true });
  });
}

export function getPrivateReportPhoto(
  id: string,
  identity: { userId: string; admin: boolean },
  signal?: AbortSignal,
): Promise<PhotoAccessResult> {
  return readAuthorizedPhoto(
    id,
    (report) =>
      Boolean(
        report &&
        !report.contentScrubbedAt &&
        !report.deidentifiedAt &&
        (identity.admin || report.reporterId === identity.userId),
      ),
    signal,
  );
}

export function getPublicReportPhoto(
  id: string,
  signal?: AbortSignal,
): Promise<PhotoAccessResult> {
  return readAuthorizedPhoto(
    id,
    (report) => Boolean(report && isPublicReportPhoto(report)),
    signal,
  );
}

/** Authorize before GCS I/O; recheck afterwards so revocation/expiry wins. */
async function readAuthorizedPhoto(
  id: string,
  mayRead: (report: StoredReport) => boolean,
  signal?: AbortSignal,
): Promise<PhotoAccessResult> {
  let release: (() => void) | undefined;
  try {
    release = await acquireRead(signal);
    const report = await findReportById(id);
    if (!mayRead(report))
      return failure(ResponseCode.NOT_FOUND, PHOTO_NOT_FOUND);
    const key = resolvePhotoKey(id, report!);
    if (!key) return failure(ResponseCode.NOT_FOUND, PHOTO_NOT_FOUND);
    signal?.throwIfAborted();
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
  } finally {
    release?.();
  }
}
