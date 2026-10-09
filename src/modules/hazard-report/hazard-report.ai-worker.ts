import { createHash, randomUUID } from "node:crypto";
import { HAZARD_AI } from "../../config/hazard-ai";
import { withDeadline } from "../../utils/with-deadline";
import { deleteHazardPhoto, readHazardPhoto } from "../../adapters/gcs.adapter";
import { analyzeHazardPhoto } from "./hazard-report.ai-verify";
import {
  claimNextAiJob,
  convergeStuckAiJobs,
  failAiJob,
  finalizeAiReview,
  getAiQueueSnapshot,
  requeueAiJob,
  type AiQueueSnapshot,
  type ClaimedAiJob,
} from "./hazard-report.ai-job.repository";
import {
  claimIntakeCleanup,
  convertExpiredIntakes,
  getIntakeSnapshot,
  settleIntakeCleanupFailure,
  settleIntakeCleanupSuccess,
  type IntakeSnapshot,
} from "./hazard-report.intake.repository";
import { HAZARD_AI_POLICY_VERSION } from "../../config/hazard-ai";
import type { HazardAiDecisionResult } from "../../types/hazard-ai-review";

/**
 * The durable AI review worker and intake maintenance, one per process.
 * It orchestrates only: claims, fencing and persistence live in the
 * repositories, the content decision in analyzeHazardPhoto. Delivery is
 * at-least-once with a single fenced commit.
 */

const STOP_WAIT_MS = 15_000;
const CIRCUIT_COOLDOWN_MS = 60_000;
const CLEANUP_BATCH = 20;

/** External I/O seam; tests fake this, never Mongo. */
export interface AiWorkerDeps {
  readPhoto(
    storagePath: string,
    opts: { signal: AbortSignal; maxBytes: number; timeoutMs: number },
  ): Promise<Buffer>;
  analyze(
    buffer: Buffer,
    mimeType: string,
    hazardType: string,
    description: string | undefined,
    opts: { signal: AbortSignal; model: string; policyVersion: string },
  ): Promise<HazardAiDecisionResult>;
  deletePhoto(storagePath: string): Promise<void>;
  now(): Date;
  random(): number;
}

export const defaultAiWorkerDeps: AiWorkerDeps = {
  readPhoto: (storagePath, opts) => readHazardPhoto(storagePath, opts),
  analyze: (buffer, mimeType, hazardType, description, opts) =>
    analyzeHazardPhoto(
      buffer,
      mimeType as "image/jpeg" | "image/png",
      hazardType as never,
      description,
      opts,
    ),
  deletePhoto: (storagePath) => deleteHazardPhoto(storagePath),
  now: () => new Date(),
  random: Math.random,
};

interface Classified {
  code: string;
  retryable: boolean;
  circuitBreak: boolean;
  invalidOutput: boolean;
}

function httpStatus(err: unknown): number | undefined {
  const code = (err as { code?: unknown; status?: unknown } | null)?.code;
  const status = (err as { status?: unknown } | null)?.status;
  if (typeof code === "number") return code;
  if (typeof status === "number") return status;
  return undefined;
}

/** Maps any failure to a controlled code. Raw provider messages never escape. */
function classify(err: unknown, stage: "read" | "analyze"): Classified {
  const e = err as {
    code?: unknown;
    retryable?: unknown;
    circuitBreak?: unknown;
  } | null;
  if (
    e &&
    typeof e.code === "string" &&
    typeof e.retryable === "boolean" &&
    typeof e.circuitBreak === "boolean"
  ) {
    return {
      code: e.code,
      retryable: e.retryable,
      circuitBreak: e.circuitBreak,
      invalidOutput: e.code === "MODEL_OUTPUT_INVALID",
    };
  }
  const status = httpStatus(err);
  if (stage === "read") {
    if (status === 404) {
      return {
        code: "PHOTO_NOT_FOUND",
        retryable: false,
        circuitBreak: false,
        invalidOutput: false,
      };
    }
    if (status === 401 || status === 403) {
      return {
        code: "PHOTO_ACCESS_DENIED",
        retryable: false,
        circuitBreak: false,
        invalidOutput: false,
      };
    }
    return {
      code: "PHOTO_READ_FAILED",
      retryable: true,
      circuitBreak: false,
      invalidOutput: false,
    };
  }
  return {
    code: "AI_INTERNAL_ERROR",
    retryable: true,
    circuitBreak: false,
    invalidOutput: false,
  };
}

