import type { IHazardReport } from "../../types";

/** Only the configured bucket and this report's own canonical key may be read. */
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
  const match = /^reports\/([a-f\d]{24})\.(jpg|png|webp|heic|heif)$/.exec(
    key ?? "",
  );
  return match?.[1] === id.toLowerCase() && match[0] === key ? key : undefined;
}

/**
 * Shared by the public bytes endpoint and transport URL projection.
 * Approval and expiry are checked on every read, not just by background jobs.
 * Community-only legacy verification does not approve a photo for publication.
 */
export function isPublicReportPhoto(
  report: Partial<IHazardReport> | Record<string, unknown>,
  now: Date = new Date(),
): boolean {
  const source = report as Partial<IHazardReport>;
  const id = String(source._id ?? "");
  if (
    !/^[a-f\d]{24}$/i.test(id) ||
    source.status !== "verified" ||
    !(source.expiredAt instanceof Date) ||
    !(source.expiredAt.getTime() > now.getTime()) ||
    source.moderationHiddenAt ||
    source.contentScrubbedAt ||
    source.deidentifiedAt ||
    source.photoIntake?.state === "uploading" ||
    source.photoIntake?.state === "cleanup" ||
    source.manualReview?.decision === "rejected" ||
    source.aiVerification?.prefilter?.safeSearchBlocked === true ||
    !resolvePhotoKey(id, source)
  )
    return false;

  if (source.manualReview?.decision === "verified") return true;
  if (source.aiReview !== undefined)
    return (
      source.aiReview?.state === "completed" &&
      source.aiReview?.decision === "supported"
    );
  return source.aiVerification?.verdict === "verified";
}
