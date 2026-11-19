import { isUtf8 } from "node:buffer";
import { resolve } from "node:path";
import { z } from "zod";
import {
  acquireSqliteTransactionLock,
  type HeldSqliteTransactionLock,
} from "../coordination/sqlite-transaction-lock.js";
import { targetName, type ContractState, type ContractTarget, type SnapshotId } from "../core/facts/types.js";
import { contractIdSchema, gitObjectId, gitRefLocator, mintSnapshotId, snapshotIdSchema } from "./identity.js";
import { executeGit, GitPlumbingError, type GitRepository } from "./process.js";
import { commonGitDirectory, decodeGitNameOnly, readRef, registeredWorktrees } from "./repository.js";
import {
  resolveContractTarget,
  targetRef,
  targetRepository,
  targetWorkspaceRefusalSchema,
  type TargetWorkspaceRefusal,
} from "./target.js";
import { workspaceMergeStatePresent } from "./workspace.js";

export const checkoutNotFollowableRefusalSchema = z
  .object({
    kind: z.literal("checkout-not-followable"),
    target: z.string().refine((value) => value.trim() !== ""),
    path: z.string().refine((value) => value.trim() !== ""),
    paths: z.array(z.string().refine((value) => value.trim() !== "")).readonly(),
  })
  .strict()
  .readonly();
export type TargetPlacementRefusal = z.infer<typeof checkoutNotFollowableRefusalSchema> | TargetWorkspaceRefusal;
export const targetCheckoutEffectSchema = z
  .object({
    kind: z.literal("target-checkout"),
    path: z.string().refine((value) => value.trim() !== ""),
    target: z.string().refine((value) => value.trim() !== ""),
  })
  .strict()
  .readonly();
export const targetCheckoutLagSchema = z
  .object({
    kind: z.literal("target-checkout-retained"),
    path: z.string().refine((value) => value.trim() !== ""),
    target: z.string().refine((value) => value.trim() !== ""),
    diagnostic: z.string().refine((value) => value.trim() !== ""),
  })
  .strict()
  .readonly();
export const targetWorkspaceLagSchema = z
  .object({
    kind: z.literal("target-workspace-retained"),
    targetContractId: contractIdSchema,
    reason: targetWorkspaceRefusalSchema.unwrap().shape.reason,
  })
  .strict()
  .readonly();
type TargetPlacementPhysicalResult = Readonly<{
  effects: readonly z.infer<typeof targetCheckoutEffectSchema>[];
  lag: readonly (z.infer<typeof targetCheckoutLagSchema> | z.infer<typeof targetWorkspaceLagSchema>)[];
}>;

type Movement = Readonly<{ target: ContractTarget; predecessor: SnapshotId; candidate: SnapshotId }>;

export async function observeTargetHead(repository: GitRepository, target: ContractTarget): Promise<SnapshotId | null> {
  const value = await readRef(targetRepository(repository, target), targetRef(target));
  return value === null ? null : mintSnapshotId(value);
}

async function commitTree(repository: GitRepository, snapshot: SnapshotId) {
  const output = await executeGit(repository, ["show", "-s", "--format=%T", snapshot]);
  return gitObjectId(output.toString("ascii").trim(), "commit tree");
}

export async function observedTreeEqualsCandidate(
  repository: GitRepository,
  observed: SnapshotId | null,
  snapshot: SnapshotId,
) {
  return observed !== null && (await commitTree(repository, observed)) === (await commitTree(repository, snapshot));
}

async function resolveTargetCheckouts(repository: GitRepository, target: ContractTarget) {
  if (typeof target !== "string") {
    const resolved = await resolveContractTarget(repository, target.contractId, target);
    return resolved.kind === "refused" ? resolved : { kind: "resolved" as const, paths: [resolved.path] };
  }
  return {
    kind: "resolved" as const,
    paths: (await registeredWorktrees(repository))
      .filter((worktree) => worktree.branch === target)
      .map((worktree) => worktree.path)
      .sort((left, right) => left.localeCompare(right)),
  };
}

async function movementTrees(repository: GitRepository, movement: Movement) {
  const before = await commitTree(repository, movement.predecessor);
  const after = await commitTree(repository, movement.candidate);
  const changes = await executeGit(repository, [
    "diff",
    "--name-only",
    "--no-renames",
    "--ignore-submodules=none",
    "-z",
    before,
    after,
    "--",
  ]);
  return { ...movement, before, after, changes: isUtf8(changes) ? decodeGitNameOnly(changes) : null };
}