function backoffMs(attempts: number, random: () => number): number {
  const base =
    HAZARD_AI.retryMs[Math.min(attempts - 1, HAZARD_AI.retryMs.length - 1)] ??
    HAZARD_AI.retryMs[0];
  return base + Math.floor(random() * HAZARD_AI.maxJitterMs);
}

export type AiJobOutcome =
  "completed" | "retried" | "failed" | "dropped" | "aborted";

/** Per-attempt hard deadline error; classified as retryable by duck typing. */
class AttemptDeadlineError extends Error {
  readonly code = "AI_ATTEMPT_TIMEOUT";
  readonly retryable = true;
  readonly circuitBreak = false;
}

/** Non-retryable pinned-image mismatch, surfaced as a controlled code. */
class ImageHashMismatchError extends Error {
  readonly code = "IMAGE_HASH_MISMATCH";
  readonly retryable = false;
  readonly circuitBreak = false;
}

/**
 * Runs one claimed job to a fenced outcome. The whole read/hash/analyse unit
 * runs under a hard promise deadline (not only an abort signal), so a dependency
 * that ignores the signal can neither outlive the attempt nor commit late.
 * Returns without writing when shutdown aborted the attempt: the lease expires
 * and recovery owns it.
 *
 * @param job The claimed job
 * @param deps External I/O
 * @param stopSignal Process shutdown signal
 * @param attemptTimeoutMs Hard per-attempt deadline (defaults to the policy value)
 * @returns The outcome and whether a provider-wide credential failure should pause claiming
 */
