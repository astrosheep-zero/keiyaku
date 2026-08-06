import type { ContractId, ContractState, JournalEntry, SnapshotId } from "./types.js";

export type ContractObservation = Readonly<{
  id: ContractId;
  entries: readonly JournalEntry[];
  state: ContractState | null;
}>;

/** A carrier captures all observations in this value from one immutable snapshot. */
export type ContractsObservation = Readonly<{
  carrierSnapshot: SnapshotId | null;
  contracts: ReadonlyMap<ContractId, ContractObservation>;
}>;
