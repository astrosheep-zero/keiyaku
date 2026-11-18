import { createHash } from "node:crypto";
import { AuthorityCorruptionError } from "../core/facts/errors.js";
import type { TreeUpdate } from "../core/facts/offer.js";
import { contractId, type ContractId } from "../core/facts/types.js";
import {
  GIT_REF,
  readBlob,
  readGitPaths,
  updateGitTree,
  updateRefsAtomically,
  writeBlob,
  writeStateCommit,
  type GitSnapshot,
} from "../git/repository.js";
import {
  confirmPrivateStatePublication,
  privateStatePublicationRetirementFailure,
  type PrivateStatePublicationSeat,
} from "../git/private-state-seat.js";
import { GitPlumbingError, type GitRepository } from "../git/process.js";
import {
  readBlobResults,
  withGitTargetedReadObservation,
  type GitDecodeChannel,
  type GitReadObservation,
  type GitTreeSelection,
} from "../git/read-observation.js";
import { canonicalDebtId, type DebtId } from "../debt/identity.js";
import { acquireDebtSettlementFence } from "./fence.js";

// The private persisted spelling predates the product rename. Keep its bytes
// and path stable so an existing held association still settles after upgrade.
const HOLDER_ROOT = "settlement/task-holders";
const HOLDER_PREFIX = `${HOLDER_ROOT}/`;
const HOLDER_SUFFIX = ".json";

export function debtHolderObservationSelection(): GitTreeSelection {
  return { subtrees: [HOLDER_ROOT] };
}

export type DebtHolder = Readonly<{
  version: 1;
  debtId: DebtId;
  contractId: ContractId;
  disposition: "held" | "released";
}>;

function storedIdentity(debtId: DebtId): string {
  return `task/${debtId.slice("debt/".length)}`;
}

function holderPath(debtId: DebtId): string {
  const digest = createHash("sha256").update(storedIdentity(debtId)).digest("hex");
  return `${HOLDER_PREFIX}${digest}${HOLDER_SUFFIX}`;
}

function canonicalBytes(holder: DebtHolder): Uint8Array {
  const { version, debtId, contractId, disposition } = holder;
  return Buffer.from(`${JSON.stringify({ version, taskId: storedIdentity(debtId), contractId, disposition })}\n`);
}

function corruption(message: string, cause?: unknown): never {
  throw new AuthorityCorruptionError(message, cause === undefined ? {} : { cause });
}

function decodeHolder(path: string, bytes: Uint8Array): DebtHolder {
  let value: unknown;
  try {
    const text = Buffer.from(bytes).toString("utf8");
    if (!text.endsWith("\n") || text.slice(0, -1).includes("\n"))
      corruption(`DebtHolder is not one canonical JSON line: ${path}`);
    value = JSON.parse(text);
  } catch (error) {
    if (error instanceof AuthorityCorruptionError) throw error;
    return corruption(`invalid DebtHolder JSON: ${path}`, error);
  }
  if (typeof value !== "object" || value === null || Array.isArray(value))
    corruption(`DebtHolder must be an object: ${path}`);
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  if (keys.length !== 4 || keys.some((key) => !["version", "taskId", "contractId", "disposition"].includes(key))) {
    corruption(`DebtHolder has invalid fields: ${path}`);
  }
  if (record.version !== 1) corruption(`DebtHolder version must be 1: ${path}`);
  if (typeof record.taskId !== "string" || !record.taskId.startsWith("task/"))
    corruption(`DebtHolder identity is invalid: ${path}`);
  if (typeof record.contractId !== "string") corruption(`DebtHolder contractId is invalid: ${path}`);
  let debtId: DebtId;
  let owner: ContractId;
  try {
    debtId = `debt/${record.taskId.slice("task/".length)}`;
    canonicalDebtId(debtId);
    owner = contractId(record.contractId);
  } catch (error) {
    return corruption(`DebtHolder identity is invalid: ${path}`, error);
  }
  if (record.disposition !== "held" && record.disposition !== "released") {
    corruption(`DebtHolder disposition is invalid: ${path}`);
  }
  const holder: DebtHolder = { version: 1, debtId, contractId: owner, disposition: record.disposition };
  if (holderPath(debtId) !== path) corruption(`DebtHolder path does not match debtId: ${path}`);
  if (!Buffer.from(canonicalBytes(holder)).equals(Buffer.from(bytes)))
    corruption(`DebtHolder bytes are not canonical: ${path}`);
  return holder;
}

export type DebtHolderProjection = ReadonlyMap<ContractId, DebtHolder>;

export async function readDebtHolderProjectionAt(
  observation: Pick<GitReadObservation, "snapshot" | "readBlobs">,
): Promise<DebtHolderProjection> {
  const projection = new Map<ContractId, DebtHolder>();
  for (const holder of await readDebtHoldersAt(observation.snapshot, observation.readBlobs)) {
    if (projection.has(holder.contractId)) {
      corruption(`Contract has multiple current DebtHolders: ${holder.contractId}`);
    }
    projection.set(holder.contractId, holder);
  }
  return projection;
}

function update(holder: DebtHolder): TreeUpdate {
  return { path: holderPath(holder.debtId), bytes: canonicalBytes(holder) };
}

export function claimDebtHolder(debtId: DebtId, owner: ContractId): TreeUpdate {
  return update({ version: 1, debtId, contractId: owner, disposition: "held" });
}

type AdmissionOutcome = Readonly<{ kind: string }>;

type DebtHolderAdmission<T extends AdmissionOutcome> =
  | Readonly<{ kind: "completed"; result: T }>
  | Readonly<{
      kind: "accepted-release-failed";
      result: T;
      debtId: DebtId;
      diagnostic: string;
    }>;

