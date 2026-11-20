import { z } from "zod";
import { randomUUID } from "node:crypto";
import { access, readFile, realpath, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { AuthorityCorruptionError } from "../core/facts/errors.js";
import type { ContractId, SnapshotId } from "../core/facts/types.js";
import { contractPhysicalName, gitObjectId, mintSnapshotId, snapshotIdSchema, type GitObjectId } from "./identity.js";
import { executeGit, GitPlumbingError, withPrivateGitIndex, type GitRepository } from "./process.js";
import {
  HANDOFF_RECEIPT_REF_NAMESPACE,
  readBlob,
  readRef,
  readRefs,
  worktreeGitDirectory,
  writeBlob,
  type GitRefUpdate,
} from "./repository.js";
import type { GitReadObservation } from "./read-observation.js";
import type { ContractWorkspaceLocation } from "../workspace-place.js";

const WORKTREE_DIRECTORY = [".keiyaku", "wt"] as const;

type WorkspaceChanges = Readonly<{
  staged: readonly string[];
  unstaged: readonly string[];
  untracked: readonly string[];
  submodules: readonly string[];
}>;

export type WorkspaceTree = Readonly<{
  tree: GitObjectId;
  head: SnapshotId;
  at: string;
  dirty: boolean;
  changes: WorkspaceChanges;
  unmergedPaths: readonly string[];
}>;

export function worktreePath(repository: GitRepository, place: string): string {
  return resolve(repository.primaryWorktree, ...WORKTREE_DIRECTORY, place);
}

/** Install the captured handoff base without overwriting live worktree bytes. */
export async function installConflictHandoffBase(
  repository: GitRepository,
  workspace: string,
  previous: SnapshotId,
  snapshot: SnapshotId,
): Promise<void> {
  await executeGit(repository, ["-C", workspace, "update-ref", "--no-deref", "HEAD", snapshot, previous]);
  await executeGit(repository, ["-C", workspace, "read-tree", snapshot]);
}

type DependentWorktreeFollow =
  | Readonly<{ kind: "followed"; before: SnapshotId; after: SnapshotId }>
  | Readonly<{ kind: "unchanged" }>
  | Readonly<{
      kind: "retained";
      head: SnapshotId;
      reason: "head-moved" | "head-attached" | "operation-in-progress";
      paths: readonly string[];
    }>;

async function workspaceRevision(
  repository: GitRepository,
  workspace: string,
  revision: string,
): Promise<SnapshotId | null> {
  try {
    const value = (await executeGit(repository, ["-C", workspace, "rev-parse", "--verify", "--quiet", revision]))
      .toString("utf8")
      .trim();
    return value.length === 0 ? null : mintSnapshotId(value);
  } catch (error) {
    if (error instanceof GitPlumbingError && error.status === 1) return null;
    throw error;
  }
}

/** Read the appointed linked index, not a containing checkout or a proposed merge. */
export async function workspaceHasUnmergedPaths(repository: GitRepository, workspace: string): Promise<boolean> {
  const admin = await worktreeGitDirectory(repository, workspace);
  if (dirname(admin) !== join(repository.commonDirectory, "worktrees") || (await realpath(workspace)) !== workspace)
    throw new Error(`Cannot prove linked Git worktree at ${workspace}`);
  const reverse = (await readFile(join(admin, "gitdir"), "utf8")).trim();
  if ((await realpath(resolve(admin, reverse))) !== join(workspace, ".git"))
    throw new Error(`Cannot prove linked Git worktree at ${workspace}`);
  // Git reads a missing index as an empty one; that does not prove absence of conflicts.
  const index = join(admin, "index");
  if (!(await stat(index)).isFile()) throw new Error(`Cannot read linked Git index at ${index}`);
  const unmerged = await executeGit(repository, [
    "-C",
    workspace,
    `--git-dir=${admin}`,
    "ls-files",
    "--unmerged",
    "-z",
  ]);
  if (unmerged.length > 0) return true;
  if (!(await stat(index)).isFile()) throw new Error(`Cannot read linked Git index at ${index}`);
  return false;
}

async function workspaceOperationState(
  repository: GitRepository,
  workspace: string,
  gitDirectory: string,
): Promise<Readonly<{ other: boolean; unmerged: boolean }>> {
  const paths = ["rebase-merge", "rebase-apply", "CHERRY_PICK_HEAD", "REVERT_HEAD"];
  const other = await Promise.all(
    paths.map(async (path) => {
      try {
        await access(join(gitDirectory, path));
        return true;
      } catch {
        return false;
      }
    }),
  );
  const unmerged = (await executeGit(repository, ["-C", workspace, "ls-files", "--unmerged", "-z"])).length > 0;
  return { other: other.some(Boolean), unmerged };
}

/** Follow a dependency baseline only through a clean, detached fast-forward. */
export async function followDependentManagedWorktree(
  repository: GitRepository,
  workspace: string,
  target: SnapshotId,
): Promise<DependentWorktreeFollow> {
  const head = await workspaceRevision(repository, workspace, "HEAD");
  if (head === null) throw new Error("managed worktree HEAD is missing");
  const status = await workspaceStatus(repository, workspace);
  const gitDirectory = await worktreeGitDirectory(repository, workspace);
  const operation = await workspaceOperationState(repository, workspace, gitDirectory);
  const mergeHead = await workspaceRevision(repository, workspace, "MERGE_HEAD");
  const paths = [
    ...new Set([
      ...status.staged,
      ...status.unstaged,
      ...status.untracked,
      ...status.submodules,
      ...status.unmergedPaths,
    ]),
  ].sort();
  const attached = await executeGit(repository, ["-C", workspace, "symbolic-ref", "--quiet", "HEAD"]).then(
    () => true,
    (error: unknown) => {
      if (error instanceof GitPlumbingError && error.status === 1) return false;
      throw error;
    },
  );
  if (attached) return { kind: "retained", head, reason: "head-attached", paths };
  if (mergeHead !== null || operation.other || operation.unmerged || paths.length > 0) {
    return { kind: "retained", head, reason: "operation-in-progress", paths };
  }
  if (head === target) return { kind: "unchanged" };
  let ancestor = false;
  try {
    await executeGit(repository, ["merge-base", "--is-ancestor", gitObjectId(head), gitObjectId(target)]);
    ancestor = true;
  } catch (error) {
    if (!(error instanceof GitPlumbingError) || error.status !== 1) throw error;
  }
  if (!ancestor) return { kind: "retained", head, reason: "head-moved", paths };
  await executeGit(repository, ["-C", workspace, "checkout", "--quiet", "--detach", gitObjectId(target)]);
  return { kind: "followed", before: head, after: target };
}

function fields(record: string, count: number): readonly string[] {
  const result: string[] = [];
  let start = 0;
  while (result.length < count - 1) {
    const separator = record.indexOf(" ", start);
    if (separator < 0) throw new Error(`malformed workspace status record: ${record}`);
    result.push(record.slice(start, separator));
    start = separator + 1;
  }
  result.push(record.slice(start));
  return result;
}

type WorkspaceStatus = WorkspaceChanges & Readonly<{ unmergedPaths: readonly string[] }>;

async function workspaceStatus(repository: GitRepository, workspace: string): Promise<WorkspaceStatus> {
  const records = (
    await executeGit(
      repository,
      ["-C", workspace, "status", "--porcelain=v2", "-z", "--untracked-files=all", "--ignore-submodules=none"],
      undefined,
      { GIT_OPTIONAL_LOCKS: "0" },
    )
  )
    .toString("utf8")
    .split("\0");
  const staged = new Set<string>();
  const unstaged = new Set<string>();
  const untracked = new Set<string>();
  const submodules = new Set<string>();
  const unmerged = new Set<string>();

  for (let index = 0; index < records.length - 1; index += 1) {
    const record = records[index]!;
    const kind = record[0];
    if (kind === "?") {
      untracked.add(fields(record, 2)[1]!);
      continue;
    }
    if (kind === "1" || kind === "2" || kind === "u") {
      const parts = fields(record, kind === "1" ? 9 : kind === "2" ? 10 : 11);
      const xy = parts[1]!;
      const sub = parts[2]!;
      const path = parts.at(-1)!;
      if (kind === "u") unmerged.add(path);
      if (xy[0] !== ".") staged.add(path);
      if (xy[1] !== ".") unstaged.add(path);
      if (sub.startsWith("S") && (sub[2] !== "." || sub[3] !== ".")) submodules.add(path);
      if (kind === "2") {
        const origin = records[index + 1];
        if (origin === undefined) throw new Error("renamed workspace status record is missing its origin path");
        if (xy[0] !== ".") staged.add(origin);
        if (xy[1] !== ".") unstaged.add(origin);
        index += 1;
      }
      continue;
    }
    throw new Error(`unknown workspace status record: ${record}`);
  }

  return {
    staged: [...staged].sort(),
    unstaged: [...unstaged].sort(),
    untracked: [...untracked].sort(),
    submodules: [...submodules].sort(),
    unmergedPaths: [...unmerged].sort(),
  };
}

/** Observe MERGE_HEAD in an appointed workspace, or undefined when absent. */
export async function workspaceMergeHead(
  repository: GitRepository,
  workspace: string,
): Promise<SnapshotId | undefined> {
  try {
    return mintSnapshotId(
      (await executeGit(repository, ["-C", workspace, "rev-parse", "-q", "--verify", "MERGE_HEAD"]))
        .toString("utf8")
        .trim(),
    );
  } catch (error) {
    if (error instanceof GitPlumbingError && error.status === 1) return undefined;
    throw error;
  }
}

/** True when the appointed workspace already has Git MERGE_HEAD. */
export async function workspaceMergeStatePresent(repository: GitRepository, workspace: string): Promise<boolean> {
  if ((await workspaceMergeHead(repository, workspace)) !== undefined) return true;
  const gitDirectory = await worktreeGitDirectory(repository, workspace);
  const operation = await workspaceOperationState(repository, workspace, gitDirectory);
  return operation.other || operation.unmerged;
}

/** Sorted unique unmerged index paths from porcelain status. */
export async function unmergedWorkspacePaths(repository: GitRepository, workspace: string): Promise<readonly string[]> {
  return (await workspaceStatus(repository, workspace)).unmergedPaths;
}

type WorkspaceChangeCounts = Extract<ContractWorkspaceObservation, { kind: "clean" | "dirty" }>["counts"];

export const conflictRecoverySchema = z
  .strictObject({
    materialize: z
      .strictObject({ kind: z.literal("deliver"), materializeConflict: z.literal(true), includeDirty: z.literal(true) })
      .readonly(),
    deliver: z.strictObject({ kind: z.literal("deliver"), includeDirty: z.literal(true) }).readonly(),
  })
  .readonly();
type ConflictRecovery = z.infer<typeof conflictRecoverySchema>;

export const conflictRecovery: ConflictRecovery = Object.freeze({
  materialize: { kind: "deliver", materializeConflict: true, includeDirty: true },
  deliver: { kind: "deliver", includeDirty: true },
});

export type ContractWorkspaceObservation = z.output<typeof contractWorkspaceObservationSchema>;

export const worktreeWorkspaceSchema = z
  .object({ kind: z.literal("worktree"), path: z.string().refine((value) => value.trim() !== "") })
  .strict()
  .readonly();
export const contractWorkspaceObservationSchema = z.union([
  z
    .strictObject({
      kind: z.enum(["clean", "dirty"]),
      location: worktreeWorkspaceSchema,
      counts: z
        .strictObject({ staged: z.number(), unstaged: z.number(), untracked: z.number(), submodules: z.number() })
        .readonly(),
      merge: z
        .strictObject({
          head: snapshotIdSchema,
          unmergedPaths: z.array(z.string()).readonly(),
          handoffBase: snapshotIdSchema.exactOptional(),
          recovery: conflictRecoverySchema.exactOptional(),
        })
        .readonly()
        .nullable(),
    })
    .readonly(),
  z.strictObject({ kind: z.literal("unavailable"), location: worktreeWorkspaceSchema }).readonly(),
  z.strictObject({ kind: z.literal("unappointed") }).readonly(),
  z.strictObject({ kind: z.literal("failed"), diagnostic: z.string() }).readonly(),
]);
export const contractTargetLagSchema = z.union([
  z
    .object({ kind: z.literal("none") })
    .strict()
    .readonly(),
  z
    .object({ kind: z.literal("unknown"), subject: worktreeWorkspaceSchema.exactOptional() })
    .strict()
    .readonly(),
  z
    .object({
      kind: z.literal("counted"),
      behind: z.number().int().nonnegative(),
      subject: worktreeWorkspaceSchema.exactOptional(),
    })
    .strict()
    .readonly(),
]);
export type ContractTargetLag = z.infer<typeof contractTargetLagSchema>;

function countsOf(changes: WorkspaceChanges): WorkspaceChangeCounts {
  return {
    staged: changes.staged.length,
    unstaged: changes.unstaged.length,
    untracked: changes.untracked.length,
    submodules: changes.submodules.length,
  };
}

export async function observeWorkspace(
  repository: GitRepository,
  location: ContractWorkspaceLocation,
  workspace: string,
): Promise<ContractWorkspaceObservation> {
  try {
    const status = await workspaceStatus(repository, workspace);
    const counts = countsOf(status);
    const dirty = counts.staged > 0 || counts.unstaged > 0 || counts.untracked > 0 || counts.submodules > 0;
    const head = await workspaceMergeHead(repository, workspace);
    const merge = head === undefined ? null : { head, unmergedPaths: status.unmergedPaths };
    return { kind: dirty ? "dirty" : "clean", location, counts, merge };
  } catch (error) {
    if (!(error instanceof GitPlumbingError)) throw error;
    return { kind: "unavailable", location };
  }
}

export async function observeTargetLag(
  repository: GitRepository,
  workspace: string,
  head: SnapshotId | null | undefined,
): Promise<ContractTargetLag> {
  if (head === undefined) return { kind: "none" };
  const subject = { kind: "worktree" as const, path: resolve(workspace) };
  if (head === null) return { kind: "unknown", subject };
  try {
    const text = (await executeGit(repository, ["-C", workspace, "rev-list", "--count", `HEAD..${head}`]))
      .toString("utf8")
      .trim();
    if (!/^[0-9]+$/u.test(text)) return { kind: "unknown", subject };
    return { kind: "counted", behind: Number(text), subject };
  } catch (error) {
    if (!(error instanceof GitPlumbingError)) throw error;
    return { kind: "unknown", subject };
  }
}

/** Capture tracked and untracked workspace bytes without changing its real index. */
export async function captureWorkspaceTree(repository: GitRepository, workspace: string): Promise<WorkspaceTree> {
  const identities = (await executeGit(repository, ["-C", workspace, "show", "-s", "--format=%H%n%T%n%cI", "HEAD"]))
    .toString("utf8")
    .split("\n");
  if (
    identities.length !== 4 ||
    identities[0] === undefined ||
    identities[1] === undefined ||
    identities[2] === undefined ||
    identities[3] !== ""
  ) {
    throw new Error("workspace HEAD/tree/time resolution returned an unexpected shape");
  }
  const head = mintSnapshotId(identities[0]);
  const tree = gitObjectId(identities[1], "workspace tree");
  const at = identities[2];
  if (Number.isNaN(Date.parse(at))) throw new Error("workspace HEAD has an invalid committer timestamp");
  const { unmergedPaths, ...changes } = await workspaceStatus(repository, workspace);
  const dirty = changes.staged.length > 0 || changes.unstaged.length > 0 || changes.untracked.length > 0;
  const capture = { head, at, dirty, changes, unmergedPaths };
  if (!dirty) return { tree, ...capture };

  return await withPrivateGitIndex(async (environment) => {
    await executeGit(
      repository,
      ["-C", workspace, "-c", "core.splitIndex=false", "read-tree", gitObjectId(head)],
      undefined,
      environment,
    );
    await executeGit(
      repository,
      ["-C", workspace, "-c", "core.splitIndex=false", "add", "--all"],
      undefined,
      environment,
    );
    return {
      tree: gitObjectId(
        (
          await executeGit(
            repository,
            ["-C", workspace, "-c", "core.splitIndex=false", "write-tree"],
            undefined,
            environment,
          )
        )
          .toString("utf8")
          .trim(),
        "workspace tree",
      ),
      ...capture,
    };
  });
}

const handoffRefFor = (contractId: ContractId, place: string) =>
  `${HANDOFF_RECEIPT_REF_NAMESPACE}/${contractPhysicalName(contractId)}/${place}`;

type HandoffReceipt = Readonly<{
  version: 1;
  contractId: ContractId;
  place: string;
  workspace: string;
  head: SnapshotId;
  mergeHead: SnapshotId;
  consumed: boolean;
  /** Opaque identity of this one issuance; older receipts predate it. */
  issuance?: string;
}>;
type StoredHandoffReceipt = Readonly<{ receipt: HandoffReceipt; ref: string; oid: string }>;

export type HandoffReceiptCoordinate = Readonly<{
  contractId: ContractId;
  place: string;
  workspace: string;
}>;

export type ConflictHandoff = Readonly<{ base: SnapshotId; mergeHead: SnapshotId }>;

type HandoffRetirement =
  | Readonly<{ kind: "absent" | "active" | "orphan-retired" | "retired" }>
  | Readonly<{ kind: "retained"; reason: "receipt-mismatch" | "operation-in-progress"; consumed: boolean }>;

function receiptFor(value: unknown): HandoffReceipt {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error("handoff receipt is malformed");
  const record = value as Record<string, unknown>;
  if (
    record.version !== 1 ||
    typeof record.contractId !== "string" ||
    typeof record.place !== "string" ||
    typeof record.workspace !== "string" ||
    typeof record.head !== "string" ||
    typeof record.mergeHead !== "string" ||
    (record.issuance !== undefined && (typeof record.issuance !== "string" || record.issuance.length === 0)) ||
    (record.consumed !== undefined && record.consumed !== true)
  ) {
    throw new Error("handoff receipt is malformed");
  }
  return {
    version: 1,
    contractId: record.contractId as ContractId,
    place: record.place,
    workspace: resolve(record.workspace),
    head: mintSnapshotId(record.head),
    mergeHead: mintSnapshotId(record.mergeHead),
    consumed: record.consumed === true,
    ...(record.issuance === undefined ? {} : { issuance: record.issuance }),
  };
}

function handoffReceiptBytes(receipt: HandoffReceipt, consumed: boolean): string {
  return `${JSON.stringify({
    version: receipt.version,
    contractId: receipt.contractId,
    place: receipt.place,
    workspace: receipt.workspace,
    head: receipt.head,
    mergeHead: receipt.mergeHead,
    ...(receipt.issuance === undefined ? {} : { issuance: receipt.issuance }),
    ...(consumed ? { consumed: true } : {}),
  })}\n`;
}

function receiptMatches(receipt: HandoffReceipt, coordinate: HandoffReceiptCoordinate): boolean {
  return (
    receipt.contractId === coordinate.contractId &&
    receipt.place === coordinate.place &&
    receipt.workspace === resolve(coordinate.workspace)
  );
}

async function storedHandoffReceipt(
  repository: GitRepository,
  contractId: ContractId,
  place: string,
): Promise<StoredHandoffReceipt | null> {
  const ref = handoffRefFor(contractId, place);
  const oid = await readRef(repository, ref);
  if (oid === null) return null;
  const receipt = receiptFor(JSON.parse((await readBlob(repository, oid)).toString("utf8")));
  return { receipt, ref, oid };
}

async function removeHandoffReceipt(repository: GitRepository, stored: StoredHandoffReceipt): Promise<void> {
  await executeGit(repository, ["update-ref", "--no-deref", "-d", stored.ref, stored.oid]);
}

export async function recordConflictHandoff(
  repository: GitRepository,
  input: Readonly<{
    contractId: ContractId;
    place: string;
    workspace: string;
    head: SnapshotId;
    mergeHead: SnapshotId;
  }>,
): Promise<void> {
  const ref = handoffRefFor(input.contractId, input.place);
  const existing = await readRef(repository, ref);
  if (existing !== null) throw new Error("a conflict handoff receipt is already active");
  const receipt: HandoffReceipt = {
    version: 1,
    contractId: input.contractId,
    place: input.place,
    workspace: resolve(input.workspace),
    head: input.head,
    mergeHead: input.mergeHead,
    consumed: false,
    issuance: randomUUID(),
  };
  const oid = await writeBlob(repository, handoffReceiptBytes(receipt, false));
  await executeGit(repository, ["update-ref", "--no-deref", ref, oid, "0".repeat(oid.length)]);
}

/** Read selected handoff refs once and decode their receipts through the call's blob channel. */
export async function readConflictHandoffs(
  repository: GitRepository,
  readBlobs: GitReadObservation["readBlobs"],
  coordinates: readonly HandoffReceiptCoordinate[],
): Promise<ReadonlyMap<ContractId, ConflictHandoff>> {
  const byRef = new Map<string, HandoffReceiptCoordinate>();
  for (const coordinate of coordinates) byRef.set(handoffRefFor(coordinate.contractId, coordinate.place), coordinate);
  if (byRef.size === 0) return new Map();
  const resolved = await readRefs(repository, [...byRef.keys()]);
  const present = [...resolved].flatMap(([ref, oid]) => (oid === null ? [] : [{ ref, oid }]));
  const blobs = await readBlobs(present.map(({ oid }) => oid));
  const handoffs = new Map<ContractId, ConflictHandoff>();
  for (const { ref, oid } of present) {
    const result = blobs.get(oid);
    if (result?.kind !== "present") throw new AuthorityCorruptionError(`Git handoff receipt is missing: ${ref}`);
    const receipt = receiptFor(JSON.parse(result.bytes.toString("utf8")));
    const coordinate = byRef.get(ref)!;
    if (!receiptMatches(receipt, coordinate)) continue;
    handoffs.set(coordinate.contractId, { base: receipt.head, mergeHead: receipt.mergeHead });
  }
  return handoffs;
}

type ObservedHandoff =
  | Readonly<{ kind: "absent" }>
  | Readonly<{ kind: "active" | "orphan"; stored: StoredHandoffReceipt }>
  | Extract<HandoffRetirement, { kind: "retained" }>;

/** Classify receipt ownership without retiring the merge or its receipt. */
export async function observeConflictHandoff(
  repository: GitRepository,
  input: HandoffReceiptCoordinate,
  captured?: Pick<HandoffReceipt, "head" | "mergeHead">,
): Promise<ObservedHandoff> {
  const stored = await storedHandoffReceipt(repository, input.contractId, input.place);
  if (stored === null) return { kind: "absent" };
  const { receipt } = stored;
  if (!receiptMatches(receipt, input)) {
    return { kind: "retained", reason: "receipt-mismatch", consumed: receipt.consumed };
  }
  const gitDirectory = await worktreeGitDirectory(repository, input.workspace);
  const operation = await workspaceOperationState(repository, input.workspace, gitDirectory);
  if (operation.other) return { kind: "retained", reason: "operation-in-progress", consumed: receipt.consumed };
  const [head, mergeHead] = await Promise.all([
    workspaceRevision(repository, input.workspace, "HEAD"),
    workspaceRevision(repository, input.workspace, "MERGE_HEAD"),
  ]);
  if (mergeHead === null) {
    // A consumed receipt proves its own admission, and an absent merge operation means the matching
    // effect is settled. `merge --quit` removes MERGE_HEAD and leaves the caller's unstaged-resolution
    // index entries in place, so that retained user state may not block deleting our own consumed
    // receipt; an unconsumed receipt keeps its operation-in-progress reading, and any foreign
    // operation marker still retains this one.
    if (operation.unmerged && !receipt.consumed)
      return { kind: "retained", reason: "operation-in-progress", consumed: receipt.consumed };
    return { kind: "orphan", stored };
  }
  if (
    head !== receipt.head ||
    mergeHead !== receipt.mergeHead ||
    (captured !== undefined && (captured.head !== head || captured.mergeHead !== mergeHead))
  )
    return { kind: "retained", reason: "receipt-mismatch", consumed: receipt.consumed };
  return { kind: "active", stored };
}

export async function retireConflictHandoff(
  repository: GitRepository,
  input: HandoffReceiptCoordinate & Readonly<{ consumeUnconsumed: boolean }>,
): Promise<HandoffRetirement> {
  const observed = await observeConflictHandoff(repository, input);
  if (observed.kind === "absent" || observed.kind === "retained") return observed;
  if (observed.kind === "orphan") {
    await removeHandoffReceipt(repository, observed.stored);
    return { kind: "orphan-retired" };
  }
  if (!observed.stored.receipt.consumed && !input.consumeUnconsumed) return { kind: "active" };
  await executeGit(repository, ["-C", input.workspace, "merge", "--quit"]);
  await removeHandoffReceipt(repository, observed.stored);
  return { kind: "retired" };
}

export type ConflictHandoffWitness = Readonly<{
  ref: string;
  oid: string;
  consumedOid: string;
  head: SnapshotId;
  mergeHead: SnapshotId;
}>;

export type ConflictHandoffOwnership =
  | Readonly<{ kind: "unowned" }>
  | Readonly<{ kind: "owned"; witness?: ConflictHandoffWitness }>;

/**
 * Prove the captured operation is this Contract's own handoff and, while it is still unconsumed,
 * materialize the exact consumed receipt that admission publishes atomically.
 */
export async function witnessConflictHandoff(
  repository: GitRepository,
  input: HandoffReceiptCoordinate,
  captured: Readonly<{ head: SnapshotId; mergeHead: SnapshotId }>,
): Promise<ConflictHandoffOwnership> {
  const observed = await observeConflictHandoff(repository, input, captured);
  if (observed.kind !== "active") return { kind: "unowned" };
  const { receipt, ref, oid } = observed.stored;
  if (receipt.consumed) return { kind: "owned" };
  const consumedOid = await writeBlob(repository, handoffReceiptBytes(receipt, true));
  return { kind: "owned", witness: { ref, oid, consumedOid, head: captured.head, mergeHead: captured.mergeHead } };
}

/**
 * Re-prove one captured unconsumed receipt as the live operation it witnessed and prepare the
 * atomic transition to its durable consumed proof. Publication by the admitting delivery consumes it.
 */
export async function consumeConflictHandoff(
  repository: GitRepository,
  input: HandoffReceiptCoordinate,
  captured: ConflictHandoffWitness,
): Promise<Readonly<{ kind: "consume"; update: GitRefUpdate }> | Readonly<{ kind: "skip" }>> {
  const observed = await observeConflictHandoff(repository, input, {
    head: captured.head,
    mergeHead: captured.mergeHead,
  });
  if (
    observed.kind !== "active" ||
    observed.stored.receipt.consumed ||
    observed.stored.ref !== captured.ref ||
    observed.stored.oid !== captured.oid
  )
    return { kind: "skip" };
  return {
    kind: "consume",
    update: { ref: captured.ref, newOid: captured.consumedOid, expectedOid: captured.oid },
  };
}
