type LateDisposal = {
  pending: number;
  failures: unknown[];
  waiters: { resolve(): void; reject(error: unknown): void }[];
};
const lateDisposals = new WeakMap<AbortSignal, LateDisposal>();

function lateDisposal(signal: AbortSignal): LateDisposal {
  const current = lateDisposals.get(signal);
  if (current !== undefined) return current;
  const created: LateDisposal = { pending: 0, failures: [], waiters: [] };
  lateDisposals.set(signal, created);
  return created;
}

/** Wait for resources that completed after their caller was cancelled. */
export function awaitLateDisposal(signal: AbortSignal): Promise<void> {
  const state = lateDisposal(signal);
  if (state.pending === 0) return state.failures.length === 0 ? Promise.resolve() : Promise.reject(state.failures[0]);
  return new Promise<void>((resolve, reject) => state.waiters.push({ resolve, reject }));
}

function settleLateDisposals(state: LateDisposal): void {
  if (state.pending !== 0) return;
  const failure = state.failures[0];
  for (const waiter of state.waiters.splice(0)) {
    if (failure === undefined) waiter.resolve();
    else waiter.reject(failure);
  }
}

export function abortable<T>(
  operation: Promise<T>,
  signal: AbortSignal,
  disposeLate?: (value: T) => Promise<void> | void,
): Promise<T> {
  signal.throwIfAborted();
  const state = disposeLate === undefined ? undefined : lateDisposal(signal);
  if (state !== undefined) state.pending += 1;
  const operationSettled = (): void => {
    if (state === undefined) return;
    state.pending -= 1;
    settleLateDisposals(state);
  };
  return new Promise((resolve, reject) => {
    let aborted = false;
    let settled = false;
    let operationSettledOnce = false;
    const settleOperation = (): void => {
      if (operationSettledOnce) return;
      operationSettledOnce = true;
      operationSettled();
    };
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
          settleOperation();
          resolve(value);
          return;
        }
        const disposal = Promise.resolve(disposeLate?.(value));
        disposal.then(operationSettled, (error: unknown) => {
          state?.failures.push(error);
          operationSettled();
        });
        // Keep the rejection observed while retaining it for the owner to await.
        void disposal.catch(() => undefined);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", abort);
        settleOperation();
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
