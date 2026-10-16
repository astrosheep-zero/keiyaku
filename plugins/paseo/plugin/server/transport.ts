import type { History } from "./keiyaku.js";
import type { Tell } from "./message.js";
import type { Stop } from "./stop.js";

/** The public Akuma configuration one read-only observation reports, when it is known. */
export type StatusObservation = Readonly<{ provider?: string; model?: string }>;
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
