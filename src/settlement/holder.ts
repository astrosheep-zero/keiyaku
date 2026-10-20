import { createHash } from "node:crypto";
import { AuthorityCorruptionError } from "../core/facts/errors.js";
import type { TreeUpdate } from "../core/facts/offer.js";
import { contractId, type ContractId } from "../core/facts/types.js";
import type { GitDecisionObservation } from "../git/observe.js";
import { GIT_REF, updateGitTree, updateRefsAtomically, writeBlob, writeStateCommit } from "../git/repository.js";
import { confirmPrivateStatePublication, type PrivateStatePublicationSeat } from "../git/private-state-seat.js";
import type { GitRepository } from "../git/process.js";
import {
  withGitTargetedReadObservation,
  type GitDecodeChannel,
  type GitReadObservation,
  type GitTreeSelection,
} from "../git/read-observation.js";
import { parseDebtId, type DebtId } from "../debt/identity.js";
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
    parseDebtId(debtId);
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

function projectDebtHolders(holders: readonly DebtHolder[]): DebtHolderProjection {
  const projection = new Map<ContractId, DebtHolder>();
  for (const holder of holders) {
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

function finishDebtHolderAdmission<T extends AdmissionOutcome>(
  debtId: DebtId,
  result: T,
  close: () => void,
): DebtHolderAdmission<T> {
  try {
    close();
    return { kind: "completed", result };
  } catch (error) {
    if (result.kind !== "accepted") throw error;
    return { kind: "accepted-release-failed", result, debtId, diagnostic: detail(error) };
  }
}

export async function admitWithDebtHolderFence<T extends AdmissionOutcome>(
  repository: GitRepository,
  debtId: DebtId,
  action: () => T | Promise<T>,
): Promise<DebtHolderAdmission<T>> {
  const held = await acquireDebtSettlementFence(repository, debtId);
  let result: T;
  try {
    result = await action();
  } catch (error) {
    try {
      held.close();
    } catch {
      /* The operation failure remains decisive before admission. */
    }
    throw error;
  }
  return finishDebtHolderAdmission(debtId, result, () => held.close());
}

export async function releaseDebtHolder(
  channel: GitDecodeChannel,
  observation: GitDecisionObservation,
  owner: ContractId,
): Promise<TreeUpdate | null> {
  const current = (await readDebtHolderProjectionFromDecision(channel, observation)).get(owner) ?? null;
  return current === null || current.disposition !== "held" ? null : update({ ...current, disposition: "released" });
}

type DebtHolderReleasePublication =
  | Readonly<{ kind: "released" }>
  | Readonly<{ kind: "not-held" }>
  | Readonly<{ kind: "non-published"; diagnostic: string }>;

async function releasedHolderIsCurrent(
  repository: GitRepository,
  channel: GitDecodeChannel,
  owner: ContractId,
  expected: Uint8Array,
): Promise<boolean> {
  const current = (await observeDebtHolderProjection(repository, channel)).get(owner) ?? null;
  return current?.disposition === "released" && Buffer.from(canonicalBytes(current)).equals(expected);
}

/** Publish the released holder against the same frozen observation that decided the release. */
export async function publishDebtHolderRelease(
  repository: GitRepository,
  channel: GitDecodeChannel,
  observation: GitDecisionObservation,
  owner: ContractId,
  seat: PrivateStatePublicationSeat,
): Promise<DebtHolderReleasePublication> {
  const release = await releaseDebtHolder(channel, observation, owner);
  if (release === null) return { kind: "not-held" };
  const tree = await updateGitTree(
    repository,
    observation.admission.snapshot.tree,
    new Map([[release.path, { oid: await writeBlob(repository, release.bytes) }]]),
  );
  const commit = await writeStateCommit({
    repository,
    tree,
    parent: observation.admission.snapshot.commit,
    message: `release held Debt completion: ${owner}`,
  });
  const publication = await updateRefsAtomically(repository, [
    {
      ref: GIT_REF,
      newOid: commit,
      expectedOid: observation.admission.snapshot.commit,
    },
  ]);
  if (publication.kind === "published") {
    confirmPrivateStatePublication(seat);
    return { kind: "released" };
  }
  if (publication.kind === "unknown" && (await releasedHolderIsCurrent(repository, channel, owner, release.bytes))) {
    confirmPrivateStatePublication(seat);
    return { kind: "released" };
  }
  return {
    kind: "non-published",
    diagnostic:
      publication.kind === "non-published"
        ? detail(publication.error)
        : "Debt holder release publication state is unknown",
  };
}

export async function readDebtHolderProjectionFromDecision(
  channel: GitDecodeChannel,
  observation: GitDecisionObservation,
): Promise<DebtHolderProjection> {
  const read = {
    snapshot: observation.admission.snapshot,
    readBlobs: async (oids: readonly string[]) => {
      const objects = await channel.readObjects(oids);
      const blobs = new Map();
      for (const [oid, object] of objects) {
        if (object.kind === "missing") blobs.set(oid, object);
        else {
          if (object.type !== "blob") corruption(`DebtHolder Git object is not a blob: ${oid}`);
          blobs.set(oid, { kind: "present", bytes: object.bytes });
        }
      }
      return blobs;
    },
  } satisfies Pick<GitReadObservation, "snapshot" | "readBlobs">;
  return projectDebtHolders(await readDebtHoldersAt(read));
}

function observeDebtHolderProjection(
  repository: GitRepository,
  channel: GitDecodeChannel,
): Promise<DebtHolderProjection> {
  return withGitTargetedReadObservation(
    repository,
    channel,
    debtHolderObservationSelection(),
    readDebtHolderProjectionAt,
  );
}

async function heldDebtForContract(
  repository: GitRepository,
  channel: GitDecodeChannel,
  owner: ContractId,
): Promise<DebtId | null> {
  const holder = (await observeDebtHolderProjection(repository, channel)).get(owner) ?? null;
  return holder?.disposition === "held" ? holder.debtId : null;
}

export async function releaseDebtHolderWithFence<T extends AdmissionOutcome>(
  repository: GitRepository,
  channel: GitDecodeChannel,
  owner: ContractId,
  action: () => T | Promise<T>,
): Promise<DebtHolderAdmission<T>> {
  const debtId = await heldDebtForContract(repository, channel, owner);
  return debtId === null
    ? { kind: "completed", result: await action() }
    : admitWithDebtHolderFence(repository, debtId, action);
}

export async function readDebtHoldersAt(
  observation: Pick<GitReadObservation, "snapshot" | "readBlobs">,
): Promise<readonly DebtHolder[]> {
  const entries = [...observation.snapshot.paths].filter(
    ([path, entry]) => path.startsWith(HOLDER_PREFIX) && entry.type === "blob",
  );
  const blobs = await observation.readBlobs(entries.map(([, entry]) => entry.oid));
  const holders: DebtHolder[] = [];
  const seen = new Set<DebtId>();
  for (const [path, entry] of observation.snapshot.paths) {
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

export async function readDebtHolderProjectionAt(observation: GitReadObservation): Promise<DebtHolderProjection> {
  return projectDebtHolders(await readDebtHoldersAt(observation));
}
