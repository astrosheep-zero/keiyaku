import type { ContractHead, ContractId, JournalEntry, SnapshotId } from "./types.js";

export interface ContractJournalAppend {
  readonly contractId: ContractId;
  readonly expectedHead?: ContractHead | null;
  readonly entries: readonly JournalEntry[];
}

/** A target operation is optional because claim can be journal-only. */
export interface RefOperation {
  readonly target: string;
  readonly newOid: SnapshotId;
  readonly expectedOid: SnapshotId;
}

export interface Offer {
  readonly facts: readonly ContractJournalAppend[];
  readonly target?: RefOperation;
}
