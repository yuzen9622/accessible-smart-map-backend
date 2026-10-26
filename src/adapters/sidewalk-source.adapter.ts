import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { setTimeout as delay } from "node:timers/promises";
import yauzl, { type Entry, type ZipFile } from "yauzl";

export const SIDEWALK_COUNTIES = [
  "台北市",
  "新北市",
  "桃園市",
  "台中市",
  "台南市",
  "高雄市",
  "基隆市",
  "新竹市",
  "嘉義市",
  "新竹縣",
  "苗栗縣",
  "彰化縣",
  "南投縣",
  "雲林縣",
  "嘉義縣",
  "屏東縣",
  "宜蘭縣",
  "花蓮縣",
  "台東縣",
  "澎湖縣",
  "金門縣",
  "連江縣",
] as const;
export function canonicalCounty(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const name = value.trim().replace(/臺/g, "台");
  return SIDEWALK_COUNTIES.find((county) => county === name);
}

export const SIDEWALK_ARCHIVE_LIMITS = {
  compressedBytes: 256 * 1024 * 1024,
  entryBytes: 256 * 1024 * 1024,
  totalBytes: 2 * 1024 * 1024 * 1024,
  entries: 256,
} as const;

const CRC_TABLE = Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit++)
    value = (value >>> 1) ^ (value & 1 ? 0xedb88320 : 0);
  return value >>> 0;
});
function updateCrc(crc: number, bytes: Buffer): number {
  for (const byte of bytes) crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ byte) & 0xff];
  return crc;
}

export interface SidewalkArchive {
  file: string;
  sha256: string;
  cleanup(): Promise<void>;
}

interface SidewalkArchiveSource {
  zip?: string;
  url?: string;
}

function isTransientDownloadError(error: unknown): boolean {
  const seen = new Set<unknown>();
  let current = error;
  for (
    let depth = 0;
    depth < 5 && current && typeof current === "object" && !seen.has(current);
    depth++
  ) {
    seen.add(current);
    const failure = current as {
      code?: unknown;
      name?: unknown;
      message?: unknown;
      cause?: unknown;
    };
    if (
      [
        "ECONNRESET",
        "ETIMEDOUT",
        "EAI_AGAIN",
        "UND_ERR_SOCKET",
        "UND_ERR_CONNECT_TIMEOUT",
        "UND_ERR_HEADERS_TIMEOUT",
        "UND_ERR_BODY_TIMEOUT",
      ].includes(String(failure.code))
    )
      return true;
    if (failure.name === "TimeoutError" || failure.name === "AbortError")
      return true;
    if (
      typeof failure.message === "string" &&
      /^source download HTTP (408|429|5\d{2})$/.test(failure.message)
    )
      return true;
    current = failure.cause;
  }
  return false;
}

export async function acquireSidewalkArchive(
  source: SidewalkArchiveSource,
): Promise<SidewalkArchive> {
  const attempts = source.zip ? 1 : 3;
  for (let attempt = 1; ; attempt++) {
    try {
      return await acquireSidewalkArchiveOnce(source);
    } catch (error) {
      if (attempt >= attempts || !isTransientDownloadError(error)) throw error;
      console.warn(
        `[sidewalk-source] Download interrupted or temporarily unavailable; retrying (${attempt + 1}/${attempts}).`,
      );
      await delay(attempt * 1_000);
    }
  }
}

async function acquireSidewalkArchiveOnce(
  source: SidewalkArchiveSource,
): Promise<SidewalkArchive> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "sidewalk-source-"));
  const file = path.join(dir, "source.zip");
  const cleanup = () => rm(dir, { recursive: true, force: true });
  try {
    let input: Readable;
    if (source.zip) input = createReadStream(source.zip);
    else {
      const url = new URL(source.url ?? "");
      if (!["http:", "https:"].includes(url.protocol))
        throw new Error("source URL must use HTTP(S)");
      const response = await fetch(url, {
        signal: AbortSignal.timeout(180_000),
      });
      if (!response.ok || !response.body) {
        await response.body?.cancel().catch(() => undefined);
        throw new Error(`source download HTTP ${response.status}`);
      }
      if (
        Number(response.headers.get("content-length")) >
        SIDEWALK_ARCHIVE_LIMITS.compressedBytes
      ) {
        await response.body.cancel().catch(() => undefined);
        throw new Error("archive compressed size exceeds limit");
      }
      input = Readable.fromWeb(
        response.body as Parameters<typeof Readable.fromWeb>[0],
      );
    }
    const hash = createHash("sha256");
    let bytes = 0;
    await pipeline(
      input,
      new Transform({
        transform(chunk: Buffer, _encoding, callback) {
          bytes += chunk.length;
          if (bytes > SIDEWALK_ARCHIVE_LIMITS.compressedBytes)
            return callback(new Error("archive compressed size exceeds limit"));
          hash.update(chunk);
          callback(null, chunk);
        },
      }),
      createWriteStream(file, { flags: "wx" }),
    );
    return { file, sha256: hash.digest("hex"), cleanup };
  } catch (error) {
    await cleanup().catch(() => {
      console.warn("Could not remove temporary sidewalk source files.");
    });
    throw error;
  }
}

