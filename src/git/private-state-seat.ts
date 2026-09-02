import { AsyncLocalStorage } from "node:async_hooks";
import { join } from "node:path";
import { acquireSqliteTransactionLock, SqliteTransactionLockError } from "../coordination/sqlite-transaction-lock.js";
import type { GitRepository } from "./process.js";

const PRIVATE_STATE_SEAT = "private-state.sqlite";
const PRIVATE_STATE_SEAT_ACQUIRE_TIMEOUT_MS = 5_000;
const privateStateSeat: unique symbol = Symbol("private-state-seat");
const confirmedPublications = new WeakSet<PrivateStatePublicationSeat>();
const heldPrivateStateSeats = new AsyncLocalStorage<ReadonlySet<string>>();

/** Timed-out wait for the private-state publication seat. The holder and lock are unchanged. */
export class GitPrivateStateSeatContentionError extends Error {
  readonly reason = "timeout" as const;

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "GitPrivateStateSeatContentionError";
  }
}

/** Proves an admission's private-root observation was made while the shared seat was held. */
export type PrivateStatePublicationSeat = Readonly<{ readonly [privateStateSeat]: true }>;

/** Post-confirmation failure to release the private-state publication seat. */
export type PrivateStateSeatCloseLag = Readonly<{
  kind: "private-state-seat-close-failed";
  diagnostic: string;
}>;

/** Action result plus any confirmed-publication seat-close lag. */
export type PrivateStateSeatOutcome<T> = Readonly<{
  value: T;
  closeLag?: PrivateStateSeatCloseLag;
}>;

/** Record a known or exact-read-back-proven private-root publication. */
export function confirmPrivateStatePublication(seat: PrivateStatePublicationSeat): void {
  confirmedPublications.add(seat);
}

export function privateStatePublicationSeatPath(repository: GitRepository): string {
  return join(repository.commonDirectory, "keiyaku", "locks", PRIVATE_STATE_SEAT);
}

export function privateStateSeatCloseLag(error: unknown): PrivateStateSeatCloseLag {
  return {
    kind: "private-state-seat-close-failed",
    diagnostic: error instanceof Error ? error.message : String(error),
  };
}

export function concatenatePrivateStateSeatClose(
  current: readonly PrivateStateSeatCloseLag[] | undefined,
  next: readonly PrivateStateSeatCloseLag[] | undefined,
): readonly PrivateStateSeatCloseLag[] | undefined {
  const lags = [...(current ?? []), ...(next ?? [])];
  return lags.length === 0 ? undefined : lags;
}

export function appendPrivateStateSeatClose(
  current: readonly PrivateStateSeatCloseLag[] | undefined,
  closeLag: PrivateStateSeatCloseLag,
): readonly PrivateStateSeatCloseLag[] {
  return current === undefined ? [closeLag] : [...current, closeLag];
}

/** Unwrap a seat outcome that has no typed lag surface; confirmed close lag throws. */
export function requireClosedPrivateStateSeat<T>(outcome: PrivateStateSeatOutcome<T>): T {
  if (outcome.closeLag !== undefined) throw new Error(outcome.closeLag.diagnostic);
  return outcome.value;
}

/** Unwrap a seat outcome through an owner-typed merge of confirmed close lag. */
export function mergePrivateStateSeatClose<T>(
  outcome: PrivateStateSeatOutcome<T>,
  merge: (value: T, closeLag: PrivateStateSeatCloseLag) => T,
): T {
  return outcome.closeLag === undefined ? outcome.value : merge(outcome.value, outcome.closeLag);
}

export function isPrivateStateSeatContention(error: unknown): error is GitPrivateStateSeatContentionError {
  return error instanceof GitPrivateStateSeatContentionError;
}

function acquireTimeoutMs(timeoutMs: number | undefined): number {
  return timeoutMs ?? PRIVATE_STATE_SEAT_ACQUIRE_TIMEOUT_MS;
}

async function acquirePrivateStateSeatLock(
  repository: GitRepository,
  path: string,
  timeoutMs: number | undefined,
): Promise<Awaited<ReturnType<typeof acquireSqliteTransactionLock>>> {
  try {
    return await acquireSqliteTransactionLock({
      path,
      mode: "immediate",
      timeoutMs: acquireTimeoutMs(timeoutMs),
      ...(repository.signal === undefined ? {} : { signal: repository.signal }),
      ...(repository.onPrivateStateSeatContention === undefined
        ? {}
        : { onContended: repository.onPrivateStateSeatContention }),
    });
  } catch (error) {
    if (error instanceof SqliteTransactionLockError && error.reason === "timeout") {
      throw new GitPrivateStateSeatContentionError(error.message, { cause: error });
    }
    throw error;
  }
}

async function runPrivateStateSeatAction<T>(
  repository: GitRepository,
  held: Awaited<ReturnType<typeof acquireSqliteTransactionLock>>,
  action: (seat: PrivateStatePublicationSeat) => T | Promise<T>,
): Promise<PrivateStateSeatOutcome<T>> {
  const seat: PrivateStatePublicationSeat = { [privateStateSeat]: true };
  let completed = false;
  let value: T | undefined;
  try {
    value = await action(seat);
    completed = true;
    return { value };
  } finally {
    try {
      held.close();
      repository.onPrivateStateSeatClose?.();
    } catch (error) {
      if (!(completed && confirmedPublications.has(seat))) throw error;
      return { value: value!, closeLag: privateStateSeatCloseLag(error) };
    }
  }
}

/** Serialize cooperating writers of the one private Git state root. */
export async function withPrivateStatePublicationSeat<T>(
  repository: GitRepository,
  action: (seat: PrivateStatePublicationSeat) => T | Promise<T>,
  options?: Readonly<{ timeoutMs?: number }>,
): Promise<PrivateStateSeatOutcome<T>> {
  const path = privateStatePublicationSeatPath(repository);
  const heldPaths = heldPrivateStateSeats.getStore();
  if (heldPaths?.has(path) === true) {
    throw new Error(`private-state publication seat reentered: ${path}`);
  }
  const held = await acquirePrivateStateSeatLock(repository, path, options?.timeoutMs);
  const nested = new Set(heldPaths);
  nested.add(path);
  return await heldPrivateStateSeats.run(nested, () => runPrivateStateSeatAction(repository, held, action));
}
