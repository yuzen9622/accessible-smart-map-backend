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
