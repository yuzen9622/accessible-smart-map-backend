/**
 * Resilience mechanism layer (infra) — the cross-cutting "how to fail" concern
 * shared by external adapters, sitting at the same level as `fetch.ts`.
 *
 * `withResilience` enforces a per-call timeout, a per-key circuit breaker and
 * uniform exception normalization: every failure surfaces as a `ResilienceError`
 * carrying one of the `ENV_REASON` codes. Callers (adapters) wrap their HTTP I/O
 * with it and simply `throw`; the degradation *policy* (tolerating which block is
 * missing) lives in the service layer.
 */
import { ENV_REASON, type EnvReason } from "../constants/environment";

const DEFAULT_TIMEOUT_MS = 5000;
const CIRCUIT_FAILURE_THRESHOLD = 5;
const CIRCUIT_COOLDOWN_MS = 30_000;

/**
 * A failure normalized by `withResilience`, tagged with a stable `reason` code so
 * the service layer can attach it to the unavailable block without re-classifying.
 */
export class ResilienceError extends Error {
  readonly reason: EnvReason;

  constructor(reason: EnvReason, message: string) {
    super(message);
    this.name = "ResilienceError";
    this.reason = reason;
  }
}

/**
 * Thrown by adapters when an upstream returns a non-2xx HTTP status; normalized
 * to `UPSTREAM_HTTP_ERROR`.
 */
export class UpstreamHttpError extends Error {
  readonly status: number;

  constructor(status: number, message?: string) {
    super(message ?? `Upstream responded with HTTP ${status}`);
    this.name = "UpstreamHttpError";
    this.status = status;
  }
}

/**
 * Thrown by adapters when an upstream response cannot be parsed or is missing
 * required fields; normalized to `UPSTREAM_BAD_PAYLOAD`.
 */
export class UpstreamBadPayloadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UpstreamBadPayloadError";
  }
}

interface CircuitState {
  failures: number;
  openedAt: number | null;
}

const circuits = new Map<string, CircuitState>();

function circuitFor(key: string): CircuitState {
  let state = circuits.get(key);
  if (!state) {
    state = { failures: 0, openedAt: null };
    circuits.set(key, state);
  }
  return state;
}

function isCircuitOpen(state: CircuitState): boolean {
  if (state.openedAt === null) return false;
  if (Date.now() - state.openedAt < CIRCUIT_COOLDOWN_MS) return true;
  state.openedAt = null;
  state.failures = 0;
  return false;
}

function recordSuccess(state: CircuitState): void {
  state.failures = 0;
  state.openedAt = null;
}

function recordFailure(state: CircuitState): void {
  state.failures += 1;
  if (state.failures >= CIRCUIT_FAILURE_THRESHOLD) {
    state.openedAt = Date.now();
  }
}

function normalize(err: unknown, timedOut: boolean): ResilienceError {
  if (err instanceof ResilienceError) return err;
  if (timedOut || (err instanceof Error && err.name === "AbortError")) {
    return new ResilienceError(
      ENV_REASON.UPSTREAM_TIMEOUT,
      "Upstream request timed out",
    );
  }
  if (err instanceof UpstreamHttpError) {
    return new ResilienceError(ENV_REASON.UPSTREAM_HTTP_ERROR, err.message);
  }
  if (err instanceof UpstreamBadPayloadError) {
    return new ResilienceError(ENV_REASON.UPSTREAM_BAD_PAYLOAD, err.message);
  }
  const message = err instanceof Error ? err.message : String(err);
  return new ResilienceError(ENV_REASON.UPSTREAM_HTTP_ERROR, message);
}

/**
 * Runs an async upstream call under a timeout and a per-key circuit breaker,
 * normalizing any failure into a `ResilienceError` and logging its cause once.
 *
 * @param circuitKey Stable key grouping calls to the same upstream for breaker state.
 * @param fn The I/O thunk; it receives an `AbortSignal` to pass to `fetch`.
 * @param opts Optional overrides; `timeoutMs` defaults to 5000.
 * @returns The thunk's resolved value.
 * @throws ResilienceError on timeout, HTTP error, bad payload or an open circuit.
 */
export async function withResilience<T>(
  circuitKey: string,
  fn: (signal: AbortSignal) => Promise<T>,
  opts: { timeoutMs?: number } = {},
): Promise<T> {
  const state = circuitFor(circuitKey);
  if (isCircuitOpen(state)) {
    const error = new ResilienceError(
      ENV_REASON.CIRCUIT_OPEN,
      `Circuit open for ${circuitKey}`,
    );
    console.warn(
      `[resilience:${circuitKey}] ${error.reason} — ${error.message}`,
    );
    throw error;
  }

  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(
        new ResilienceError(
          ENV_REASON.UPSTREAM_TIMEOUT,
          "Upstream request timed out",
        ),
      );
    }, opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  });

  try {
    const result = await Promise.race([fn(controller.signal), timeout]);
    recordSuccess(state);
    return result;
  } catch (err) {
    recordFailure(state);
    const error = normalize(err, controller.signal.aborted);
    console.warn(
      `[resilience:${circuitKey}] ${error.reason} — ${error.message}`,
    );
    throw error;
  } finally {
    clearTimeout(timer!);
  }
}
