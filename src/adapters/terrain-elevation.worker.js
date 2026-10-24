"use strict";
function pixelCoordinate(value, origin, scale) {
  const pixel = (value - origin) / scale - 0.5;
  return Math.abs(pixel - Math.round(pixel)) < 1e-8 ? Math.round(pixel) : pixel;
}

async function sample(fromFile, workerData) {
  let tiff;
  try {
    tiff = await fromFile(workerData.filePath);
    const image = await tiff.getImage();
    const keys = image.getGeoKeys();
    const tileWidth = image.getTileWidth(),
      tileHeight = image.getTileHeight();
    if (
      keys?.GeographicTypeGeoKey !== 4326 ||
      keys?.GTRasterTypeGeoKey !== 1 ||
      image.getFileDirectory().hasTag("ModelTransformation") ||
      !image.isTiled ||
      image.getSamplesPerPixel() !== 1 ||
      tileWidth > workerData.limits.maxWindowPx ||
      tileHeight > workerData.limits.maxWindowPx
    )
      return { ok: false, reason: "unsupported_dtm" };
    const [originX, originY] = image.getOrigin();
    const [scaleX, scaleY] = image.getResolution();
    if (
      ![originX, originY, scaleX, scaleY].every(Number.isFinite) ||
      scaleX <= 0 ||
      scaleY >= 0
    ) {
      return { ok: false, reason: "unsupported_dtm" };
    }
    const width = image.getWidth(),
      height = image.getHeight();
    const nodata = image.getGDALNoData();
    const output = new Array(workerData.points.length).fill(null);
    const windows = new Map();
    for (const [index, point] of workerData.points.entries()) {
      const col = pixelCoordinate(point[0], originX, scaleX);
      const row = pixelCoordinate(point[1], originY, scaleY);
      if (col < 0 || row < 0 || col > width - 1 || row > height - 1) continue;
      const left = Math.floor(col / 128) * 128,
        top = Math.floor(row / 128) * 128;
      const key = `${left}:${top}`;
      if (!windows.has(key)) {
        if (windows.size >= workerData.limits.maxWindows)
          return { ok: false, reason: "resource_limit" };
        windows.set(key, { left, top, points: [] });
      }
      windows.get(key).points.push({ index, col, row });
    }
    for (const window of windows.values()) {
      const right = Math.min(width, window.left + 129),
        bottom = Math.min(height, window.top + 129);
      const raster = await image.readRasters({
        window: [window.left, window.top, right, bottom],
        samples: [0],
        interleave: true,
      });
      const stride = right - window.left;
      for (const point of window.points) {
        const x = Math.floor(point.col),
          y = Math.floor(point.row);
        const dx = point.col - x,
          dy = point.row - y;
        const neighbours = [
          [x, y, (1 - dx) * (1 - dy)],
          [x + 1, y, dx * (1 - dy)],
          [x, y + 1, (1 - dx) * dy],
          [x + 1, y + 1, dx * dy],
        ];
        let elevation = 0;
        for (const [cx, cy, weight] of neighbours) {
          if (weight < 1e-12) continue;
          const value = Number(
            raster[(cy - window.top) * stride + cx - window.left],
          );
          if (
            cx >= right ||
            cy >= bottom ||
            !Number.isFinite(value) ||
            value === nodata
          ) {
            elevation = null;
            break;
          }
          elevation += value * weight;
        }
        output[point.index] = elevation;
      }
    }
    return { ok: true, elevations: output };
  } catch {
    return { ok: false, reason: "data_unavailable" };
  } finally {
    if (tiff) await tiff.close();
  }
}

async function main() {
  const { parentPort, workerData } = await import("node:worker_threads");
  const { fromFile } = await import(workerData.geotiffPath);
  parentPort.postMessage(await sample(fromFile, workerData));
}

void main();
