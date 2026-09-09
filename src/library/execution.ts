import type { ExecutionEvent, ExecutionObserver } from "../protocol/execution-observation.js";
export type { ExecutionEvent } from "../protocol/execution-observation.js";

export type ContractExecution<Result> = Readonly<{
  progress: AsyncIterable<ExecutionEvent>;
  result: Promise<Result>;
}>;

const MAX_EVENTS = 256;
const MAX_BYTES = 128 * 1024;

class BoundedExecutionProgress {
  private readonly pending: { event: ExecutionEvent; bytes: number }[] = [];
  private bytes = 0;
  private dropped = 0;
  private finished = false;
  private unsubscribed = false;
  private subscribed = false;
  private wake: (() => void) | undefined;

  private notify(): void {
    const waiter = this.wake;
    this.wake = undefined;
    waiter?.();
  }

  readonly publish: ExecutionObserver = (event) => {
    if (this.unsubscribed || this.finished) return;
    const size = Buffer.byteLength(JSON.stringify(event));
    if (size > MAX_BYTES) {
      this.dropped += 1;
      this.notify();
      return;
    }
    while (this.pending.length >= MAX_EVENTS || this.bytes + size > MAX_BYTES) {
      this.bytes -= this.pending.shift()!.bytes;
      this.dropped += 1;
    }
    this.pending.push({ event, bytes: size });
    this.bytes += size;
    this.notify();
  };

  close(): void {
    this.finished = true;
    this.notify();
  }

  iterable(): AsyncIterable<ExecutionEvent> {
    return {
      [Symbol.asyncIterator]: () => this.iterator(),
    };
  }

  private iterator(): AsyncIterator<ExecutionEvent> {
    if (this.subscribed) throw new Error("execution progress supports one subscription");
    this.subscribed = true;
    let reading = false;
    return {
      next: async (): Promise<IteratorResult<ExecutionEvent>> => {
        if (reading) throw new Error("execution progress next calls must be serial");
        reading = true;
        try {
          for (;;) {
            const next = await this.next();
            if (next !== undefined) return next;
          }
        } finally {
          reading = false;
        }
      },
      return: async (): Promise<IteratorResult<ExecutionEvent>> => {
        this.unsubscribed = true;
        this.pending.length = 0;
        this.bytes = 0;
        this.dropped = 0;
        this.notify();
        return { done: true, value: undefined };
      },
    };
  }

  private async next(): Promise<IteratorResult<ExecutionEvent> | undefined> {
    if (this.unsubscribed) return { done: true, value: undefined };
    if (this.dropped > 0) {
      const count = this.dropped;
      this.dropped = 0;
      return { done: false, value: { kind: "progress-dropped", count } };
    }
    const pending = this.pending.shift();
    if (pending !== undefined) {
      this.bytes -= pending.bytes;
      return { done: false, value: pending.event };
    }
    if (this.finished) return { done: true, value: undefined };
    await new Promise<void>((resolve) => {
      this.wake = resolve;
    });
    return undefined;
  }
}

/** An eager invocation with one bounded, optional progress subscription. */
export function startContractExecution<Result>(
  run: (observe: ExecutionObserver) => Promise<Result>,
): ContractExecution<Result> {
  const observations = new BoundedExecutionProgress();
  const result = Promise.resolve()
    .then(() => run(observations.publish))
    .finally(() => observations.close());
  void result.catch(() => undefined);
  return Object.freeze({ progress: observations.iterable(), result });
}
