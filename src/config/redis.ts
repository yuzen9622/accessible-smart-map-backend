/**
 * Singleton Redis client with graceful degradation.
 *
 * Reads process.env.REDIS_URL. If unset, no connection is attempted and every
 * operation silently no-ops (behaves as a cache miss). If the connection fails
 * at any point, operations also no-op — the app must never crash because Redis
 * is down. Connection errors are logged at most once.
 */
import Redis from "ioredis";

let logged = false;
let redisClient: Redis | null = null;

if (process.env.REDIS_URL) {
  redisClient = new Redis(process.env.REDIS_URL, {
    lazyConnect: true,
    enableOfflineQueue: false,
    maxRetriesPerRequest: 0,
    connectTimeout: 3000,
    protocol: 2, // keep the RESP2 wire protocol (ioredis 6 defaults to RESP3, which needs Redis >= 6)
  });

  redisClient.on("error", (err: Error) => {
    if (!logged) {
      console.warn(
        "[Redis] connection error — walk cache disabled:",
        err.message,
      );
      logged = true;
    }
  });

  redisClient.connect().catch(() => {
    /* handled by "error" event */
  });
}

export { redisClient };

let readyPromise: Promise<void> | null = null;

/**
 * Resolves once the shared Redis client is connected and ready, bounded by
 * `timeoutMs`. Rejects when Redis is not configured, the connection attempt
 * errors, or the timeout elapses — callers keep their fail-open behavior.
 *
 * Needed because rate-limit-redis issues its `SCRIPT LOAD` when the store is
 * constructed (module load), which races the client's async connect: with
 * `enableOfflineQueue: false` the command is rejected before the stream is
 * writable, permanently breaking the store. Waiting for readiness first fixes
 * that race without buffering commands.
 *
 * Concurrent callers share a single pending promise (one listener pair), which
 * is reset once it settles so a later connection failure can be retried.
 *
 * @param timeoutMs How long to wait for a ready connection before rejecting.
 * @returns A promise that resolves once the client reports `ready`.
 */
export function redisReady(timeoutMs = 5000): Promise<void> {
  if (!redisClient) return Promise.reject(new Error("Redis not configured"));
  const client = redisClient;
  if (client.status === "ready") return Promise.resolve();
  if (!readyPromise) {
    readyPromise = new Promise<void>((resolve, reject) => {
      let timer: NodeJS.Timeout | undefined;
      const cleanup = () => {
        if (timer) clearTimeout(timer);
        client.off("ready", onReady);
        client.off("error", onError);
      };
      const onReady = () => {
        cleanup();
        resolve();
      };
      const onError = (err: Error) => {
        cleanup();
        reject(err);
      };
      timer = setTimeout(() => {
        cleanup();
        reject(new Error(`Redis not ready within ${timeoutMs}ms`));
      }, timeoutMs);
      client.once("ready", onReady);
      client.once("error", onError);
    }).finally(() => {
      readyPromise = null;
    });
  }
  return readyPromise;
}

/**
 * Returns the stored string, or null on miss / unavailable / error.
 *
 * @param key The cache key to look up.
 * @returns The stored string, or null on miss / unavailable / error.
 */
export async function redisGet(key: string): Promise<string | null> {
  if (!redisClient) return null;
  try {
    return await redisClient.get(key);
  } catch {
    return null;
  }
}

/**
 * Stores a string with a TTL in seconds. No-ops on unavailable / error.
 *
 * @param key The cache key to store under.
 * @param value The string value to store.
 * @param ttlSec Time-to-live in seconds.
 */
export async function redisSet(
  key: string,
  value: string,
  ttlSec: number,
): Promise<void> {
  if (!redisClient) return;
  try {
    await redisClient.set(key, value, "EX", ttlSec);
  } catch {
    /* no-op */
  }
}

/**
 * Stores a string with a TTL and reports whether Redis confirmed the write.
 * Use this for capability tokens: callers must not return a token that cannot
 * subsequently be resolved.
 */
export async function redisSetChecked(
  key: string,
  value: string,
  ttlSec: number,
): Promise<boolean> {
  if (!redisClient) return false;
  try {
    return (await redisClient.set(key, value, "EX", ttlSec)) === "OK";
  } catch {
    return false;
  }
}

/**
 * Atomically sets a key only if it does not already exist, with a TTL in seconds.
 * Returns true when the key was newly set (caller should proceed), false when it
 * already existed (a duplicate). On unavailable / error it FAILS OPEN (returns
 * true) so an emergency event is never dropped just because Redis is down —
 * downstream idempotency guards (atomic Mongo updates) absorb any reprocessing.
 *
 * @param key The dedup key.
 * @param ttlSec Time-to-live in seconds.
 * @returns true if newly set or Redis unavailable; false if the key already existed.
 */
export async function redisSetNx(
  key: string,
  ttlSec: number,
): Promise<boolean> {
  if (!redisClient) return true;
  try {
    const res = await redisClient.set(key, "1", "EX", ttlSec, "NX");
    return res === "OK";
  } catch {
    return true;
  }
}

/**
 * Deletes a key. No-ops on unavailable / error.
 *
 * @param key The cache key to delete.
 */
export async function redisDel(key: string): Promise<void> {
  if (!redisClient) return;
  try {
    await redisClient.del(key);
  } catch {
    /* no-op */
  }
}
