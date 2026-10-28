import sharp from "sharp";

export const AVATAR_EDGE = 512;
const AVATAR_MAX_INPUT_PIXELS = 40_000_000;

export class AvatarImageError extends Error {
  constructor(public readonly code: "AVATAR_INVALID" | "AVATAR_UNSUPPORTED") {
    super(code);
    this.name = "AvatarImageError";
  }
}

/** Detect the container from bytes, never from the caller's MIME or name. */
function isSupportedImage(bytes: Buffer): boolean {
  const jpeg =
    bytes.length >= 3 &&
    bytes[0] === 0xff &&
    bytes[1] === 0xd8 &&
    bytes[2] === 0xff;
  const png = bytes
    .subarray(0, 8)
    .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  const webp =
    bytes.length >= 12 &&
    bytes.toString("ascii", 0, 4) === "RIFF" &&
    bytes.toString("ascii", 8, 12) === "WEBP";
  return jpeg || png || webp;
}

/**
 * Decodes a JPEG/PNG/WebP upload and re-encodes it as a square JPEG avatar.
 * Re-encoding drops all metadata (EXIF GPS included).
 *
 * @param bytes Raw uploaded bytes.
 * @returns A center-cropped `AVATAR_EDGE` square JPEG.
 */
export async function normalizeAvatarImage(bytes: Buffer): Promise<Buffer> {
  if (!isSupportedImage(bytes))
    throw new AvatarImageError("AVATAR_UNSUPPORTED");
  try {
    const input = sharp(bytes, {
      limitInputPixels: AVATAR_MAX_INPUT_PIXELS,
      failOn: "error",
    });
    const meta = await input.metadata();
    if (meta.pages && meta.pages > 1)
      throw new AvatarImageError("AVATAR_UNSUPPORTED");
    return await input
      .autoOrient()
      .resize(AVATAR_EDGE, AVATAR_EDGE, {
        fit: "cover",
        withoutEnlargement: false,
      })
      .flatten({ background: "#ffffff" })
      .jpeg({ quality: 85 })
      .toBuffer();
  } catch (error) {
    if (error instanceof AvatarImageError) throw error;
    throw new AvatarImageError("AVATAR_INVALID");
  }
}
