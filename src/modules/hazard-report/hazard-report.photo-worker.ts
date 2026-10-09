/**
 * Static, trusted JavaScript evaluated in a short-lived worker. Codec work is
 * interruptible without blocking the HTTP event loop; no user text is code.
 * Dependencies are resolved by the parent so this works in dist and TS tests.
 */
export const PHOTO_DECODER_SOURCE = String.raw`
const { parentPort, workerData } = require('node:worker_threads');
const sharp = require(workerData.sharpPath);
const input = Buffer.from(workerData.bytes);
const limits = workerData.limits;
const fail = code => { const e = new Error(code); e.safeCode = code; throw e; };
const checkPixels = (w, h) => {
  if (!Number.isSafeInteger(w) || !Number.isSafeInteger(h) || w <= 0 || h <= 0)
    fail('IMAGE_INVALID');
  if (w > limits.maxPixels / h) fail('IMAGE_TOO_LARGE');
};
(async () => {
  let pipeline;
  let images = [];
  try {
    if (workerData.heif) {
      const lib = require(workerData.heifPath);
      images = new lib.HeifDecoder().decode(input);
      if (!images.length || images.length > 16) fail('IMAGE_INVALID');
      const image = images.find(i => i.is_primary()) || images[0];
      const width = image.get_width(), height = image.get_height();
      checkPixels(width, height);
      const pixels = await new Promise((resolve, reject) => {
        image.display({ data: new Uint8ClampedArray(width * height * 4), width, height },
          result => result ? resolve(result) : reject(new Error('IMAGE_INVALID')));
      });
      // libheif applies HEIF irot/imir transformations. Applying EXIF rotation
      // again would double-rotate common iPhone files.
      pipeline = sharp(Buffer.from(pixels.data), { raw: { width, height, channels: 4 } });
    } else {
      pipeline = sharp(input, { limitInputPixels: limits.maxPixels, failOn: 'error' });
      const meta = await pipeline.metadata();
      checkPixels(meta.width, meta.height);
      if (meta.pages && meta.pages > 1) fail('IMAGE_UNSUPPORTED');
      pipeline = pipeline.autoOrient();
    }
    const output = await pipeline.resize({ width: limits.maxDimension, height: limits.maxDimension,
      fit: 'inside', withoutEnlargement: true }).flatten({ background: '#ffffff' })
      .jpeg({ quality: 85 }).toBuffer();
    if (output.length > limits.maxBytes) fail('IMAGE_TOO_LARGE');
    // Sharp removes all metadata by default; never call withMetadata().
    const bytes = Uint8Array.from(output);
    parentPort.postMessage({ bytes }, [bytes.buffer]);
  } catch (e) {
    const code = e.safeCode || (/pixel limit/i.test(String(e.message)) ? 'IMAGE_TOO_LARGE' : 'IMAGE_INVALID');
    parentPort.postMessage({ code });
  } finally {
    for (const image of images) image.free();
  }
})();
`;
