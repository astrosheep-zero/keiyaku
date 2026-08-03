import { decodeJournal } from "../facts/codec.js";
import { foldJournal } from "../facts/fold.js";
import {
  contractHead,
  contractJournalPath,
  evidencePath,
  type ContractId,
  type ContractState,
  type JournalEntry,
} from "../facts/types.js";
import { readBlob, readCarrier, type GitRepository } from "../facts/repository.js";

export type ContractObservation = Readonly<{
  id: ContractId;
  entries: readonly JournalEntry[];
  state: ContractState | null;
}>;

export function observeContract(repository: GitRepository, id: ContractId): ContractObservation {
  const carrier = readCarrier(repository);
  const path = contractJournalPath(id);
  const journal = carrier.paths.get(path);
  if (journal === undefined) return { id, entries: [], state: null };
  if (journal.type !== "blob") throw new TypeError(`journal path is not a blob: ${path}`);

  const entries = decodeJournal(readBlob(repository, journal.oid).toString("utf8"));
  for (const entry of entries) {
    if (entry.kind !== "review" && entry.kind !== "check" && entry.kind !== "verification") continue;
    for (const ref of entry.data.evidence) {
      const path = evidencePath(id, ref);
      const evidence = carrier.paths.get(path);
      if (evidence === undefined || evidence.type !== "blob" || evidence.oid !== ref.oid) {
        throw new TypeError(`journal evidence is not reachable at the declared path and OID: ${path}`);
      }
    }
  }
  return {
    id,
    entries,
    state: foldJournal(id, entries, contractHead(journal.oid)),
  };
}