function detail(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function admitWithDebtHolderFence<T extends AdmissionOutcome>(
  repository: GitRepository,
  debtId: DebtId,
  action: () => T | Promise<T>,
): Promise<DebtHolderAdmission<T>> {
  const held = await acquireDebtSettlementFence(repository, debtId);
  let outcome: { result: T } | { error: unknown };
  try {
    outcome = { result: await action() };
  } catch (error) {
    outcome = { error };
  }
  try {
    held.close();
  } catch (retirement) {
    if ("error" in outcome) {
      throw privateStatePublicationRetirementFailure(outcome.error, retirement, "Debt holder fence", repository.signal);
    }
    if (outcome.result.kind !== "accepted") throw retirement;
    return { kind: "accepted-release-failed", result: outcome.result, debtId, diagnostic: detail(retirement) };
  }
  if ("error" in outcome) throw outcome.error;
  return { kind: "completed", result: outcome.result };
}

export async function releaseDebtHolder(
  channel: GitDecodeChannel,
  epoch: GitSnapshot,
  owner: ContractId,
): Promise<TreeUpdate | null> {
  const projection = await readDebtHolderProjectionAt({
    snapshot: epoch,
    readBlobs: (oids) => readBlobResults(channel, oids),
  });
  const holder = projection.get(owner);
  return holder?.disposition === "held" ? update({ ...holder, disposition: "released" }) : null;
}

export function observeDebtHolder(repository: GitRepository, channel: GitDecodeChannel, owner: ContractId) {
  return withGitTargetedReadObservation(repository, channel, debtHolderObservationSelection(), async (observation) => ({
    snapshot: observation.snapshot,
    holder: (await readDebtHolderProjectionAt(observation)).get(owner),
  }));
}

async function confirmRecoveredRelease(
  repository: GitRepository,
  release: TreeUpdate,
  seat: PrivateStatePublicationSeat,
): Promise<string | undefined> {
  const recovery = { ...repository, signal: AbortSignal.timeout(5_000) };
  try {
    const entry = (await readGitPaths(recovery, [release.path])).paths.get(release.path);
    if (entry !== undefined) {
      if (entry.type !== "blob") corruption(`DebtHolder path is not a blob: ${release.path}`);
      const bytes = await readBlob(recovery, entry.oid);
      decodeHolder(release.path, bytes);
      if (entry.mode === "100644" && bytes.equals(release.bytes)) {
        confirmPrivateStatePublication(seat);
        return undefined;
      }
    }
  } catch (error) {
    if (!(error instanceof GitPlumbingError)) throw error;
    return error.status === null ? error.message : `${error.message.trimEnd()} (exit ${error.status})`;
  }
  return "Debt holder release publication state is unknown";
}

/** Publish exactly the held association proved in this seat's frozen epoch. */
export async function publishDebtHolderRelease(
  repository: GitRepository,
  snapshot: GitSnapshot,
  holder: DebtHolder,
  seat: PrivateStatePublicationSeat,
): Promise<string | undefined> {
  const release = update({ ...holder, disposition: "released" });
  const oid = await writeBlob(repository, release.bytes);
  const tree = await updateGitTree(repository, snapshot.tree, new Map([[release.path, { oid }]]));
  const commit = await writeStateCommit({
    repository,
    tree,
    parent: snapshot.commit,
    message: `release held Debt completion: ${holder.contractId}`,
  });
  const publication = await updateRefsAtomically(repository, [
    { ref: GIT_REF, newOid: commit, expectedOid: snapshot.commit },
  ]);
  if (publication.kind === "non-published") return detail(publication.error);
  if (publication.kind === "unknown") return confirmRecoveredRelease(repository, release, seat);
  confirmPrivateStatePublication(seat);
  return undefined;
}

export async function releaseDebtHolderWithFence<T extends AdmissionOutcome>(
  repository: GitRepository,
  channel: GitDecodeChannel,
  owner: ContractId,
  action: () => T | Promise<T>,
): Promise<DebtHolderAdmission<T>> {
  const { holder } = await observeDebtHolder(repository, channel, owner);
  return holder?.disposition === "held"
    ? admitWithDebtHolderFence(repository, holder.debtId, action)
    : { kind: "completed", result: await action() };
}

export async function readDebtHoldersAt(
  epoch: GitSnapshot,
  readBlobs: GitReadObservation["readBlobs"],
): Promise<readonly DebtHolder[]> {
  const entries = [...epoch.paths].filter(([path, entry]) => path.startsWith(HOLDER_PREFIX) && entry.type === "blob");
  const blobs = await readBlobs(entries.map(([, entry]) => entry.oid));
  const holders: DebtHolder[] = [];
  const seen = new Set<DebtId>();
  for (const [path, entry] of epoch.paths) {
    if (path === HOLDER_ROOT) {
      if (entry.type !== "tree") corruption(`DebtHolder authority root is not a tree: ${path}`);
      continue;
    }
    if (!path.startsWith(HOLDER_PREFIX)) continue;
    if (!path.endsWith(HOLDER_SUFFIX)) corruption(`unexpected DebtHolder authority path: ${path}`);
    if (entry.type !== "blob") corruption(`DebtHolder path is not a blob: ${path}`);
    const result = blobs.get(entry.oid);
    if (result?.kind !== "present") corruption(`missing DebtHolder Git object: ${path}`);
    const holder = decodeHolder(path, result.bytes);
    if (seen.has(holder.debtId)) corruption(`duplicate DebtHolder identity: ${holder.debtId}`);
    seen.add(holder.debtId);
    holders.push(holder);
  }
  return holders.sort((left, right) => Buffer.compare(Buffer.from(left.debtId), Buffer.from(right.debtId)));
}
