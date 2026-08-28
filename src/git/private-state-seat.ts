import { join } from "node:path";
import { acquireSqliteTransactionLock } from "../coordination/sqlite-transaction-lock.js";
import type { GitRepository } from "./process.js";

const PRIVATE_STATE_SEAT = "private-state.sqlite";
const privateStateSeat: unique symbol = Symbol("private-state-seat");
const confirmedPublications = new WeakSet<PrivateStatePublicationSeat>();

/** Proves an admission's private-root observation was made while the shared seat was held. */
export type PrivateStatePublicationSeat = Readonly<{ readonly [privateStateSeat]: true }>;

/** Record a known or exact-read-back-proven private-root publication. */
export function confirmPrivateStatePublication(seat: PrivateStatePublicationSeat): void {
  confirmedPublications.add(seat);
}

export function privateStatePublicationSeatPath(repository: GitRepository): string {
  return join(repository.commonDirectory, "keiyaku", "locks", PRIVATE_STATE_SEAT);
}

/** Serialize cooperating writers of the one private Git state root. */
export async function withPrivateStatePublicationSeat<T>(
  repository: GitRepository,
  action: (seat: PrivateStatePublicationSeat) => T | Promise<T>,
): Promise<T> {
  const held = await acquireSqliteTransactionLock({
    path: privateStatePublicationSeatPath(repository),
    mode: "immediate",
    ...(repository.signal === undefined ? {} : { signal: repository.signal }),
    ...(repository.onPrivateStateSeatContention === undefined
      ? {}
      : { onContended: repository.onPrivateStateSeatContention }),
  });
  const seat: PrivateStatePublicationSeat = { [privateStateSeat]: true };
  let completed = false;
  try {
    const result = await action(seat);
    completed = true;
    return result;
  } finally {
    try {
      held.close();
    } catch (error) {
      if (!(completed && confirmedPublications.has(seat))) throw error;
    }
  }
}