export async function processAiJob(
  job: ClaimedAiJob,
  deps: AiWorkerDeps,
  stopSignal: AbortSignal,
  attemptTimeoutMs: number = HAZARD_AI.attemptTimeoutMs,
): Promise<{ circuitBreak: boolean; outcome: AiJobOutcome }> {
  const done = (outcome: AiJobOutcome, circuitBreak = false) => ({
    circuitBreak,
    outcome,
  });
  if (stopSignal.aborted) return done("aborted");

  const fence = {
    reportId: job.reportId,
    generation: job.generation,
    leaseToken: job.leaseToken,
  };
  const controller = new AbortController();
  const onStop = () => controller.abort();
  stopSignal.addEventListener("abort", onStop, { once: true });
  const log = (code: string) =>
    console.warn(
      "[hazard-ai]",
      JSON.stringify({
        reportId: job.reportId,
        attempt: job.attempts,
        code,
        model: job.model,
        policyVersion: job.policyVersion,
      }),
    );

  try {
    if (job.policyVersion !== HAZARD_AI_POLICY_VERSION) {
      log("POLICY_UNSUPPORTED");
      await failAiJob(fence, "POLICY_UNSUPPORTED", deps.now());
      return done("failed");
    }

    const remainingMs = job.deadlineAt.getTime() - deps.now().getTime();
    if (remainingMs <= 0) {
      await failAiJob(fence, "AI_REVIEW_TIMEOUT", deps.now());
      return done("failed");
    }
    const boundedAttemptMs = Math.min(
      attemptTimeoutMs,
      HAZARD_AI.attemptTimeoutMs,
      remainingMs,
    );
    let stage: "read" | "analyze" = "read";
    let result: HazardAiDecisionResult;
    try {
      result = await withDeadline(
        async () => {
          const { signal } = controller;
          signal.throwIfAborted();
          const buffer = await deps.readPhoto(job.storagePath, {
            signal,
            maxBytes: HAZARD_AI.imageMaxBytes,
            timeoutMs: boundedAttemptMs,
          });
          signal.throwIfAborted();
          const hash = createHash("sha256").update(buffer).digest("hex");
          if (hash !== job.imageHash) throw new ImageHashMismatchError();
          stage = "analyze";
          const decided = await deps.analyze(
            buffer,
            job.mimeType,
            job.hazardType,
            job.description,
            { signal, model: job.model, policyVersion: job.policyVersion },
          );
          signal.throwIfAborted();
          return decided;
        },
        { signal: controller.signal, timeoutMs: boundedAttemptMs },
        () => new AttemptDeadlineError("AI_ATTEMPT_TIMEOUT"),
      );
    } catch (err) {
      // Stop everything the attempt may still be doing.
      controller.abort();
      // Shutdown (not the per-attempt deadline) leaves the lease to expire.
      if (stopSignal.aborted) return done("aborted");
      const c = classify(err, stage);
      log(c.code);
      const now = deps.now();
      const invalidAttempts =
        job.invalidOutputAttempts + (c.invalidOutput ? 1 : 0);
      const mayRetry =
        c.retryable &&
        now.getTime() < job.deadlineAt.getTime() &&
        job.attempts < HAZARD_AI.maxAttempts &&
        // MODEL_OUTPUT_INVALID gets exactly one more model question.
        (!c.invalidOutput || invalidAttempts <= 1);
      if (mayRetry) {
        await requeueAiJob(
          fence,
          c.code,
          new Date(now.getTime() + backoffMs(job.attempts, deps.random)),
          invalidAttempts,
          now,
        );
        return done("retried", c.circuitBreak);
      }
      await failAiJob(fence, c.code, now);
      return done("failed", c.circuitBreak);
    }

    // A result that arrives after shutdown or the deadline is never committed.
    if (stopSignal.aborted) return done("aborted");
    const committed = await finalizeAiReview(fence, result, deps.now());
    if (!committed) {
      log("RESULT_DROPPED");
      return done("dropped");
    }
    return done("completed");
  } catch (err) {
    // A DB write failure never publishes; the lease expiry retries it within
    // the job's attempt and deadline budget.
    log(`DB_WRITE_FAILED:${err instanceof Error ? err.name : "unknown"}`);
    return done("dropped");
  } finally {
    controller.abort();
    stopSignal.removeEventListener("abort", onStop);
  }
}

export interface HazardAiWorkerOptions {
  /** False = kill switch: no AI claims, intake/terminal maintenance still runs. */
  enabled?: boolean;
}

/** Process-local counters and loop liveness. No payload, ids or paths. */
export interface HazardAiWorkerHealth {
  running: boolean;
  paused: boolean;
  active: number;
  circuitOpen: boolean;
  lastPollAt: string | null;
  /** Last successful intake sweep, independent of slow object deletion. */
  lastMaintenanceAt: string | null;
  lastCleanupAt: string | null;
  lastConvergenceAt: string | null;
  counters: Record<AiJobOutcome | "claimed", number>;
}

export interface HazardAiWorkerMetrics {
  health: HazardAiWorkerHealth;
  queue: AiQueueSnapshot;
  intake: IntakeSnapshot;
}

export interface HazardAiWorkerHandle {
  /** Stops claiming, aborts own attempts and waits (bounded) for them. */
  stop(): Promise<void>;
  /** Synchronous liveness/counters for a private CLI or acceptance script. */
  getHealth(): HazardAiWorkerHealth;
  /** Health plus aggregate queue counts (count/oldest/expired-lease only). */
  getMetrics(): Promise<HazardAiWorkerMetrics>;
}

