/**
 * twipcam HTTP I/O for CCTV. Fetches the public nationwide camera list (no auth,
 * no params) and returns it raw; distance filtering and field mapping are the
 * parser's job. The full list is cached under a single key since twipcam has no
 * coordinate-scoped JSON endpoint. Failures are thrown via `withResilience`.
 */
import { redisGet, redisSet } from "../config/redis";
import {
  UpstreamBadPayloadError,
  UpstreamHttpError,
  withResilience,
} from "../config/resilience";
import {
  CCTV_CACHE_KEY,
  ENV_CACHE_TTL_SEC,
  TWIPCAM_CAM_LIST_URL,
} from "../constants/environment";
import type { RawCamera } from "../modules/environment/environment.types";

const CIRCUIT_KEY = "twipcam";

/**
 * Returns the full nationwide twipcam camera list, served from cache when warm.
 *
 * @returns The raw camera array as provided by twipcam.
 * @throws ResilienceError on upstream failure or an unparseable payload.
 */
export async function fetchCamList(): Promise<RawCamera[]> {
  const cached = await redisGet(CCTV_CACHE_KEY);
  if (cached) {
    return JSON.parse(cached) as RawCamera[];
  }

  const cameras = await withResilience(CIRCUIT_KEY, async (signal) => {
    const res = await fetch(TWIPCAM_CAM_LIST_URL, { signal });
    if (!res.ok) throw new UpstreamHttpError(res.status);

    const data = (await res.json()) as unknown;
    if (!Array.isArray(data)) {
      throw new UpstreamBadPayloadError(
        "twipcam cam-list did not return an array",
      );
    }
    return data as RawCamera[];
  });

  await redisSet(
    CCTV_CACHE_KEY,
    JSON.stringify(cameras),
    ENV_CACHE_TTL_SEC.CCTV,
  );
  return cameras;
}
