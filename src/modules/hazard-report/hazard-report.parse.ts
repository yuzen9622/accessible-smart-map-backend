import exifr from "exifr";
import { haversineMeters } from "../../utils/geo";
import type {
  AiVerifyResult,
  ExifValidationResult,
} from "./hazard-report.types";

const EXIF_MAX_AGE_MS = 10 * 60 * 1000;
const EXIF_CLOCK_SKEW_MS = 10 * 60 * 1000;
const EXIF_GPS_MATCH_M = 50;
// EXIF capture times carry no timezone; when the photo has no offset tag we
// assume the reporter's local zone (Asia/Taipei, UTC+8) so the freshness check
// is independent of the server's timezone.
const DEFAULT_TZ_OFFSET_MIN = 8 * 60;

/**
 * Parses an EXIF offset string ("+08:00", "-0530") into minutes east of UTC.
 *
 * @param offset The raw EXIF offset value.
 * @returns The offset in minutes, or null when absent or unparseable.
 */
function parseOffsetMinutes(offset: unknown): number | null {
  if (typeof offset !== "string") return null;
  const m = offset.trim().match(/^([+-])(\d{2}):?(\d{2})$/);
  if (!m) return null;
  const sign = m[1] === "-" ? -1 : 1;
  return sign * (Number(m[2]) * 60 + Number(m[3]));
}

/**
 * Converts an EXIF datetime string into a UTC instant. EXIF stores naive local
 * time ("YYYY:MM:DD HH:MM:SS") with no zone; the photo's own offset tag is
 * applied when present, otherwise `fallbackOffsetMin`. This avoids exifr's
 * default of reading the naive string in the *server's* timezone, which shifts
 * every photo by the server↔camera offset (e.g. a Taiwan photo looks 8h in the
 * future on a UTC server).
 *
 * @param raw The EXIF datetime string.
 * @param offset The EXIF offset tag value, if any.
 * @param fallbackOffsetMin Offset (minutes east of UTC) assumed when the photo has no offset tag.
 * @returns The corresponding UTC Date, or null when the string is missing or unparseable.
 */
export function parseExifDateTime(
  raw: unknown,
  offset?: unknown,
  fallbackOffsetMin = DEFAULT_TZ_OFFSET_MIN,
): Date | null {
  if (typeof raw !== "string") return null;
  const m = raw
    .trim()
    .match(/^(\d{4})[-:](\d{2})[-:](\d{2})[ T](\d{2}):(\d{2}):(\d{2})/);
  if (!m) return null;
  const offsetMin = parseOffsetMinutes(offset) ?? fallbackOffsetMin;
  const epoch =
    Date.UTC(
      Number(m[1]),
      Number(m[2]) - 1,
      Number(m[3]),
      Number(m[4]),
      Number(m[5]),
      Number(m[6]),
    ) -
    offsetMin * 60_000;
  const date = new Date(epoch);
  return Number.isNaN(date.getTime()) ? null : date;
}

/**
 * Reads a photo's EXIF and maps it to the report's `exifValidation` shape:
 * whether the capture time is fresh (within 10 minutes of `now`, timezone-aware),
 * whether GPS is present, and whether that GPS sits within 50m of the claimed
 * location. A photo carrying no readable capture time passes the freshness check
 * (we cannot prove it is stale); only a present-but-out-of-window time is rejected.
 *
 * @param buffer Raw photo bytes.
 * @param claimedLat Latitude the reporter claims to be at.
 * @param claimedLng Longitude the reporter claims to be at.
 * @param now Reference time the request arrived (UTC).
 * @returns The mapped EXIF validation result; GPS flags false when EXIF is absent or unreadable.
 */
export async function parsePhotoExif(
  buffer: Buffer,
  claimedLat: number,
  claimedLng: number,
  now: Date,
): Promise<ExifValidationResult> {
  const [timeData, gps] = await Promise.all([
    exifr
      .parse(buffer, {
        reviveValues: false,
        pick: [
          "DateTimeOriginal",
          "CreateDate",
          "ModifyDate",
          "OffsetTimeOriginal",
          "OffsetTimeDigitized",
          "OffsetTime",
        ],
      })
      .catch(() => null),
    exifr.gps(buffer).catch(() => null),
  ]);

  const rawTime =
    timeData?.DateTimeOriginal ??
    timeData?.CreateDate ??
    timeData?.ModifyDate ??
    null;
  const rawOffset =
    timeData?.OffsetTimeOriginal ??
    timeData?.OffsetTimeDigitized ??
    timeData?.OffsetTime ??
    null;
  const exifDate = parseExifDateTime(rawTime, rawOffset);
  const ageMs = exifDate ? now.getTime() - exifDate.getTime() : null;
  const timestampFresh =
    ageMs === null ||
    (ageMs <= EXIF_MAX_AGE_MS && ageMs >= -EXIF_CLOCK_SKEW_MS);

  const lat = typeof gps?.latitude === "number" ? gps.latitude : undefined;
  const lng = typeof gps?.longitude === "number" ? gps.longitude : undefined;
  const gpsPresent = lat !== undefined && lng !== undefined;
  const gpsMatchesClaimed =
    gpsPresent &&
    haversineMeters(lat, lng, claimedLat, claimedLng) <= EXIF_GPS_MATCH_M;

  return {
    timestampFresh,
    gpsPresent,
    gpsMatchesClaimed,
    rawExifTime: exifDate ? exifDate.toISOString() : undefined,
    rawExifLat: lat,
    rawExifLng: lng,
  };
}

function skipped(reason = "AI 服務暫時不可用"): AiVerifyResult {
  return { verdict: "skipped", confidence: 0, reason };
}

/**
 * Parses the Gemini verdict JSON (tolerating code fences and surrounding prose)
 * into an `AiVerifyResult`. Any malformed or unexpected payload degrades to a
 * `skipped` verdict so the report stays `pending`.
 *
 * @param text Raw model response text.
 * @returns The parsed verdict, or a skipped result on any parse failure.
 */
export function parseAiVerifyResult(text: string): AiVerifyResult {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1 || end < start) return skipped();

  try {
    const obj = JSON.parse(text.slice(start, end + 1)) as Record<
      string,
      unknown
    >;
    const verdict =
      obj.verdict === "verified" ||
      obj.verdict === "suspicious" ||
      obj.verdict === "rejected"
        ? obj.verdict
        : "skipped";
    if (verdict === "skipped") return skipped();
    const confidence =
      typeof obj.confidence === "number"
        ? Math.max(0, Math.min(1, obj.confidence))
        : 0;
    const reason =
      typeof obj.reason === "string" && obj.reason.trim()
        ? obj.reason.trim().slice(0, 200)
        : "";
    return { verdict, confidence, reason };
  } catch {
    return skipped();
  }
}