function checkoutReadTree(path: string, { predecessor, candidate }: Movement, dryRun = false) {
  return ["-C", path, "read-tree", "-m", "-u", ...(dryRun ? ["--dry-run"] : []), predecessor, candidate];
}

async function noDiff(repository: GitRepository, args: readonly string[], env: NodeJS.ProcessEnv): Promise<boolean> {
  try {
    await executeGit(repository, args, undefined, env);
    return true;
  } catch (error) {
    if (error instanceof GitPlumbingError && error.status === 1 && !repository.signal?.aborted) return false;
    throw error;
  }
}

type CheckoutShape = Readonly<{ kind: "complete" | "followable" }> | Readonly<{ kind: "retained"; diagnostic: string }>;

async function sparseCheckout(repository: GitRepository, path: string): Promise<boolean> {
  const git = (...args: string[]) => executeGit(repository, ["-C", path, ...args]);
  const sparse = await git("config", "--type=bool", "--default=false", "--get", "core.sparseCheckout");
  if (sparse.toString("ascii").trim() === "true") return true;
  const entries = await git("ls-files", "--cached", "--sparse", "-t", "-z");
  return entries[0] === 0x53 || entries.includes("\0S ");
}

async function changedPathIndexState(
  repository: GitRepository,
  path: string,
  tree: string,
  changes: readonly string[],
): Promise<boolean> {
  return await noDiff(
    repository,
    [
      "-C",
      path,
      "--literal-pathspecs",
      "diff-index",
      "--cached",
      "--quiet",
      "--ita-invisible-in-index",
      "--ignore-submodules=none",
      tree,
      "--",
      ...changes,
    ],
    { GIT_OPTIONAL_LOCKS: "0" },
  );
}

async function changedGitlinks(
  repository: GitRepository,
  path: string,
  tree: string,
  changes: readonly string[],
): Promise<readonly string[] | null> {
  const output = await executeGit(repository, [
    "-C",
    path,
    "--literal-pathspecs",
    "ls-tree",
    "-z",
    tree,
    "--",
    ...changes,
  ]);
  const paths: string[] = [];
  let start = 0;
  while (start < output.length) {
    const end = output.indexOf(0, start);
    if (end < 0) return null;
    const record = output.subarray(start, end);
    if (record.subarray(0, 7).toString("ascii") === "160000 ") {
      const tab = record.indexOf(0x09);
      if (tab < 0) return null;
      const name = record.subarray(tab + 1);
      if (!isUtf8(name)) return null;
      paths.push(name.toString("utf8"));
    }
    start = end + 1;
  }
  return paths;
}

async function dirtyChangedGitlinks(
  repository: GitRepository,
  path: string,
  trees: readonly string[],
  changes: readonly string[],
): Promise<boolean | null> {
  const gitlinks = new Set<string>();
  for (const tree of trees) {
    const paths = await changedGitlinks(repository, path, tree, changes);
    if (paths === null) return null;
    for (const name of paths) gitlinks.add(name);
  }
  if (gitlinks.size === 0) return false;
  // Gitlink equality alone misses modifications and untracked files inside a submodule.
  return !(await noDiff(
    repository,
    ["-C", path, "--literal-pathspecs", "diff-files", "--quiet", "--ignore-submodules=none", "--", ...gitlinks],
    { GIT_OPTIONAL_LOCKS: "0" },
  ));
}

async function changedPathWorktreeClean(
  repository: GitRepository,
  path: string,
  changes: readonly string[],
): Promise<boolean> {
  const output = await executeGit(
    repository,
    [
      "-C",
      path,
      "--literal-pathspecs",
      "--no-optional-locks",
      "status",
      "--porcelain=v1",
      "-z",
      "--no-renames",
      "--ignore-submodules=none",
      "--untracked-files=no",
      "--",
      ...changes,
    ],
    undefined,
    { GIT_OPTIONAL_LOCKS: "0" },
  );
  // The index column is already proven equal to the candidate; only the second, worktree-vs-index
  // column decides. Status keeps its native content recheck; staged bytes alone are not dirt.
  let start = 0;
  while (start < output.length) {
    const end = output.indexOf(0, start);
    if (end < 0) return false;
    if (output[start + 1] !== 0x20) return false;
    start = end + 1;
  }
  return true;
}

async function nativeCheckoutRefusal(
  repository: GitRepository,
  path: string,
  movement: Awaited<ReturnType<typeof movementTrees>>,
): Promise<string | undefined> {
  try {
    await executeGit(repository, checkoutReadTree(path, movement, true));
    return undefined;
  } catch (error) {
    if (!(error instanceof GitPlumbingError)) throw error;
    repository.signal?.throwIfAborted();
    return error.stderr.toString("utf8").trim() || error.message;
  }
}

