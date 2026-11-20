import { z } from "zod";
import { AsyncLocalStorage } from "node:async_hooks";
import { join } from "node:path";
import { acquireSqliteTransactionLock, SqliteTransactionLockError } from "../coordination/sqlite-transaction-lock.js";
import { errorCategory, KeiyakuError } from "../errors.js";
import type { GitRepository } from "./process.js";

const PRIVATE_STATE_SEAT = "private-state.sqlite";
const PRIVATE_STATE_SEAT_ACQUIRE_TIMEOUT_MS = 15_000;
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
export const privateStateSeatCloseLagSchema = z
  .object({
    kind: z.literal("private-state-seat-close-failed"),
    diagnostic: z.string().refine((value) => value.trim() !== ""),
  })
  .strict()
  .readonly();
export type PrivateStateSeatCloseLag = z.infer<typeof privateStateSeatCloseLagSchema>;
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

async function acquirePrivateStateSeatLock(
  repository: GitRepository,
  path: string,
  timeoutMs: number | null | undefined,
): Promise<Awaited<ReturnType<typeof acquireSqliteTransactionLock>>> {
  try {
    return await acquireSqliteTransactionLock({
      path,
      mode: "immediate",
      ...(timeoutMs === null ? {} : { timeoutMs: timeoutMs ?? PRIVATE_STATE_SEAT_ACQUIRE_TIMEOUT_MS }),
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

type PrivateStateSeatOptions = Readonly<{
  /** Null leaves acquisition bounded only by the repository's caller signal. */
  timeoutMs?: number | null;
  onCloseLag?: (lag: PrivateStateSeatCloseLag) => void;
}>;

async function runPrivateStateSeatAction<T>(
  repository: GitRepository,
  held: Awaited<ReturnType<typeof acquireSqliteTransactionLock>>,
  action: (seat: PrivateStatePublicationSeat) => T | Promise<T>,
  onCloseLag: PrivateStateSeatOptions["onCloseLag"],
): Promise<PrivateStateSeatOutcome<T>> {
  const seat: PrivateStatePublicationSeat = { [privateStateSeat]: true };
  let result: { value: T } | { error: unknown };
  try {
    result = { value: await action(seat) };
  } catch (error) {
    result = { error };
  }
  try {
    held.close();
    repository.onPrivateStateSeatClose?.();
  } catch (retirement) {
    const lag = privateStateSeatCloseLag(retirement);
    if ("value" in result) {
      if (
        confirmedPublications.has(seat) &&
        retirement instanceof SqliteTransactionLockError &&
        retirement.reason === "release-failed"
      )
        return { ...result, closeLag: lag };
      throw retirement;
    }
    const { error } = result;
    if (onCloseLag !== undefined) {
      try {
        onCloseLag(lag);
      } catch {
        throw privateStatePublicationRetirementFailure(error, retirement, "Publication seat", repository.signal);
      }
      throw error;
    }
    throw privateStatePublicationRetirementFailure(error, retirement, "Publication seat", repository.signal);
  }
  if ("error" in result) throw result.error;
  return result;
}

export function privateStatePublicationRetirementFailure(
  error: unknown,
  retirement: unknown,
  resource: string,
  signal?: AbortSignal,
): KeiyakuError {
  const primary = error instanceof Error ? error.message : String(error);
  const { diagnostic } = privateStateSeatCloseLag(retirement);
  return Object.assign(
    new KeiyakuError(errorCategory(error, signal), `${primary}\n${resource} close also failed: ${diagnostic}`, {
      cause: error,
    }),
    { retirement },
  );
}

/** Serialize cooperating writers of the one private Git state root. */
export async function withPrivateStatePublicationSeat<T>(
  repository: GitRepository,
  action: (seat: PrivateStatePublicationSeat) => T | Promise<T>,
  options?: PrivateStateSeatOptions,
): Promise<PrivateStateSeatOutcome<T>> {
  const path = privateStatePublicationSeatPath(repository);
  const heldPaths = heldPrivateStateSeats.getStore();
  if (heldPaths?.has(path) === true) {
    throw new Error(`private-state publication seat reentered: ${path}`);
  }
  const held = await acquirePrivateStateSeatLock(repository, path, options?.timeoutMs);
  const nested = new Set(heldPaths);
  nested.add(path);
  return await heldPrivateStateSeats.run(nested, () =>
    runPrivateStateSeatAction(repository, held, action, options?.onCloseLag),
  );
}
