import { createHash } from "node:crypto";
import { AuthorityCorruptionError } from "../core/facts/errors.js";
import type { TreeUpdate } from "../core/facts/offer.js";
import { contractId, type ContractId } from "../core/facts/types.js";
import type { GitDecisionObservation } from "../git/observe.js";
import {
  GIT_REF,
  updateGitTree,
  updateRefsAtomically,
  writeBlob,
  writeCommit,
} from "../git/repository.js";
import type { GitRepository } from "../git/process.js";
import {
  withGitTargetedReadObservation,
  type GitDecodeChannel,
  type GitReadObservation,
  type GitTreeSelection,
} from "../git/read-observation.js";
import { parseTaskId, type TaskId } from "../task/identity.js";
import { acquireTaskSettlementFence } from "./fence.js";

const HOLDER_ROOT = "settlement/task-holders";
const HOLDER_PREFIX = `${HOLDER_ROOT}/`;
const HOLDER_SUFFIX = ".json";

export function taskHolderObservationSelection(): GitTreeSelection {
  return { subtrees: [HOLDER_ROOT] };
}

export type TaskHolder = Readonly<{
  version: 1;
  taskId: TaskId;
  contractId: ContractId;
  disposition: "held" | "released";
}>;

function holderPath(taskId: TaskId): string {
  const digest = createHash("sha256").update(taskId).digest("hex");
  return `${HOLDER_PREFIX}${digest}${HOLDER_SUFFIX}`;
}

function canonicalBytes(holder: TaskHolder): Uint8Array {
  return Buffer.from(`${JSON.stringify(holder)}\n`);
}

function corruption(message: string, cause?: unknown): never {
  throw new AuthorityCorruptionError(message, cause === undefined ? {} : { cause });
}

function decodeHolder(path: string, bytes: Uint8Array): TaskHolder {
  let value: unknown;
  try {
    const text = Buffer.from(bytes).toString("utf8");
    if (!text.endsWith("\n") || text.slice(0, -1).includes("\n")) corruption(`TaskHolder is not one canonical JSON line: ${path}`);
    value = JSON.parse(text);
  } catch (error) {
    if (error instanceof AuthorityCorruptionError) throw error;
    return corruption(`invalid TaskHolder JSON: ${path}`, error);
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) corruption(`TaskHolder must be an object: ${path}`);
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  if (keys.length !== 4 || keys.some((key) => !["version", "taskId", "contractId", "disposition"].includes(key))) {
    corruption(`TaskHolder has invalid fields: ${path}`);
  }
  if (record.version !== 1) corruption(`TaskHolder version must be 1: ${path}`);
  if (typeof record.taskId !== "string") corruption(`TaskHolder taskId is invalid: ${path}`);
  if (typeof record.contractId !== "string") corruption(`TaskHolder contractId is invalid: ${path}`);
  let taskId: TaskId;
  let owner: ContractId;
  try {
    parseTaskId(record.taskId);
    taskId = record.taskId as TaskId;
    owner = contractId(record.contractId);
  } catch (error) {
    return corruption(`TaskHolder identity is invalid: ${path}`, error);
  }
  if (record.disposition !== "held" && record.disposition !== "released") {
    corruption(`TaskHolder disposition is invalid: ${path}`);
  }
  const holder: TaskHolder = { version: 1, taskId, contractId: owner, disposition: record.disposition };
  if (holderPath(taskId) !== path) corruption(`TaskHolder path does not match taskId: ${path}`);
  if (!Buffer.from(canonicalBytes(holder)).equals(Buffer.from(bytes))) corruption(`TaskHolder bytes are not canonical: ${path}`);
  return holder;
}

export type TaskHolderProjection = ReadonlyMap<ContractId, TaskHolder>;

function projectTaskHolders(holders: readonly TaskHolder[]): TaskHolderProjection {
  const projection = new Map<ContractId, TaskHolder>();
  for (const holder of holders) {
    if (projection.has(holder.contractId)) {
      corruption(`Contract has multiple current TaskHolders: ${holder.contractId}`);
    }
    projection.set(holder.contractId, holder);
  }
  return projection;
}

function update(holder: TaskHolder): TreeUpdate {
  return { path: holderPath(holder.taskId), bytes: canonicalBytes(holder) };
}

export function claimTaskHolder(taskId: TaskId, owner: ContractId): TreeUpdate {
  return update({ version: 1, taskId, contractId: owner, disposition: "held" });
}

type AdmissionOutcome = Readonly<{ kind: string }>;

export type TaskHolderAdmission<T extends AdmissionOutcome> =
  | Readonly<{ kind: "completed"; result: T }>
  | Readonly<{
      kind: "accepted-release-failed";
      result: T;
      taskId: TaskId;
      diagnostic: string;
    }>;

