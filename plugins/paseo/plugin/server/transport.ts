import type { History } from "./keiyaku.js";
import type { Tell } from "./message.js";
import type { Stop } from "./stop.js";

/** Bound an observer operation even when the public host request cannot cancel. */
export function raceAbort<T>(signal: AbortSignal, operation: () => T | PromiseLike<T>): Promise<T> {
  signal.throwIfAborted();
  return new Promise<T>((resolve, reject) => {
    const finish = (outcome: Readonly<{ value: T }> | Readonly<{ error: unknown }>): void => {
      signal.removeEventListener("abort", onAbort);
      if ("error" in outcome) reject(outcome.error);
      else resolve(outcome.value);
    };
    const onAbort = () => finish({ error: signal.reason ?? new Error("Keiyaku observation was cancelled") });
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) { onAbort(); return; }
    Promise.resolve().then(() => {
      signal.throwIfAborted();
      return operation();
    }).then((value) => finish({ value }), (error: unknown) => finish({ error }));
  });
}

/** The public Akuma configuration one read-only observation reports, when it is known. */
export type StatusObservation = Readonly<{ provider?: string; model?: string; caller?:
  | Readonly<{ kind: "akuma"; world: string; akumaId: string }>
  | Readonly<{ kind: "external"; integration: string; id: string }>
  | Readonly<{ kind: "unknown" }>
}>;
/** Read one Akuma's public status projection for display; failure rejects. */
export type StatusReader = (world: string, akuId: string, signal: AbortSignal) => Promise<StatusObservation>;
/**
 * Observe one Akuma's current retained window continuously, including while it is
 * idle and across later Turns. Each frame is a complete bounded window, never a
 * delta; the subscription releases its reader when the caller stops pulling or
 * aborts. Failure rejects the pull that saw it and ends that subscription.
 */
export type Stream = (world: string, akuId: string, signal: AbortSignal) => AsyncIterable<History>;

/**
 * The one typed boundary between the Paseo bridge and the Keiyaku public
 * surface. It replaces the earlier CLI-shaped executor: no command strings, no
 * stdout JSON, no exit-code interpretation. Every operation carries its World
 * and Akuma coordinates, observes the caller's cancellation, and rejects with
 * its own diagnostic when it cannot answer; mutation outcomes are only ever the
 * public operations' own receipts.
 *
 * `close` owns the transport's whole lifecycle: it refuses new requests and
 * settles every request still in flight as uncertain, but a single request's
 * cancellation must never terminate unrelated work.
 */
export type AkumaTransport = Readonly<{
  stream: Stream;
  tell: Tell;
  stop: Stop;
  status: StatusReader;
  close(): Promise<void>;
}>;
