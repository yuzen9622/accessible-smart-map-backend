// Run inside the existing backend container, with a dedicated ephemeral Redis helper.
// Usage: node bench-transit-preference.mjs protocol.json output-directory [--pilot]
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fork } from "node:child_process";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";

function readJsonFile(filename) {
  try {
    return JSON.parse(fs.readFileSync(filename, "utf8"));
  } catch {
    throw new Error("Benchmark input could not be read as valid JSON");
  }
}
const protocol = readJsonFile(process.argv[2]);
const outdir = process.argv[3];
const pilot = process.argv.includes("--pilot");
if (!outdir || protocol.redisHost !== "metro-perf-redis")
  throw new Error("An isolated Redis helper is required");
fs.mkdirSync(outdir, { recursive: true, mode: 0o700 });
fs.writeFileSync(
  path.join(outdir, "protocol.json"),
  JSON.stringify(protocol, null, 2),
);
const originals = readJsonFile(protocol.casesFile);
const cases = [...originals, ...protocol.extraCases];
if (cases.length !== 16)
  throw new Error(
    "Expected all 12 original six-city cases plus four MRT/light-rail cases",
  );
const cells = cases.flatMap((c) =>
  protocol.modes.flatMap((mode) =>
    protocol.preferences.map((preference) => ({
      id: `${c.id}|${mode}|${preference}`,
      city: c.city,
      caseId: c.id,
      mode,
      preference,
      c,
    })),
  ),
);
if (cells.length !== 128) throw new Error("Unexpected workload coverage");
const workerPath = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "bench-transit-preference.worker.mjs",
);
const samplesFile = path.join(outdir, "samples.jsonl");
const sampleStream = fs.createWriteStream(samplesFile, { mode: 0o600 });
const observations = [];
const workers = [];
let controlId = 0;
let primeFailures = 0;
let randomState = protocol.seed >>> 0;
const random = () => {
  randomState ^= randomState << 13;
  randomState ^= randomState >>> 17;
  randomState ^= randomState << 5;
  return (randomState >>> 0) / 4294967296;
};
function shuffle(input) {
  const copy = [...input];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}
