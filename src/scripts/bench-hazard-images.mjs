// Public-image screening benchmark; never connects to MongoDB or uploads to GCS.
// Usage: node src/scripts/bench-hazard-images.mjs prepare reports/hazard-benchmark
//        node src/scripts/bench-hazard-images.mjs live reports/hazard-benchmark --live
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import zlib from "node:zlib";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const protocolPath = path.join(here, "fixtures/hazard-images.protocol.json");
const hash = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");
function readJson(bytes, label) {
  try {
    return JSON.parse(bytes);
  } catch {
    throw new Error(`${label} is not valid JSON`);
  }
}

export function summarize(samples) {
  const semantic = samples.filter((s) => s.group !== "robustness");
  const completed = semantic.filter((s) =>
    ["verified", "suspicious", "rejected"].includes(s.verdict),
  );
  const positives = semantic.filter((s) => s.group === "positive");
  const negatives = semantic.filter((s) => s.group === "negative");
  const score = (rows, predicate) => ({
    numerator: rows.filter(predicate).length,
    denominator: rows.length,
  });
  const byCase = new Map();
  for (const s of samples) {
    const rows = byCase.get(s.id) ?? [];
    rows.push(s);
    byCase.set(s.id, rows);
  }
  const repeated = [...byCase.values()].filter((rows) => rows.length > 1);
  const latencies = samples.map((s) => s.durationMs).sort((a, b) => a - b);
  const percentile = (q) =>
    latencies.length ? latencies[Math.ceil(q * latencies.length) - 1] : null;
  return {
    samples: samples.length,
    semanticAvailability: score(semantic, (s) => s.verdict !== "skipped"),
    // Skipped/failed cases stay in this denominator; failures cannot inflate quality.
    expectedVerdictAllSemantic: score(semantic, (s) =>
      s.expected.includes(s.verdict),
    ),
    expectedVerdictCompletedOnly: score(completed, (s) =>
      s.expected.includes(s.verdict),
    ),
    obstacleRecall: score(positives, (s) => s.verdict === "verified"),
    falseAcceptance: score(negatives, (s) => s.verdict === "verified"),
    robustnessExpected: score(
      samples.filter((s) => s.group === "robustness"),
      (s) => s.expected.includes(s.verdict),
    ),
    strictExpectedAll: score(samples, (s) => s.expected.includes(s.verdict)),
    prefilterAvailable: score(samples, (s) => !!s.prefilter),
    repeatConsistency: score(
      repeated,
      (rows) => new Set(rows.map((s) => s.verdict)).size === 1,
    ),
    durationMs: {
      median: percentile(0.5),
      p95: percentile(0.95),
      max: latencies.at(-1) ?? null,
    },
    failures: samples
      .filter((s) => !s.expected.includes(s.verdict))
      .map((s) => ({
        id: s.id,
        repeat: s.repeat,
        expected: s.expected,
        actual: s.verdict,
        reason: s.reason,
      })),
  };
}