async function classifyCheckout(
  repository: GitRepository,
  path: string,
  movement: Awaited<ReturnType<typeof movementTrees>>,
): Promise<CheckoutShape> {
  const { before, after, changes } = movement;
  if (await workspaceMergeStatePresent(repository, path))
    return { kind: "retained", diagnostic: "target checkout has a Git operation or an unmerged index" };
  if (await sparseCheckout(repository, path))
    return { kind: "retained", diagnostic: "target checkout has a sparse checkout or index" };
  if (changes === null) return { kind: "retained", diagnostic: "target checkout cannot prove changed path bytes" };
  if (changes.length === 0) return { kind: "complete" };
  // Changed paths must cohere at one end of the movement; anything else is mixed caller state.
  const atPredecessor = await changedPathIndexState(repository, path, before, changes);
  if (!atPredecessor) {
    if (!(await changedPathIndexState(repository, path, after, changes)))
      return { kind: "retained", diagnostic: "target checkout has mixed or local state on changed paths" };
    if (!(await changedPathWorktreeClean(repository, path, changes)))
      return { kind: "retained", diagnostic: "target checkout has local state on changed paths" };
  }
  if (atPredecessor) {
    const dirtyGitlinks = await dirtyChangedGitlinks(repository, path, [before, after], changes);
    if (dirtyGitlinks === null)
      return { kind: "retained", diagnostic: "target checkout cannot prove changed submodule paths" };
    if (dirtyGitlinks) return { kind: "retained", diagnostic: "target checkout has dirty changed submodule internals" };
  }
  // Native Git alone decides real worktree contact; its refusal retains the whole checkout.
  const refusal = await nativeCheckoutRefusal(repository, path, movement);
  if (refusal !== undefined) return { kind: "retained", diagnostic: refusal };
  return { kind: atPredecessor ? "followable" : "complete" };
}

function checkoutDiagnostic(repository: GitRepository, error: unknown): string {
  if (error instanceof GitPlumbingError) {
    repository.signal?.throwIfAborted();
    return error.message;
  }
  if (
    error instanceof Error &&
    !(error instanceof TypeError) &&
    "code" in error &&
    typeof error.code === "string" &&
    /^E[A-Z0-9]+$/u.test(error.code)
  )
    return error.message;
  throw error;
}

async function inspectCheckout(
  repository: GitRepository,
  path: string,
  trees: Awaited<ReturnType<typeof movementTrees>>,
): Promise<CheckoutShape> {
  try {
    return await classifyCheckout(repository, path, trees);
  } catch (error) {
    return { kind: "retained", diagnostic: checkoutDiagnostic(repository, error) };
  }
}

export async function acquireTargetPlacementFence(
  repository: GitRepository,
  target: string,
): Promise<HeldSqliteTransactionLock> {
  const locator = gitRefLocator(target);
  return await acquireSqliteTransactionLock({
    path: resolve(commonGitDirectory(repository), "keiyaku", "locks", "target-placement", `${locator}.sqlite`),
    mode: "immediate",
    timeoutMs: 5_000,
    ...(repository.signal === undefined ? {} : { signal: repository.signal }),
  });
}

export const previewTargetMovedSchema = z
  .strictObject({
    kind: z.literal("moved"),
    ref: z.string().refine((value) => value.trim() !== ""),
    expected: snapshotIdSchema,
    observed: snapshotIdSchema.nullable(),
  })
  .readonly();
export const previewTargetFailedSchema = z
  .strictObject({ kind: z.literal("failed"), diagnostic: z.string().refine((value) => value.trim() !== "") })
  .readonly();
type CheckoutObservation =
  | Readonly<{ kind: "followable"; path: string }>
  | Readonly<{ kind: "not-followable"; path: string; diagnostic: string }>;
type PreviewTargetAnswer =
  | Readonly<{ kind: "placeable"; ref: string; head: SnapshotId; checkouts: readonly CheckoutObservation[] }>
  | Readonly<{ kind: "refused"; refusal: TargetWorkspaceRefusal }>
  | z.infer<typeof previewTargetMovedSchema>
  | z.infer<typeof previewTargetFailedSchema>;