function boot(role, root, db) {
  return new Promise((resolve, reject) => {
    const child = fork(workerPath, [root, String(db), protocol.redisHost], {
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    });
    const logfile = fs.createWriteStream(path.join(outdir, `${role}.log`), {
      mode: 0o600,
    });
    child.stdout.pipe(logfile, { end: false });
    child.stderr.pipe(logfile, { end: false });
    const pending = new Map();
    const worker = { role, child, logfile, pending };
    workers.push(worker);
    child.on("message", (message) => {
      if (message.type === "ready") {
        Object.assign(worker, message);
        resolve(worker);
      } else if (message.type === "fatal")
        reject(new Error(`Worker ${role} failed: ${message.name}`));
      else if (message.type === "control" || message.type === "controlError") {
        const p = pending.get(message.id);
        pending.delete(message.id);
        if (message.type === "controlError") p?.reject(new Error(message.name));
        else p?.resolve(message);
      }
    });
    child.on("exit", (code) => {
      logfile.end();
      for (const p of pending.values())
        p.reject(new Error(`Worker ${role} exited: ${code}`));
      pending.clear();
      if (!worker.base)
        reject(new Error(`Worker ${role} exited before readiness: ${code}`));
    });
  });
}
function control(worker, type) {
  const id = ++controlId;
  return new Promise((resolve, reject) => {
    worker.pending.set(id, { resolve, reject });
    worker.child.send({ type, id });
  });
}
function bodyFor(cell, role) {
  const effective =
    role === "old" && cell.preference === "metro" ? "none" : cell.preference;
  return {
    origin: { latitude: cell.c.o[0], longitude: cell.c.o[1] },
    destination: { latitude: cell.c.d[0], longitude: cell.c.d[1] },
    travelMode: "transit",
    mode: cell.mode,
    transitPreference: effective,
    maxTransfers: 2,
    departureTime: protocol.departureTime,
  };
}
function routeSummary(route) {
  return {
    minutes: route.totalMinutes,
    walk: route.totalWalkDistanceM,
    degraded: !!route.degraded,
    transit: route.legs
      .filter((l) => l.type !== "WALK")
      .map((l) => [
        l.type,
        l.routeName || l.trainNo || l.lineName || "",
        l.departureStation || l.departureStop || "",
        l.arrivalStation || l.arrivalStop || "",
      ]),
  };
}
async function request(worker, cell, phase, round, prime = false) {
  const body = bodyFor(cell, worker.role);
  const t = performance.now();
  let row;
  try {
    const response = await fetch(
      `${worker.base}/api/v1/a11y/accessible-route`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(protocol.requestTimeoutMs),
      },
    );
    const json = await response.json();
    const ms = performance.now() - t;
    const routes = json.data?.routes || [];
    const summary = routes.map(routeSummary);
    const valid =
      response.status === 200 &&
      json.data?.transitPreference === body.transitPreference &&
      routes.length > 0;
    row = {
      role: worker.role,
      phase,
      round,
      prime,
      cell: cell.id,
      city: cell.city,
      preference: cell.preference,
      effective: body.transitPreference,
      mode: cell.mode,
      ms,
      status: response.status,
      valid,
      routes: summary,
      fingerprint: crypto
        .createHash("sha256")
        .update(JSON.stringify(summary))
        .digest("hex"),
      hasMetro: routes.some((r) => r.legs.some((l) => l.type === "METRO")),
      counters: JSON.parse(
        response.headers.get("X-Benchmark-Counters") || "{}",
      ),
    };
  } catch (error) {
    row = {
      role: worker.role,
      phase,
      round,
      prime,
      cell: cell.id,
      city: cell.city,
      preference: cell.preference,
      mode: cell.mode,
      ms: performance.now() - t,
      status: 0,
      valid: false,
      error: error.name,
    };
  }
  sampleStream.write(JSON.stringify(row) + "\n");
  if (!prime) observations.push(row);
  else if (!row.valid) primeFailures++;
  return row;
}
async function batch(worker, group, phase, round, prime) {
  return Promise.all(
    group.map((cell) => request(worker, cell, phase, round, prime)),
  );
}
const nearestRank = (input, percentile) => {
  const sorted = [...input].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(percentile * sorted.length) - 1)];
};
function summarize(rows) {
  const ms = rows.map((r) => r.ms);
  const count = (name) =>
    rows.reduce((n, row) => n + (row.counters?.[name] || 0), 0);
  return {
    n: rows.length,
    p50_ms: nearestRank(ms, 0.5),
    p95_ms: nearestRank(ms, 0.95),
    p99_ms: nearestRank(ms, 0.99),
    max_ms: Math.max(...ms),
    failures: rows.filter((r) => !r.valid).length,
    otpCalls: count("otp"),
    mongoCalls: count("mongo"),
    upstreamErrors: count("upstreamErrors"),
  };
}
function pairedDifferenceUpperBounds(oldRows, newRows) {
  // Keep request composition fixed and resample OLD/NEW PAIRS together.
  // Uncertainty is on the difference; a broad old baseline cannot permit a slowdown.
  const newByPair = new Map(
    newRows.map((row) => [`${row.cell}|${row.round}`, row]),
  );
  const buckets = new Map();
  for (const row of oldRows) {
    const next = newByPair.get(`${row.cell}|${row.round}`);
    if (!next) throw new Error("Missing benchmark pair");
    if (!buckets.has(row.cell)) buckets.set(row.cell, []);
    buckets.get(row.cell).push([row.ms, next.ms]);
  }
  const p95 = [],
    p99 = [];
  for (let b = 0; b < protocol.bootstrapIterations; b++) {
    const oldSample = [],
      newSample = [];
    for (const values of buckets.values())
      for (let i = 0; i < values.length; i++) {
        const pair = values[Math.floor(random() * values.length)];
        oldSample.push(pair[0]);
        newSample.push(pair[1]);
      }
    p95.push(nearestRank(newSample, 0.95) - nearestRank(oldSample, 0.95));
    p99.push(nearestRank(newSample, 0.99) - nearestRank(oldSample, 0.99));
  }
  return { p95_ms: nearestRank(p95, 0.95), p99_ms: nearestRank(p99, 0.95) };
}
let report;
try {
  const old = await boot("old", protocol.oldRoot, 0);
  const next = await boot("new", protocol.newRoot, 1);
  if (old.node !== next.node) throw new Error("Runtime versions differ");
  fs.writeFileSync(
    path.join(outdir, "workers.json"),
    JSON.stringify(
      workers.map((w) => ({
        role: w.role,
        node: w.node,
        db: w.db,
        graph: w.graph,
        hashes: w.hashes,
      })),
      null,
      2,
    ),
  );
  const rounds = pilot ? 1 : protocol.rounds;
  let primeBatchNumber = 0;
  let measuredBatchNumber = 0;
  for (const phase of protocol.phases) {
    const phaseCells = shuffle(cells);
    // Warm module-level data on both arms. During cold tests, delete only routing cache.
    for (let i = 0; i < phaseCells.length; i += phase.concurrency) {
      const group = phaseCells.slice(i, i + phase.concurrency);
      for (const w of primeBatchNumber++ % 2 ? [next, old] : [old, next])
        await batch(w, group, phase.id, -1, true);
    }
    for (let round = 0; round < rounds; round++) {
      const ordered = shuffle(cells);
      for (let i = 0; i < ordered.length; i += phase.concurrency) {
        const group = ordered.slice(i, i + phase.concurrency);
        if (phase.cache === "primed") {
          for (const w of primeBatchNumber++ % 2 ? [next, old] : [old, next])
            await batch(w, group, phase.id, round, true);
        }
        for (const w of measuredBatchNumber++ % 2 ? [next, old] : [old, next]) {
          if (phase.cache === "cold-routing") await control(w, "coldRouting");
          await batch(w, group, phase.id, round, false);
        }
      }
      console.log(
        JSON.stringify({
          type: "progress",
          phase: phase.id,
          round: round + 1,
          rounds,
          measured: observations.length,
        }),
      );
    }
  }
  const scenarios = [];
  for (const phase of protocol.phases)
    for (const group of ["all", "legacy", "metro-vs-old-none"]) {
      const chosen = observations.filter(
        (r) =>
          r.phase === phase.id &&
          (group === "all" ||
            (group === "legacy"
              ? r.preference !== "metro"
              : r.preference === "metro")),
      );
      const oldRows = chosen.filter((r) => r.role === "old"),
        newRows = chosen.filter((r) => r.role === "new");
      const oldStats = summarize(oldRows),
        newStats = summarize(newRows);
      const differenceUpper = pairedDifferenceUpperBounds(oldRows, newRows);
      const pass =
        !pilot &&
        oldStats.n === newStats.n &&
        oldStats.failures === 0 &&
        newStats.failures === 0 &&
        newStats.p95_ms <= oldStats.p95_ms &&
        newStats.p99_ms <= oldStats.p99_ms &&
        differenceUpper.p95_ms <= 0 &&
        differenceUpper.p99_ms <= 0;
      scenarios.push({
        phase: phase.id,
        group,
        old: oldStats,
        new: newStats,
        pairedDifferenceOneSided95Upper: differenceUpper,
        pass,
      });
    }
  const oldByPair = new Map(
    observations
      .filter((r) => r.role === "old")
      .map((r) => [`${r.phase}|${r.round}|${r.cell}`, r]),
  );
  const mismatches = observations.filter(
    (r) =>
      r.role === "new" &&
      r.preference !== "metro" &&
      oldByPair.get(`${r.phase}|${r.round}|${r.cell}`)?.fingerprint !==
        r.fingerprint,
  );
  report = {
    protocolId: protocol.id,
    pilot,
    validMeasuredSamples: observations.filter((r) => r.valid).length,
    totalMeasuredSamples: observations.length,
    expectedMeasuredSamples: cells.length * rounds * protocol.phases.length * 2,
    baselineMapping: { none: "none", bus: "bus", rail: "rail", metro: "none" },
    gateDefinition: protocol.gateDefinition,
    scenarios,
    compatibilitySummaryMismatches: mismatches.length,
    mismatchCells: [...new Set(mismatches.map((r) => r.cell))],
    primeFailures,
    pass:
      !pilot &&
      primeFailures === 0 &&
      mismatches.length === 0 &&
      scenarios.every((s) => s.pass) &&
      observations.length ===
        cells.length * protocol.rounds * protocol.phases.length * 2,
  };
  fs.writeFileSync(
    path.join(outdir, "report.json"),
    JSON.stringify(report, null, 2),
  );
  console.log(
    JSON.stringify({
      type: "result",
      pass: report.pass,
      pilot,
      measured: report.totalMeasuredSamples,
      failedScenarios: scenarios
        .filter((s) => !s.pass)
        .map((s) => `${s.phase}:${s.group}`),
      compatibilitySummaryMismatches: mismatches.length,
    }),
  );
} finally {
  for (const w of workers) {
    if (w.child.connected && w.base) {
      try {
        await control(w, "stop");
      } catch {
        w.child.kill("SIGTERM");
      }
    } else if (!w.child.killed) w.child.kill("SIGTERM");
  }
  await new Promise((resolve) => sampleStream.end(resolve));
}
if (!pilot && !report?.pass) process.exitCode = 1;
