import { decodeJournal } from "../facts/codec.js";
import { foldJournal } from "../facts/fold.js";
import {
  commitOid,
  contractHead,
  contractJournalPath,
  evidencePath,
  type CommitOid,
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

export type ContractsObservation = Readonly<{
  carrierCommit: CommitOid | null;
  contracts: ReadonlyMap<ContractId, ContractObservation>;
}>;

function observeFromCarrier(repository: GitRepository, carrier: ReturnType<typeof readCarrier>, id: ContractId): ContractObservation {
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

/** Read one carrier tree and fold all requested contracts from that immutable snapshot. */
export function observeContracts(
  repository: GitRepository,
  ids: readonly ContractId[],
): ContractsObservation {
  const carrier = readCarrier(repository);
  const contracts = new Map<ContractId, ContractObservation>();
  for (const id of ids) {
    if (!contracts.has(id)) contracts.set(id, observeFromCarrier(repository, carrier, id));
  }
  return {
    carrierCommit: carrier.commit === null ? null : commitOid(carrier.commit),
    contracts,
  };
}

export function observeContract(repository: GitRepository, id: ContractId): ContractObservation {
  const observation = observeContracts(repository, [id]).contracts.get(id);
  if (observation === undefined) throw new Error(`missing requested contract observation: ${id}`);
  return observation;
}
