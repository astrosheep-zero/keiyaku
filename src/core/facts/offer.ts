import type { ContractHead, ContractId, JournalEntry, SnapshotId } from "./types.js";

export type ContractJournalAppend = Readonly<{
  readonly contractId: ContractId;
  readonly expectedHead: ContractHead | null;
  readonly entries: readonly JournalEntry[];
}>;

/** A target operation is optional because claim can be journal-only. */
export type RefOperation = Readonly<{
  readonly target: string;
  readonly newOid: SnapshotId;
  readonly expectedOid: SnapshotId;
}>;

export type TreeUpdate = Readonly<{
  readonly path: string;
  readonly bytes: Uint8Array;
}>;

export type Offer = Readonly<{
  readonly facts: readonly ContractJournalAppend[];
  readonly target?: RefOperation;
  readonly companions?: readonly TreeUpdate[];
}>;