// A valid 32x32 black PNG, generated without an image model or extra dependency.
export function blankPng() {
  function crc32(bytes) {
    let crc = 0xffffffff;
    for (const byte of bytes) {
      crc ^= byte;
      for (let i = 0; i < 8; i++)
        crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
    return (crc ^ 0xffffffff) >>> 0;
  }
  function chunk(type, data) {
    const body = Buffer.concat([Buffer.from(type), data]);
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([length, body, crc]);
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(32, 0);
  header.writeUInt32BE(32, 4);
  header[8] = 8; // 8-bit greyscale
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", header),
    chunk("IDAT", zlib.deflateSync(Buffer.alloc(32 * 33))),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

async function prepare(dir, protocol) {
  fs.mkdirSync(path.join(dir, "images"), { recursive: true });
  const sources = [];
  for (const image of protocol.images) {
    const url =
      "https://commons.wikimedia.org/w/api.php?" +
      new URLSearchParams({
        action: "query",
        format: "json",
        prop: "imageinfo",
        iiprop: "url|extmetadata",
        iiurlwidth: "800",
        titles: `File:${image.file}`,
      });
    const response = await fetch(url, { signal: AbortSignal.timeout(20000) });
    if (!response.ok)
      throw new Error(`Commons metadata HTTP ${response.status}`);
    const metadata = await response.json();
    const info = Object.values(metadata.query.pages)[0]?.imageinfo?.[0];
    if (!info) throw new Error(`Missing Commons image: ${image.id}`);
    const photo = await fetch(info.thumburl || info.url, {
      signal: AbortSignal.timeout(20000),
    });
    if (!photo.ok || !photo.headers.get("content-type")?.startsWith("image/"))
      throw new Error(`Photo unavailable: ${image.id}`);
    const bytes = Buffer.from(await photo.arrayBuffer());
    const filename = `images/${image.id}.jpg`;
    fs.writeFileSync(path.join(dir, filename), bytes);
    sources.push({
      id: image.id,
      file: image.file,
      path: filename,
      source: info.descriptionurl,
      url: info.thumburl || info.url,
      license: info.extmetadata.LicenseShortName?.value,
      artist: info.extmetadata.Artist?.value,
      sha256: hash(bytes),
    });
    console.log(`prepared ${image.id} (${bytes.length} bytes)`);
  }
  fs.writeFileSync(
    path.join(dir, "sources.json"),
    JSON.stringify(sources, null, 2),
  );
}

// Runs in a fresh process inside the existing container. All AI adapters are real.
// Only updateOne is captured, before execution: no DB connection or writes occur.
async function worker(input) {
  const root = "/app/dist";
  const { createRequire } = await import("node:module");
  const load = createRequire(`${root}/scripts/bench-hazard-images.cjs`);
  const fs = await import("node:fs");
  const crypto = await import("node:crypto");
  const digest = (p) =>
    crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex");
  const files = [
    "modules/hazard-report/hazard-report.ai-verify.js",
    "modules/hazard-report/hazard-report.parse.js",
    "adapters/ai-vision.adapter.js",
    "adapters/vision.adapter.js",
    "config/ai.js",
    "config/ai/config.js",
    "config/ai/contents.js",
  ];
  const model = load(`${root}/model/hazard-report.model.js`).default;
  const vision = load(`${root}/adapters/vision.adapter.js`);
  const gemini = load(`${root}/adapters/ai-vision.adapter.js`);
  const diagnostics = {};
  const prefilter = vision.prefilterImage;
  vision.prefilterImage = async (...args) => {
    const start = performance.now();
    try {
      return await prefilter(...args);
    } catch (err) {
      diagnostics.prefilterError = err.name;
      throw err;
    } finally {
      diagnostics.prefilterMs = Math.round(performance.now() - start);
    }
  };
  const verify = gemini.verifyImageWithGemini;
  gemini.verifyImageWithGemini = async (...args) => {
    const start = performance.now();
    try {
      const text = await verify(...args);
      diagnostics.rawModelText = text;
      return text;
    } catch (err) {
      diagnostics.geminiError = err.name;
      throw err;
    } finally {
      diagnostics.geminiMs = Math.round(performance.now() - start);
    }
  };
  let captured;
  model.updateOne = async (_filter, pipeline) => {
    captured = pipeline[0].$set;
    return { acknowledged: true, modifiedCount: 1 };
  };
  const { verifyHazardReport } = load(
    `${root}/modules/hazard-report/hazard-report.ai-verify.js`,
  );
  (async () => {
    const start = performance.now();
    await verifyHazardReport(
      "000000000000000000000001",
      Buffer.from(input.base64, "base64"),
      input.mimeType,
      input.hazardType,
      input.description,
    );
    if (!captured?.aiVerification) throw new Error("No AI persistence outcome");
    console.log(
      JSON.stringify({
        ...captured.aiVerification,
        statusExpression: captured.status ?? null,
        diagnostics,
        durationMs: Math.round(performance.now() - start),
        model: process.env.GEMINI_MODEL || "gemini-3.7-flash",
        codeHashes: Object.fromEntries(
          files.map((p) => [p, digest(`${root}/${p}`)]),
        ),
      }),
    );
  })().catch((err) => {
    console.log(JSON.stringify({ workerError: err.name }));
    process.exitCode = 1;
  });
}

async function main() {
  const [mode, outdir, ...flags] = process.argv.slice(2);
  if (!["prepare", "live"].includes(mode) || !outdir)
    throw new Error(
      "Usage: bench-hazard-images.mjs prepare|live OUTPUT_DIR [--live]",
    );
  if (flags.some((f) => f !== "--live")) throw new Error("Unknown option");
  const dir = path.resolve(outdir);
  const protocolBytes = fs.readFileSync(protocolPath);
  const protocol = readJson(protocolBytes, "Protocol");
  if (mode === "prepare") return prepare(dir, protocol);
  if (!flags.includes("--live"))
    throw new Error(
      "--live is required: up to 26 real Cloud Vision/Gemini attempts; no automatic retries",
    );
  if (protocol.cases.length > 15)
    throw new Error("Maximum 30 live attempts per run");
  const sources = readJson(
    fs.readFileSync(path.join(dir, "sources.json"), "utf8"),
    "Sources",
  );
  const images = new Map();
  for (const source of sources) {
    const file = path.resolve(dir, source.path);
    if (!file.startsWith(dir + path.sep))
      throw new Error("Image path must stay in output directory");
    const bytes = fs.readFileSync(file);
    if (hash(bytes) !== source.sha256)
      throw new Error(`Photo hash mismatch: ${source.id}`);
    images.set(source.id, { bytes, mimeType: "image/jpeg" });
  }
  images.set("blank", { bytes: blankPng(), mimeType: "image/png" });
  images.set("corrupt", {
    bytes: Buffer.from("not a decodable photograph"),
    mimeType: "image/jpeg",
  });
  for (const c of protocol.cases)
    if (!images.has(c.image)) throw new Error(`Missing image: ${c.image}`);
  const samples = [];
  let deploymentFingerprint;
  // Fail rather than overwrite prior evidence. Interrupted runs retain samples.jsonl.
  const output = fs.openSync(path.join(dir, "samples.jsonl"), "wx", 0o600);
  fs.writeFileSync(path.join(dir, "protocol.json"), protocolBytes);
  try {
    for (let repeat = 1; repeat <= 2; repeat++) {
      for (const c of protocol.cases) {
        const image = images.get(c.image);
        const input = {
          hazardType: c.hazardType,
          description: c.description,
          mimeType: image.mimeType,
          base64: image.bytes.toString("base64"),
        };
        const started = Date.now();
        const result = spawnSync(
          "docker",
          ["exec", "-i", "taipei-backend", "node"],
          {
            input: `(${worker.toString()})(${JSON.stringify(input)});`,
            encoding: "utf8",
            timeout: 45000,
            maxBuffer: 2 * 1024 * 1024,
          },
        );
        let outcome;
        try {
          outcome = JSON.parse(result.stdout.trim().split("\n").at(-1));
        } catch {
          outcome = {};
        }
        if (result.status !== 0 || !outcome.verdict)
          outcome = {
            verdict: "skipped",
            confidence: 0,
            reason: "Benchmark worker failed or timed out",
            durationMs: Date.now() - started,
            workerError:
              result.error?.code ??
              outcome.workerError ??
              `exit-${result.status}`,
          };
        const sample = {
          id: c.id,
          image: c.image,
          imageSha256: hash(image.bytes),
          repeat,
          group: c.group,
          expected: c.expected,
          ...outcome,
        };
        samples.push(sample);
        fs.writeSync(output, JSON.stringify(sample) + "\n");
        if (sample.codeHashes) {
          const fingerprint = JSON.stringify({
            model: sample.model,
            hashes: sample.codeHashes,
          });
          if (deploymentFingerprint && deploymentFingerprint !== fingerprint)
            throw new Error(
              "Deployed AI code/model changed mid-run; stop rather than mix versions",
            );
          deploymentFingerprint = fingerprint;
        }
        console.log(
          `${c.id} #${repeat}: ${sample.verdict} (${sample.durationMs}ms) ${sample.reason}`,
        );
        // A broken key/endpoint is not an excuse to spend the whole budget.
        if (
          samples.length === 3 &&
          samples.every((s) => s.verdict === "skipped")
        )
          throw new Error(
            "First three AI attempts unavailable; stopping live calls. Evidence retained.",
          );
      }
    }
  } finally {
    fs.closeSync(output);
    const report = {
      runAt: new Date().toISOString(),
      protocolSha256: hash(protocolBytes),
      scope:
        "Real deployed two-stage screening + parser + captured update pipeline. NOT upload/HTTP/EXIF/database/end-to-end verification. Confidence is model self-report, not calibrated probability. Tiny convenience sample, not production accuracy.",
      summary: summarize(samples),
    };
    fs.writeFileSync(
      path.join(dir, "results.json"),
      JSON.stringify(report, null, 2),
    );
    console.log(JSON.stringify(report.summary, null, 2));
  }
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main().catch((err) => {
    console.error(err.message);
    process.exitCode = 1;
  });
}