/**
 * Starts the poll loop (unless disabled) and the maintenance loop. Timers are
 * unref'd and nothing runs before the caller has a connected MongoDB.
 * Maintenance (stuck-job convergence, intake tombstones, known-path cleanup)
 * always runs: the kill switch only stops AI claims.
 *
 * @param deps External I/O seam (defaults to the real adapters)
 * @param options Kill switch
 * @returns A handle whose stop() is bounded
 */
export function startHazardAiWorker(
  deps: AiWorkerDeps = defaultAiWorkerDeps,
  options: HazardAiWorkerOptions = {},
): HazardAiWorkerHandle {
  const enabled = options.enabled !== false;
  const stopController = new AbortController();
  const stopped = () => stopController.signal.aborted;
  const inFlight = new Set<Promise<void>>();
  const counters: HazardAiWorkerHealth["counters"] = {
    claimed: 0,
    completed: 0,
    retried: 0,
    failed: 0,
    dropped: 0,
    aborted: 0,
  };
  let pollTimer: NodeJS.Timeout | undefined;
  let circuitOpenUntil = 0;
  let polling = false;
  let maintaining: Promise<void> | undefined;
  let cleaning: Promise<void> | undefined;
  let converging: Promise<void> | undefined;
  let lastPollAt: Date | undefined;
  let lastMaintenanceAt: Date | undefined;
  let lastCleanupAt: Date | undefined;
  let lastConvergenceAt: Date | undefined;

  const schedulePoll = () => {
    if (stopped() || !enabled) return;
    pollTimer = setTimeout(() => void poll(), HAZARD_AI.pollMs);
    pollTimer.unref?.();
  };

  async function poll(): Promise<void> {
    if (polling || stopped()) return;
    polling = true;
    try {
      lastPollAt = deps.now();
      while (
        !stopped() &&
        inFlight.size < HAZARD_AI.concurrency &&
        deps.now().getTime() >= circuitOpenUntil
      ) {
        const job = await claimNextAiJob(deps.now(), randomUUID());
        if (!job) break;
        counters.claimed++;
        // Shutdown during the claim: do not dispatch; the lease expires and
        // another process recovers it.
        if (stopped()) break;
        const run: Promise<void> = processAiJob(
          job,
          deps,
          stopController.signal,
        )
          .then(({ circuitBreak, outcome }) => {
            counters[outcome]++;
            if (circuitBreak) {
              // A credential failure would fail the whole backlog: stop
              // spending it this round and raise one alert.
              circuitOpenUntil = deps.now().getTime() + CIRCUIT_COOLDOWN_MS;
              console.error(
                "[hazard-ai] provider credential failure; claiming paused",
              );
            }
          })
          .catch(() => undefined)
          .finally(() => inFlight.delete(run));
        inFlight.add(run);
      }
    } catch (err) {
      console.error(
        "[hazard-ai] poll failed:",
        err instanceof Error ? err.name : err,
      );
    } finally {
      polling = false;
      schedulePoll();
    }
  }

  // Separate single-flight loop: slow GCS deletes must not delay terminal jobs.
  function converge(): Promise<void> {
    if (stopped()) return Promise.resolve();
    if (!converging) {
      converging = (async () => {
        try {
          const result = await convergeStuckAiJobs(deps.now());
          counters.failed += result.failed;
          if (result.failed || result.cancelled)
            console.warn("[hazard-ai] converged", JSON.stringify(result));
          lastConvergenceAt = deps.now();
        } catch (error) {
          console.error(
            "[hazard-ai] convergence failed:",
            error instanceof Error ? error.name : "unknown",
          );
        }
      })().finally(() => {
        converging = undefined;
      });
    }
    return converging;
  }

  async function runMaintenance(): Promise<void> {
    try {
      await convertExpiredIntakes(
        deps.now(),
        () => `deidentified:${randomUUID()}`,
      );
      lastMaintenanceAt = deps.now();
    } catch (err) {
      console.error(
        "[hazard-ai] intake anonymization failed:",
        err instanceof Error ? err.name : "unknown",
      );
    }
  }

  // Object deletion has its own single-flight loop: 20 serial timeouts must
  // not hold the privacy sweep or terminal convergence behind GCS.
  async function runCleanup(): Promise<void> {
    try {
      for (let i = 0; i < CLEANUP_BATCH && !stopped(); i++) {
        const claim = await claimIntakeCleanup(deps.now());
        if (!claim) break;
        try {
          await deps.deletePhoto(claim.storagePath);
          await settleIntakeCleanupSuccess(claim, deps.now());
        } catch {
          // Never drop tracking on a failed delete. Past the late-upload
          // window this is an alert, not a silent give-up.
          const overdue = deps.now().getTime() >= claim.cleanupUntil.getTime();
          console[overdue ? "error" : "warn"](
            "[hazard-ai] intake cleanup failed",
            JSON.stringify({
              reportId: claim.reportId,
              attempts: claim.attempts,
              overdue,
            }),
          );
          await settleIntakeCleanupFailure(claim, deps.now());
        }
      }
    } catch (err) {
      console.error(
        "[hazard-ai] cleanup failed:",
        err instanceof Error ? err.name : "unknown",
      );
    } finally {
      lastCleanupAt = deps.now();
    }
  }

  function cleanup(): Promise<void> {
    if (stopped()) return Promise.resolve();
    if (!cleaning) {
      cleaning = runCleanup().finally(() => {
        cleaning = undefined;
      });
    }
    return cleaning;
  }

  /** Single-flight: a slow run is never overlapped by the next tick. */
  function maintain(): Promise<void> {
    if (stopped()) return Promise.resolve();
    if (!maintaining) {
      maintaining = runMaintenance().finally(() => {
        maintaining = undefined;
      });
    }
    return maintaining;
  }

  void converge();
  const convergenceTimer = setInterval(
    () => void converge(),
    HAZARD_AI.convergenceMs,
  );
  convergenceTimer.unref?.();
  // Initial cleanup follows the initial sweep so newly converted tombstones
  // are eligible immediately. Subsequent loops are fully independent.
  void maintain().then(() => cleanup());
  const maintenanceTimer = setInterval(
    () => void maintain(),
    HAZARD_AI.maintenanceMs,
  );
  maintenanceTimer.unref?.();
  const cleanupTimer = setInterval(
    () => void cleanup(),
    HAZARD_AI.maintenanceMs,
  );
  cleanupTimer.unref?.();
  schedulePoll();

  const getHealth = (): HazardAiWorkerHealth => ({
    running: !stopped(),
    paused: !enabled,
    active: inFlight.size,
    circuitOpen: deps.now().getTime() < circuitOpenUntil,
    lastPollAt: lastPollAt?.toISOString() ?? null,
    lastMaintenanceAt: lastMaintenanceAt?.toISOString() ?? null,
    lastCleanupAt: lastCleanupAt?.toISOString() ?? null,
    lastConvergenceAt: lastConvergenceAt?.toISOString() ?? null,
    counters: { ...counters },
  });

  return {
    getHealth,
    async getMetrics() {
      const now = deps.now();
      const [queue, intake] = await Promise.all([
        getAiQueueSnapshot(now),
        getIntakeSnapshot(now),
      ]);
      return { health: getHealth(), queue, intake };
    },
    async stop() {
      stopController.abort();
      if (pollTimer) clearTimeout(pollTimer);
      clearInterval(maintenanceTimer);
      clearInterval(cleanupTimer);
      clearInterval(convergenceTimer);
      let waitTimer: NodeJS.Timeout | undefined;
      const deadline = new Promise<void>((resolve) => {
        waitTimer = setTimeout(resolve, STOP_WAIT_MS);
        waitTimer.unref?.();
      });
      await Promise.race([
        Promise.allSettled([...inFlight, maintaining, cleaning, converging]),
        deadline,
      ]);
      clearTimeout(waitTimer);
    },
  };
}
