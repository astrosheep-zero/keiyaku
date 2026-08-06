import { decodeJournal } from "../core/facts/codec.js";
import { foldJournal } from "../core/facts/fold.js";
import {
  type ContractId,
  type SnapshotId,
} from "../core/facts/types.js";
import type { ContractObservation, ContractsObservation } from "../core/facts/observation.js";
import { contractJournalPath, mintContractHead, mintSnapshotId } from "./identity.js";
import { readBlob, readBlobs, readCarrier, runGit, type CarrierSnapshot, type GitRepository } from "./repository.js";

export type { ContractObservation, ContractsObservation } from "../core/facts/observation.js";

export type BindCoordinatesObservation = Readonly<{ start: SnapshotId; target?: string }>;

export type BindCoordinatesObservationErrorCode =
  | "explicit-target-missing"
  | "malformed-structured-output";

/** A bind-edge refusal caused by a structured Git coordinate observation. */
export class BindCoordinatesObservationError extends TypeError {
  readonly code: BindCoordinatesObservationErrorCode;

  constructor(code: BindCoordinatesObservationErrorCode, message: string) {
    super(message);
    this.name = "BindCoordinatesObservationError";
    this.code = code;
  }
}

const TARGET_COORDINATES_FORMAT = "%(refname)%00%(objectname)%00";

function malformedBindCoordinatesOutput(): never {
  throw new BindCoordinatesObservationError(
    "malformed-structured-output",
    "malformed structured Git output while observing bind coordinates",
  );
}

function structuredFields(output: Buffer, fieldCount: number): readonly string[] {
  const fields = output.toString("utf8").split("\0");
  if (fields.length !== fieldCount + 1 || fields.at(-1) !== "\n") malformedBindCoordinatesOutput();
  return fields.slice(0, -1);
}

/** Observe bind's tender start and optional reward target without creating persistent state. */
export function observeBindCoordinates(
  repository: GitRepository,
  requestedTarget?: string,
): BindCoordinatesObservation {
  if (requestedTarget === undefined) {
    try {
      return { start: mintSnapshotId(runGit(repository, ["rev-parse", "--verify", "HEAD"]).toString("utf8").trim()) };
    } catch {
      malformedBindCoordinatesOutput();
    }
  }

  const output = runGit(repository, [
    "for-each-ref",
    `--format=${TARGET_COORDINATES_FORMAT}`,
    "--",
    requestedTarget,
  ]);
  if (output.length === 0) {
    throw new BindCoordinatesObservationError(
      "explicit-target-missing",
      `bind target does not exist: ${requestedTarget}`,
    );
  }
  const [target, start] = structuredFields(output, 2);
  if (target !== requestedTarget || start === undefined) malformedBindCoordinatesOutput();
  try {
    return { target, start: mintSnapshotId(start) };
  } catch {
    malformedBindCoordinatesOutput();
  }
}

type DecodedJournal = Readonly<{
  id: ContractId;
  entries: ReturnType<typeof decodeJournal>;
  oid: string;
}>;

function decodeCarrierJournal(
  repository: GitRepository,
  path: string,
  carrier: CarrierSnapshot,
  expectedId?: ContractId,
  blobs?: ReadonlyMap<string, Buffer>,
): DecodedJournal {
  const journal = carrier.paths.get(path);
  if (journal === undefined) throw new TypeError(`missing carrier journal: ${path}`);
  if (journal.type !== "blob") throw new TypeError(`journal path is not a blob: ${path}`);

  const bytes = blobs?.get(journal.oid) ?? readBlob(repository, journal.oid);
  const entries = decodeJournal(bytes.toString("utf8"));
  const first = entries[0];
  if (
    first === undefined
    || (expectedId !== undefined && first.contract !== expectedId)
    || entries.some((entry) => entry.contract !== (expectedId ?? first.contract))
  ) {
    if (expectedId !== undefined) {
      throw new TypeError(`journal content does not canonically identify ${expectedId}: ${path}`);
    }
    throw new TypeError(`journal content does not canonically identify ${path}`);
  }
  const id = first.contract;
  if (contractJournalPath(id) !== path) {
    throw new TypeError(`journal path does not match canonical contract identity: ${path}`);
  }
  return { id, entries, oid: journal.oid };
}

