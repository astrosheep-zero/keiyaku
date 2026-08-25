export function abortable<T>(
  operation: Promise<T>,
  signal: AbortSignal,
  disposeLate?: (value: T) => Promise<void> | void,
): Promise<T> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    let aborted = false;
    let settled = false;
    const abort = (): void => {
      aborted = true;
      if (!settled) {
        settled = true;
        reject(signal.reason);
      }
    };
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    void operation.then(
      async (value) => {
        signal.removeEventListener("abort", abort);
        if (!aborted) {
          settled = true;
          resolve(value);
          return;
        }
        void Promise.resolve(disposeLate?.(value)).catch(() => undefined);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", abort);
        if (settled) return;
        settled = true;
        reject(aborted ? signal.reason : error);
      },
    );
  });
}

export function abortableDelay(milliseconds: number, signal?: AbortSignal): Promise<void> {
  if (signal === undefined) return new Promise((resolve) => setTimeout(resolve, milliseconds));
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolve();
    }, milliseconds);
    const abort = (): void => {
      clearTimeout(timeout);
      reject(signal.reason);
    };
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
  });
}