export interface CountyEntry {
  county: string;
  batch: string;
  json: unknown;
}

function validateEntry(entry: Entry): void {
  const name = entry.fileName;
  if (
    !name ||
    name.includes("\\") ||
    name.startsWith("/") ||
    /^[a-z]:/i.test(name) ||
    name.split("/").some((part) => part === ".." || part === ".") ||
    name.includes("\0")
  ) {
    throw new Error("unsafe ZIP path");
  }
  if (((entry.externalFileAttributes >>> 16) & 0xf000) === 0xa000)
    throw new Error("ZIP symlink rejected");
  if (entry.generalPurposeBitFlag & 1)
    throw new Error("encrypted ZIP entry rejected");
  if (![0, 8].includes(entry.compressionMethod))
    throw new Error("unsupported ZIP compression");
  for (const size of [entry.uncompressedSize, entry.compressedSize]) {
    if (!Number.isSafeInteger(size) || size < 0)
      throw new Error("unsafe ZIP size");
  }
  if (entry.uncompressedSize > SIDEWALK_ARCHIVE_LIMITS.entryBytes)
    throw new Error("ZIP entry size exceeds limit");
}

async function listEntries(zip: ZipFile): Promise<Entry[]> {
  return new Promise((resolve, reject) => {
    const entries: Entry[] = [];
    let total = 0;
    zip.on("error", reject);
    zip.on("end", () => resolve(entries));
    zip.on("entry", (entry: Entry) => {
      try {
        validateEntry(entry);
        total += entry.uncompressedSize;
        if (
          entries.length >= SIDEWALK_ARCHIVE_LIMITS.entries ||
          total > SIDEWALK_ARCHIVE_LIMITS.totalBytes
        )
          throw new Error("ZIP archive expansion limit exceeded");
        entries.push(entry);
        zip.readEntry();
      } catch (error) {
        reject(error);
      }
    });
    zip.readEntry();
  });
}

export async function* readSidewalkCounties(
  file: string,
): AsyncGenerator<CountyEntry> {
  const zip = await new Promise<ZipFile>((resolve, reject) =>
    yauzl.open(
      file,
      { lazyEntries: true, autoClose: false, strictFileNames: true },
      (error, archive) => {
        if (error || !archive) reject(error ?? new Error("cannot open ZIP"));
        else resolve(archive);
      },
    ),
  );
  try {
    const entries = await listEntries(zip);
    const selected = new Map<string, { entry: Entry; batch: string }>();
    const batches = new Set<string>();
    for (const entry of entries) {
      if (!/_WGS84\.geojson$/i.test(entry.fileName)) continue;
      const match =
        /^SIDEWALK_(.+)_(\d{4}(?:0[1-9]|1[0-2]))_WGS84\.geojson$/i.exec(
          path.posix.basename(entry.fileName),
        );
      const county = match && canonicalCounty(match[1]);
      if (!match || !county)
        throw new Error("unknown county/schema in WGS84 filename");
      if (selected.has(county)) throw new Error("duplicate county ZIP entry");
      selected.set(county, { entry, batch: match[2] });
      batches.add(match[2]);
      for (const folder of entry.fileName.split("/").slice(0, -1)) {
        const month = /^SIDEWALK_(\d{6})$/.exec(folder)?.[1];
        if (month) batches.add(month);
      }
    }
    if (batches.size !== 1) throw new Error("mixed or missing source batches");
    if (selected.size !== SIDEWALK_COUNTIES.length)
      throw new Error("missing WGS84 counties: all 22 required");
    for (const county of SIDEWALK_COUNTIES) {
      const item = selected.get(county);
      if (!item) throw new Error("missing county");
      const stream = await new Promise<Readable>((resolve, reject) =>
        zip.openReadStream(item.entry, (error, input) => {
          if (error || !input)
            reject(error ?? new Error("cannot read ZIP entry"));
          else resolve(input);
        }),
      );
      const chunks: Buffer[] = [];
      let bytes = 0;
      let crc = 0xffffffff;
      for await (const chunk of stream) {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        bytes += buffer.length;
        if (
          bytes > SIDEWALK_ARCHIVE_LIMITS.entryBytes ||
          bytes > item.entry.uncompressedSize
        ) {
          stream.destroy();
          throw new Error("ZIP streamed entry size exceeds limit");
        }
        crc = updateCrc(crc, buffer);
        chunks.push(buffer);
      }
      if (
        bytes !== item.entry.uncompressedSize ||
        (crc ^ 0xffffffff) >>> 0 !== item.entry.crc32
      )
        throw new Error("ZIP entry size/CRC mismatch");
      const json: unknown = JSON.parse(
        Buffer.concat(chunks)
          .toString("utf8")
          .replace(/^\uFEFF/, ""),
      );
      yield { county, batch: item.batch, json };
    }
  } finally {
    zip.close();
  }
}
