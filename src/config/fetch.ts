import { tdxTokenManager } from "../adapters/tdx.adapter";

/** Detach a caller without aborting the shared token refresh. */
function withSignal<T>(
  promise: Promise<T>,
  signal?: AbortSignal | null,
): Promise<T> {
  if (!signal) return promise;
  return new Promise((resolve, reject) => {
    const aborted = () => reject(signal.reason ?? new Error("Aborted"));
    if (signal.aborted) {
      aborted();
      return;
    }
    signal.addEventListener("abort", aborted, { once: true });
    promise
      .then(resolve, reject)
      .finally(() => signal.removeEventListener("abort", aborted));
  });
}

/**
 * 包裝 fetch：自動加上 Bearer token。401 時強制刷新 token 後重試一次；
 * 429（配額/速率限制）時退避 1.5s 後重試一次。
 *
 * @param url 請求的 URL
 * @param init fetch 的 RequestInit 選項
 * @param _retried 內部用旗標，標記是否已重試過
 * @returns fetch 的 Response
 */
export async function tdxFetch(
  url: string,
  init?: RequestInit,
  _retried = false,
) {
  init?.signal?.throwIfAborted();
  const token = await withSignal(tdxTokenManager.getToken(), init?.signal);
  const headers = new Headers(init?.headers || {});
  if (!headers.has("Authorization"))
    headers.set("Authorization", `Bearer ${token}`);

  const res = await fetch(url, { ...init, headers });

  if (res.status === 401 && !_retried) {
    await withSignal(tdxTokenManager.refreshToken(true), init?.signal);
    return tdxFetch(url, init, true);
  }

  if (res.status === 429 && !_retried) {
    await withSignal(new Promise((r) => setTimeout(r, 1500)), init?.signal);
    return tdxFetch(url, init, true);
  }

  return res;
}