export async function adjudicatePreviewTarget(
  repository: GitRepository,
  movement: Movement,
): Promise<PreviewTargetAnswer> {
  const { target, predecessor: expected } = movement;
  const ref = targetName(target);
  try {
    const head = await observeTargetHead(repository, target);
    if (head !== expected) return { kind: "moved", ref, expected, observed: head };
    const resolved = await resolveTargetCheckouts(repository, target);
    const checkouts: CheckoutObservation[] = [];
    if (resolved.kind === "resolved" && resolved.paths.length > 0) {
      const trees = await movementTrees(repository, movement);
      for (const path of resolved.paths) {
        const shape = await inspectCheckout(repository, path, trees);
        checkouts.push(
          shape.kind === "retained"
            ? { kind: "not-followable", path, diagnostic: shape.diagnostic }
            : { kind: "followable", path },
        );
      }
    }
    const observed = await observeTargetHead(repository, target);
    if (observed !== expected) return { kind: "moved", ref, expected, observed };
    return resolved.kind === "refused" ? resolved : { kind: "placeable", ref, head, checkouts };
  } catch (error) {
    if (!(error instanceof GitPlumbingError)) throw error;
    repository.signal?.throwIfAborted();
    return { kind: "failed", diagnostic: error.message };
  }
}

/** Selected read projection for the current accepted movement. */
export async function observeTargetCheckoutShape(
  repository: GitRepository,
  movement: Movement,
): Promise<CheckoutShape["kind"]> {
  const resolved = await resolveTargetCheckouts(repository, movement.target);
  if (resolved.kind === "refused") return "retained";
  if (resolved.paths.length === 0) return "complete";
  const trees = await movementTrees(repository, movement);
  let kind: "complete" | "followable" = "complete";
  for (const path of resolved.paths) {
    const shape = await inspectCheckout(repository, path, trees);
    if (shape.kind === "retained") return "retained";
    if (shape.kind === "followable") kind = "followable";
  }
  return kind;
}

function claimedMovement(state: ContractState) {
  const { target } = state.coordinates;
  const integration = state.currentIntegration;
  if (state.terminal?.kind !== "claimed" || target === undefined || integration === null) return undefined;
  return { target, integration };
}

/** Follow only the exact durable movement, under the caller's target fence. */
export async function recoverTargetPlacement(
  repository: GitRepository,
  state: ContractState,
  onPhysical?: (report: TargetPlacementPhysicalResult) => void,
): Promise<TargetPlacementPhysicalResult> {
  const claimed = claimedMovement(state);
  const effects: TargetPlacementPhysicalResult["effects"][number][] = [];
  const lag: TargetPlacementPhysicalResult["lag"][number][] = [];
  if (claimed === undefined) return { effects, lag };
  const { target, integration } = claimed;
  const { predecessor, snapshot: candidate } = integration;
  // If the ref is unavailable, still distinguish an unavailable Contract destination from branch drift.
  const current = await observeTargetHead(repository, target);
  if (typeof target === "string" && current !== candidate) return { effects, lag };
  const resolved = await resolveTargetCheckouts(repository, target);
  if (resolved.kind === "refused") {
    const issue = {
      kind: "target-workspace-retained" as const,
      targetContractId: resolved.refusal.contractId,
      reason: resolved.refusal.reason,
    };
    onPhysical?.({ effects: [], lag: [issue] });
    return { effects, lag: [issue] };
  }
  if (current !== candidate || resolved.paths.length === 0) return { effects, lag };
  const trees = movementTrees(repository, { target, predecessor, candidate });
  for (const path of resolved.paths) {
    let issue: string | undefined;
    try {
      const movement = await trees;
      let shape = await classifyCheckout(repository, path, movement);
      if (shape.kind === "followable") shape = await classifyCheckout(repository, path, movement);
      if (shape.kind === "complete") continue;
      if (shape.kind === "retained") issue = shape.diagnostic;
      else {
        await executeGit(repository, checkoutReadTree(path, movement));
        const followed = await classifyCheckout(repository, path, movement);
        if (followed.kind !== "complete")
          issue = followed.kind === "retained" ? followed.diagnostic : "target checkout did not follow the candidate";
      }
    } catch (error) {
      issue = checkoutDiagnostic(repository, error);
    }
    if (issue !== undefined) {
      const retained = {
        kind: "target-checkout-retained" as const,
        path,
        target: targetName(target),
        diagnostic: issue,
      };
      lag.push(retained);
      onPhysical?.({ effects: [], lag: [retained] });
    } else {
      const followed = { kind: "target-checkout" as const, path, target: targetName(target) };
      effects.push(followed);
      onPhysical?.({ effects: [followed], lag: [] });
    }
  }
  return { effects, lag };
}
