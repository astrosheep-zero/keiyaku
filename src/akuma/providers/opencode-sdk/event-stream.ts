import type { AttemptCustody } from "../../provider.js";
import type { OpencodeEventSubscriptionRequest } from "./session.js";

/**
 * One adapter-private owner for every resource an OpenCode event subscription
 * creates: the native subscription, its fetch and reader, the pending read, and
 * the SDK's retry waiting. `closed` resolves only after those resources really
 * retired; a teardown rejection escapes through it, and an unprovable
 * retirement leaves it pending so existing custody reports the attempt hung.
 */
export type OwnedEventStream = Readonly<{
  /** Subscription barrier: resolves once the native subscription exists, rejects on setup failure. */
  ready: Promise<void>;
  /** Reads the next native event. A pending read is interrupted by `retire`. */
  next(): Promise<IteratorResult<unknown>>;
  /** Aborts the owned signal, settles any pending read, then awaits real iterator retirement. */
  retire(): Promise<void>;
  /** Resolves only when subscription, reader, and retry waiting actually ended. */
  closed: Promise<void>;
}>;

/**
 * A backoff sleep that resolves when the owned signal aborts and always clears
 * its timer. Cancellation before the sleep starts completes immediately, and a
 * simultaneous timeout and abort still settles once and drops the listener.
 */
function cancellableSleep(signal: AbortSignal): (milliseconds: number) => Promise<void> {
  return (milliseconds) =>
    new Promise<void>((resolve) => {
      if (signal.aborted) {
        resolve();
        return;
      }
      let timer: ReturnType<typeof setTimeout> | undefined;
      const finish = (): void => {
        if (timer !== undefined) clearTimeout(timer);
        signal.removeEventListener("abort", finish);
        resolve();
      };
      timer = setTimeout(finish, milliseconds);
      signal.addEventListener("abort", finish, { once: true });
    });
}

export function ownEventStream(
  input: Readonly<{
    directory: string;
    /** The session/attempt notification signal this owner's controller follows. */
    signal: AbortSignal;
    subscribe(request: OpencodeEventSubscriptionRequest): Promise<Readonly<{ stream: AsyncIterable<unknown> }>>;
    custody?: AttemptCustody;
  }>,
): OwnedEventStream {
  const controller = new AbortController();
  const follow = (): void => {
    if (!controller.signal.aborted) controller.abort(input.signal.reason);
  };
  input.signal.addEventListener("abort", follow, { once: true });
  if (input.signal.aborted) follow();

  let iterator: AsyncIterator<unknown> | undefined;
  let pending: Promise<IteratorResult<unknown>> | undefined;
  let settling: Promise<void> | undefined;
  let ready!: Promise<void>;
  let subscribed!: () => void;
  // Retirement may be requested the moment custody owns this stream, so it
  // waits for the one subscription call rather than reaching an unset value.
  const subscribing = new Promise<void>((resolve) => {
    subscribed = resolve;
  });
  let settleClosed!: () => void;
  let rejectClosed!: (reason?: unknown) => void;
  const closed = new Promise<void>((resolve, reject) => {
    settleClosed = resolve;
    rejectClosed = reject;
  });

  const retire = (): Promise<void> => {
    if (settling !== undefined) return settling;
    settling = (async (): Promise<void> => {
      // Abort first: it interrupts the SDK's fetch, reader, and backoff and
      // settles a pending read, before iterator return can be waited on.
      if (!controller.signal.aborted) controller.abort(new Error("OpenCode event stream retired"));
      input.signal.removeEventListener("abort", follow);
      await subscribing;
      await ready.catch(() => undefined);
      const reading = pending;
      if (reading !== undefined) await reading.catch(() => undefined);
      if (iterator?.return !== undefined) await iterator.return(undefined);
    })();
    settling.then(settleClosed, rejectClosed);
    return settling;
  };

  // The owner is registered before native subscription setup begins, so
  // resources arriving after cancellation are still owned and retired.
  input.custody?.own({ closed, abort: retire, forceDispose: retire });

  ready = (async (): Promise<void> => {
    const subscription = await input.subscribe({
      directory: input.directory,
      signal: controller.signal,
      sleep: cancellableSleep(controller.signal),
    });
    iterator = subscription.stream[Symbol.asyncIterator]();
  })();
  subscribed();
  void ready.catch(() => undefined);

  return {
    ready,
    next: () => {
      const reading = ready.then(() => iterator!.next());
      pending = reading;
      void reading.catch(() => undefined);
      return reading;
    },
    retire,
    closed,
  };
}
