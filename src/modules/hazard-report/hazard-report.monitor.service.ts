import mongoose from "mongoose";
import { HAZARD_AI, HAZARD_AI_ALERT_CODES } from "../../config/hazard-ai";
import { withDeadline } from "../../utils/with-deadline";
import type {
  HazardAiWorkerHandle,
  HazardAiWorkerHealth,
  HazardAiWorkerMetrics,
} from "./hazard-report.ai-worker";

type Alert = (typeof HAZARD_AI_ALERT_CODES)[number];

export interface HazardAiDiagnostics {
  checkedAt: string;
  mongoAvailable: boolean;
  health: HazardAiWorkerHealth | null;
  queue: HazardAiWorkerMetrics["queue"] | null;
  intake: HazardAiWorkerMetrics["intake"] | null;
  alerts: Alert[];
}

let worker: HazardAiWorkerHandle | undefined;
let cached: HazardAiDiagnostics | undefined;
let reading: Promise<HazardAiDiagnostics> | undefined;
let monitorVersion = 0;
let startedAt = Date.now();

/** Safe process-level status only; public health must not expose queue counts. */
export function getHazardAiPublicHealth() {
  const health = worker?.getHealth();
  const mongoAvailable =
    mongoose.connection.readyState === 1 && cached?.mongoAvailable !== false;
  let workerState = "not_started";
  if (health) {
    workerState = "running";
    if (!health.running) workerState = "stopped";
    else if (health.paused) workerState = "paused";
    else if (health.circuitOpen) workerState = "circuit_open";
  }
  return {
    mongo: mongoAvailable ? "available" : "unavailable",
    worker: workerState,
    degraded:
      !mongoAvailable ||
      !health?.running ||
      (cached?.alerts.some((a) => a !== "AI_PAUSED") ?? false),
    checkedAt: cached?.checkedAt ?? null,
  };
}

/** Bounded, single-flight aggregate inspection for authenticated operations. */
export function getHazardAiDiagnostics(): Promise<HazardAiDiagnostics> {
  if (reading) return reading;
  const target = worker;
  const version = monitorVersion;
  const next = inspect(target)
    .then((result) => {
      // A stopped/replaced monitor cannot repopulate the current health cache.
      if (version === monitorVersion) cached = result;
      return result;
    })
    .finally(() => {
      if (reading === next) reading = undefined;
    });
  reading = next;
  return next;
}

async function inspect(
  target: HazardAiWorkerHandle | undefined,
): Promise<HazardAiDiagnostics> {
  let metrics: HazardAiWorkerMetrics | undefined;
  let mongoAvailable = mongoose.connection.readyState === 1;
  if (mongoAvailable && target) {
    try {
      metrics = await withDeadline(
        () => target.getMetrics(),
        { timeoutMs: HAZARD_AI.dbTimeoutMs },
        () => new Error("HAZARD_METRICS_TIMEOUT"),
      );
    } catch {
      mongoAvailable = false;
    }
  }
  mongoAvailable = mongoAvailable && mongoose.connection.readyState === 1;
  const now = Date.now();
  const health = target?.getHealth() ?? null;
  const alerts: Alert[] = [];
  if (!mongoAvailable) alerts.push("MONGO_UNAVAILABLE");
  if (!health?.running) alerts.push("WORKER_UNAVAILABLE");
  if (health?.paused) alerts.push("AI_PAUSED");
  if (health?.circuitOpen) alerts.push("CIRCUIT_OPEN");
  if ((metrics?.queue.oldestQueuedAgeMs ?? 0) >= HAZARD_AI.deadlineMs)
    alerts.push("QUEUE_AGING");
  if (metrics?.queue.expiredLease) alerts.push("EXPIRED_LEASE");
  if (metrics?.intake.cleanupOverdue) alerts.push("INTAKE_CLEANUP_OVERDUE");
  // Allow two tick periods, including a startup sweep that never completed.
  if (
    health &&
    now -
      (health.lastMaintenanceAt
        ? Date.parse(health.lastMaintenanceAt)
        : startedAt) >
      2 * HAZARD_AI.maintenanceMs
  )
    alerts.push("INTAKE_PRIVACY_STALE");
  if (
    health &&
    now -
      (health.lastConvergenceAt
        ? Date.parse(health.lastConvergenceAt)
        : startedAt) >
      2 * HAZARD_AI.convergenceMs
  )
    alerts.push("CONVERGENCE_STALE");
  return {
    checkedAt: new Date(now).toISOString(),
    mongoAvailable,
    health,
    queue: mongoAvailable ? (metrics?.queue ?? null) : null,
    intake: mongoAvailable ? (metrics?.intake ?? null) : null,
    alerts,
  };
}

/** Composition-root registration plus periodic, privacy-safe alert logging.
 * Runs while AI claims are paused. No photo/provider I/O, ids or raw errors. */
export function startHazardAiMonitor(handle: HazardAiWorkerHandle): () => void {
  worker = handle;
  const version = ++monitorVersion;
  startedAt = Date.now();
  cached = undefined;
  reading = undefined;
  let previousAlerts: string | undefined;
  const sample = async () => {
    const result = await getHazardAiDiagnostics();
    if (monitorVersion !== version) return;
    const alerts = result.alerts.join(",");
    if (alerts !== previousAlerts) {
      previousAlerts = alerts;
      console[result.alerts.some((a) => a !== "AI_PAUSED") ? "warn" : "info"](
        "[hazard-ai] monitor",
        JSON.stringify(result),
      );
    }
  };
  void sample();
  const timer = setInterval(() => void sample(), HAZARD_AI.monitorMs);
  timer.unref?.();
  return () => {
    clearInterval(timer);
    if (monitorVersion === version) {
      monitorVersion++;
      worker = undefined;
      cached = undefined;
      reading = undefined;
    }
  };
}
