export function abortable<T>(
  operation: Promise<T>,
  signal: AbortSignal,
  disposeLate?: (value: T) => Promise<void> | void,
): Promise<T> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    let aborted = false;
    const abort = (): void => {
      aborted = true;
      if (disposeLate === undefined) reject(signal.reason);
    };
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    void operation.then(async (value) => {
      signal.removeEventListener("abort", abort);
      if (!aborted) { resolve(value); return; }
      try { await disposeLate?.(value); }
      catch (error) { reject(error); return; }
      reject(signal.reason);
    }, (error: unknown) => {
      signal.removeEventListener("abort", abort);
      reject(aborted ? signal.reason : error);
    });
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