function observeDecodedJournal(id: ContractId, decoded: DecodedJournal): ContractObservation {
  return {
    id,
    entries: decoded.entries,
    state: foldJournal(id, decoded.entries, mintContractHead(decoded.oid)),
  };
}

function observeFromCarrier(
  repository: GitRepository,
  carrier: CarrierSnapshot,
  id: ContractId,
  blobs?: ReadonlyMap<string, Buffer>,
): ContractObservation {
  const path = contractJournalPath(id);
  const journal = carrier.paths.get(path);
  if (journal === undefined) return { id, entries: [], state: null };
  const decoded = decodeCarrierJournal(repository, path, carrier, id, blobs);
  if (decoded.id !== id) throw new TypeError(`journal content does not canonically identify ${id}: ${path}`);
  return observeDecodedJournal(id, decoded);
}

function enumerateContractObservations(
  repository: GitRepository,
  carrier: CarrierSnapshot,
  blobs?: ReadonlyMap<string, Buffer>,
): ReadonlyMap<ContractId, ContractObservation> {
  const observations = new Map<ContractId, ContractObservation>();
  const seen = new Set<ContractId>();
  for (const [path] of carrier.paths) {
    if (!path.startsWith("contracts/") || !path.endsWith(".jsonl")) continue;
    const decoded = decodeCarrierJournal(repository, path, carrier, undefined, blobs);
    const id = decoded.id;
    if (seen.has(id)) throw new TypeError(`duplicate contract journal identity: ${id}`);
    seen.add(id);
    observations.set(id, observeDecodedJournal(id, decoded));
  }
  return observations;
}

/** Read one immutable carrier snapshot, enumerate its journals, and include requested absence. */
export function observeCarrier(
  repository: GitRepository,
  requested: readonly ContractId[] = [],
): ContractsObservation {
  const carrier = readCarrier(repository);
  const blobs = readBlobs(repository, [...carrier.paths]
    .filter(([path, entry]) => path.startsWith("contracts/") && path.endsWith(".jsonl") && entry.type === "blob")
    .map(([, entry]) => entry.oid));
  const contracts = new Map(enumerateContractObservations(repository, carrier, blobs));
  const seen = new Set(contracts.keys());
  const ids = [...seen];
  for (const id of requested) {
    if (!seen.has(id)) {
      seen.add(id);
      ids.push(id);
    }
  }
  for (const id of ids) {
    if (!contracts.has(id)) contracts.set(id, observeFromCarrier(repository, carrier, id));
  }
  return {
    carrierSnapshot: carrier.commit === null ? null : mintSnapshotId(carrier.commit),
    contracts,
  };
}

/** Read one carrier tree and fold all requested contracts from that immutable snapshot. */
export function observeContracts(
  repository: GitRepository,
  ids: readonly ContractId[],
): ContractsObservation {
  const carrier = readCarrier(repository);
  const contracts = new Map<ContractId, ContractObservation>();
  const paths = ids.map((id) => contractJournalPath(id));
  const blobs = readBlobs(repository, paths.flatMap((path) => {
    const journal = carrier.paths.get(path);
    return journal?.type === "blob" ? [journal.oid] : [];
  }));
  for (const id of ids) {
    if (!contracts.has(id)) contracts.set(id, observeFromCarrier(repository, carrier, id, blobs));
  }
  return {
    carrierSnapshot: carrier.commit === null ? null : mintSnapshotId(carrier.commit),
    contracts,
  };
}

export function observeContract(repository: GitRepository, id: ContractId): ContractObservation {
  const observation = observeContracts(repository, [id]).contracts.get(id);
  if (observation === undefined) throw new Error(`missing requested contract observation: ${id}`);
  return observation;
}
