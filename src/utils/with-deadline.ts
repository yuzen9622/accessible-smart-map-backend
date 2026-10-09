/** Bound SDK promises locally; cancellation is best effort, not remote rollback. */
export async function withDeadline<T>(
  start: () => Promise<T>,
  options: { signal?: AbortSignal; timeoutMs: number },
  abortError: () => Error,
): Promise<T> {
  if (options.signal?.aborted) throw abortError();
  const task = start();
  return new Promise<T>((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", abort);
    };
    const abort = () => {
      cleanup();
      const cancellable = task as Promise<T> & { cancel?: () => void };
      try {
        cancellable.cancel?.();
      } catch {
        /* already settled SDK call */
      }
      reject(abortError());
    };
    const timer = setTimeout(abort, options.timeoutMs);
    options.signal?.addEventListener("abort", abort, { once: true });
    task.then(
      (value) => {
        cleanup();
        resolve(value);
      },
      (error) => {
        cleanup();
        reject(error);
      },
    );
    // Avoid dispatch/result races between the initial check and subscription.
    if (options.signal?.aborted) abort();
  });
}
