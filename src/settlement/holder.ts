import { createHash } from "node:crypto";
import { AuthorityCorruptionError } from "../core/facts/errors.js";
import type { TreeUpdate } from "../core/facts/offer.js";
import { contractId, type ContractId } from "../core/facts/types.js";
import {
  expandGitSnapshot,
  readBlob,
  readGit,
  type GitRepository,
  type GitSnapshot,
} from "../git/repository.js";
import { parseTaskId, type TaskId } from "../task/identity.js";

const HOLDER_ROOT = "settlement/task-holders";
const HOLDER_PREFIX = `${HOLDER_ROOT}/`;
const HOLDER_SUFFIX = ".json";

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

function holderEntries(
  repository: GitRepository,
  snapshot: GitSnapshot,
  scope: "complete" | "targeted",
): readonly TaskHolder[] {
  const expanded = scope === "complete" ? snapshot : expandGitSnapshot(repository, snapshot);
  const holders: TaskHolder[] = [];
  const seen = new Set<TaskId>();
  for (const [path, entry] of expanded.paths) {
    if (path === HOLDER_ROOT) corruption(`TaskHolder authority root is not a tree: ${path}`);
    if (!path.startsWith(HOLDER_PREFIX)) continue;
    if (!path.endsWith(HOLDER_SUFFIX)) corruption(`unexpected TaskHolder authority path: ${path}`);
    if (entry.type !== "blob") corruption(`TaskHolder path is not a blob: ${path}`);
    const holder = decodeHolder(path, readBlob(repository, entry.oid));
    if (seen.has(holder.taskId)) corruption(`duplicate TaskHolder identity: ${holder.taskId}`);
    seen.add(holder.taskId);
    holders.push(holder);
  }
  return holders.sort((left, right) => Buffer.compare(Buffer.from(left.taskId), Buffer.from(right.taskId)));
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

export function releaseTaskHolder(
  repository: GitRepository,
  snapshot: GitSnapshot,
  owner: ContractId,
): TreeUpdate | null {
  const current = projectTaskHolders(holderEntries(repository, snapshot, "targeted")).get(owner) ?? null;
  return current === null || current.disposition !== "held"
    ? null
    : update({ ...current, disposition: "released" });
}

export function readTaskHolders(repository: GitRepository): readonly TaskHolder[] {
  return holderEntries(repository, readGit(repository), "complete");
}

export function readTaskHolderProjection(repository: GitRepository): TaskHolderProjection {
  return projectTaskHolders(readTaskHolders(repository));
}