function detail(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function finishTaskHolderAdmission<T extends AdmissionOutcome>(
  taskId: TaskId,
  result: T,
  close: () => void,
): TaskHolderAdmission<T> {
  try {
    close();
    return { kind: "completed", result };
  } catch (error) {
    if (result.kind !== "accepted") throw error;
    return { kind: "accepted-release-failed", result, taskId, diagnostic: detail(error) };
  }
}

async function admitWithTaskHolderFence<T extends AdmissionOutcome>(
  repository: GitRepository,
  taskId: TaskId,
  action: () => T | Promise<T>,
): Promise<TaskHolderAdmission<T>> {
  const held = await acquireTaskSettlementFence(repository, taskId);
  let result: T;
  try {
    result = await action();
  } catch (error) {
    try { held.close(); } catch { /* The operation failure remains decisive before admission. */ }
    throw error;
  }
  return finishTaskHolderAdmission(taskId, result, () => held.close());
}

export function claimTaskHolderWithFence<T extends AdmissionOutcome>(
  repository: GitRepository,
  taskId: TaskId,
  action: () => T | Promise<T>,
): Promise<TaskHolderAdmission<T>> {
  return admitWithTaskHolderFence(repository, taskId, action);
}

export async function releaseTaskHolder(
  channel: GitDecodeChannel,
  observation: GitDecisionObservation,
  owner: ContractId,
): Promise<TreeUpdate | null> {
  const current = (await readTaskHolderProjectionFromDecision(channel, observation)).get(owner) ?? null;
  return current === null || current.disposition !== "held"
    ? null
    : update({ ...current, disposition: "released" });
}

export type TaskHolderReleasePublication =
  | Readonly<{ kind: "released" }>
  | Readonly<{ kind: "not-held" }>
  | Readonly<{ kind: "non-published"; diagnostic: string }>;

/** Publish the released holder against the same frozen observation that decided the release. */
export async function publishTaskHolderRelease(
  repository: GitRepository,
  channel: GitDecodeChannel,
  observation: GitDecisionObservation,
  owner: ContractId,
): Promise<TaskHolderReleasePublication> {
  const release = await releaseTaskHolder(channel, observation, owner);
  if (release === null) return { kind: "not-held" };
  const tree = await updateGitTree(repository, observation.admission.snapshot.tree, new Map([[release.path, { oid: await writeBlob(repository, release.bytes) }]]));
  const commit = await writeCommit({
    repository,
    tree,
    parent: observation.admission.snapshot.commit,
    message: `release held Task completion: ${owner}`,
  });
  const publication = await updateRefsAtomically(repository, [{
    ref: GIT_REF,
    newOid: commit,
    expectedOid: observation.admission.snapshot.commit,
  }]);
  if (publication.kind === "published") return { kind: "released" };
  return {
    kind: "non-published",
    diagnostic: publication.kind === "non-published" ? detail(publication.error) : "Task holder release publication state is unknown",
  };
}

export async function readTaskHolderProjectionFromDecision(
  channel: GitDecodeChannel,
  observation: GitDecisionObservation,
): Promise<TaskHolderProjection> {
  const read = {
    snapshot: observation.admission.snapshot,
    readBlobs: async (oids: readonly string[]) => {
      const objects = await channel.readObjects(oids);
      const blobs = new Map();
      for (const [oid, object] of objects) {
        if (object.kind === "missing") blobs.set(oid, object);
        else {
          if (object.type !== "blob") corruption(`TaskHolder Git object is not a blob: ${oid}`);
          blobs.set(oid, { kind: "present", bytes: object.bytes });
        }
      }
      return blobs;
    },
  } satisfies Pick<GitReadObservation, "snapshot" | "readBlobs">;
  return projectTaskHolders(await readTaskHoldersAt(read));
}

export function observeTaskHolderProjection(
  repository: GitRepository,
  channel: GitDecodeChannel,
): Promise<TaskHolderProjection> {
  return withGitTargetedReadObservation(
    repository,
    channel,
    taskHolderObservationSelection(),
    readTaskHolderProjectionAt,
  );
}

async function heldTaskForContract(repository: GitRepository, channel: GitDecodeChannel, owner: ContractId): Promise<TaskId | null> {
  const holder = (await observeTaskHolderProjection(repository, channel)).get(owner) ?? null;
  return holder?.disposition === "held" ? holder.taskId : null;
}

export async function releaseTaskHolderWithFence<T extends AdmissionOutcome>(
  repository: GitRepository,
  channel: GitDecodeChannel,
  owner: ContractId,
  action: () => T | Promise<T>,
): Promise<TaskHolderAdmission<T>> {
  const taskId = await heldTaskForContract(repository, channel, owner);
  return taskId === null
    ? { kind: "completed", result: await action() }
    : admitWithTaskHolderFence(repository, taskId, action);
}

export async function readTaskHoldersAt(
  observation: Pick<GitReadObservation, "snapshot" | "readBlobs">,
): Promise<readonly TaskHolder[]> {
  const entries = [...observation.snapshot.paths]
    .filter(([path, entry]) => path.startsWith(HOLDER_PREFIX) && entry.type === "blob");
  const blobs = await observation.readBlobs(entries.map(([, entry]) => entry.oid));
  const holders: TaskHolder[] = [];
  const seen = new Set<TaskId>();
  for (const [path, entry] of observation.snapshot.paths) {
    if (path === HOLDER_ROOT) {
      if (entry.type !== "tree") corruption(`TaskHolder authority root is not a tree: ${path}`);
      continue;
    }
    if (!path.startsWith(HOLDER_PREFIX)) continue;
    if (!path.endsWith(HOLDER_SUFFIX)) corruption(`unexpected TaskHolder authority path: ${path}`);
    if (entry.type !== "blob") corruption(`TaskHolder path is not a blob: ${path}`);
    const result = blobs.get(entry.oid);
    if (result?.kind !== "present") corruption(`missing TaskHolder Git object: ${path}`);
    const holder = decodeHolder(path, result.bytes);
    if (seen.has(holder.taskId)) corruption(`duplicate TaskHolder identity: ${holder.taskId}`);
    seen.add(holder.taskId);
    holders.push(holder);
  }
  return holders.sort((left, right) => Buffer.compare(Buffer.from(left.taskId), Buffer.from(right.taskId)));
}

export async function readTaskHolderProjectionAt(observation: GitReadObservation): Promise<TaskHolderProjection> {
  return projectTaskHolders(await readTaskHoldersAt(observation));
}
