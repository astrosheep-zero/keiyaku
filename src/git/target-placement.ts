import { isUtf8 } from "node:buffer";
import type { BigIntStats } from "node:fs";
import { lstat, readdir, realpath } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { z } from "zod";
import {
  acquireSqliteTransactionLock,
  type HeldSqliteTransactionLock,
} from "../coordination/sqlite-transaction-lock.js";
import { targetName, type ContractState, type ContractTarget, type SnapshotId } from "../core/facts/types.js";
import { contractIdSchema, gitObjectId, gitRefLocator, mintSnapshotId, snapshotIdSchema } from "./identity.js";
import { executeGit, GitPlumbingError, withPrivateGitIndex, type GitRepository } from "./process.js";
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

async function ignoredContact(
  repository: GitRepository,
  root: string,
  changes: readonly string[] | null,
): Promise<string | undefined> {
  if (changes?.length === 0) return;
  const ignored = await executeGit(repository, [
    "-C",
    root,
    "ls-files",
    "--others",
    "--ignored",
    "--exclude-standard",
    "-z",
  ]);
  if (ignored.length === 0) return;
  if (changes === null || !isUtf8(ignored)) return "target checkout cannot prove ignored paths safe to follow";

  const probes = new Map<string, Promise<BigIntStats | undefined>>();
  async function* livePrefixes(path: string) {
    let parent = "";
    let directory = "";
    const parts = path.split("/");
    for (const [index, name] of parts.entries()) {
      const prefix = directory === "" ? name : `${directory}/${name}`;
      let probe = probes.get(prefix);
      if (probe === undefined) {
        probe = lstat(resolve(root, prefix), { bigint: true }).catch((error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT") return undefined;
          throw error;
        });
        probes.set(prefix, probe);
      }
      const entry = await probe;
      if (entry === undefined) return;
      const identity = `${entry.dev}:${entry.ino}`;
      yield { key: `${parent}/${identity}`, name, directory, entry, leaf: index === parts.length - 1 };
      if (!entry.isDirectory()) return;
      parent = identity;
      directory = prefix;
    }
  }

  // An identity match under the same parent finds aliases without normalizing names.
  const touched = new Map<string, Map<string, boolean>>();
  for (const path of changes) {
    for await (const { key, name, leaf } of livePrefixes(path)) {
      let names = touched.get(key);
      if (names === undefined) touched.set(key, (names = new Map()));
      names.set(name, leaf || names.get(name) === true);
    }
  }
  if (touched.size === 0) return;
  async function distinctEntries(directory: string, left: string, right: string, shared: BigIntStats) {
    const parent = resolve(root, directory);
    const names = await readdir(parent, { encoding: "buffer" });
    const present = (value: string) => {
      const name = Buffer.from(value);
      return names.some((entry) => entry.equals(name));
    };
    if (present(left) && present(right)) return true;
    // A symlink is a leaf; using realpath to resolve its alias would dereference it.
    if (shared.isSymbolicLink()) return false;
    // Some filesystems return the lookup spelling unchanged; require enumerated entries.
    const a = await realpath(resolve(parent, left), { encoding: "buffer" });
    const b = await realpath(resolve(parent, right), { encoding: "buffer" });
    if (a.equals(b) || !isUtf8(a) || !isUtf8(b)) return false;
    const aPath = a.toString("utf8");
    const bPath = b.toString("utf8");
    return dirname(aPath) === dirname(bPath) && present(basename(aPath)) && present(basename(bPath));
  }

  for (const record of decodeGitNameOnly(ignored)) {
    const path = record.endsWith("/") ? record.slice(0, -1) : record;
    for await (const { key, name, directory, entry, leaf } of livePrefixes(path)) {
      const matches = touched.get(key);
      if (matches === undefined) break;
      for (const [spelling, changed] of matches) {
        if (!leaf && !changed) continue;
        if (entry.ino === 0n || (name !== spelling && !entry.isDirectory() && entry.nlink !== 1n)) {
          if (entry.ino !== 0n && (await distinctEntries(directory, name, spelling, entry))) continue;
          return `target checkout cannot rule out contact with ignored entry: ${path}`;
        }
        return `target checkout would overwrite ignored local entry: ${path}`;
      }
    }
  }
  return undefined;
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

async function classifyCheckout(
  repository: GitRepository,
  path: string,
  movement: Awaited<ReturnType<typeof movementTrees>>,
): Promise<CheckoutShape> {
  const { before, after, changes } = movement;
  if (await workspaceMergeStatePresent(repository, path))
    return { kind: "retained", diagnostic: "target checkout has a Git operation or an unmerged index" };
  const sparseDiagnostic = { kind: "retained", diagnostic: "target checkout has a sparse checkout or index" } as const;
  const sparse = await executeGit(repository, [
    "-C",
    path,
    "config",
    "--type=bool",
    "--default=false",
    "--get",
    "core.sparseCheckout",
  ]);
  if (sparse.toString("ascii").trim() === "true") return sparseDiagnostic;
  const entries = await executeGit(repository, [
    "-C",
    path,
    "ls-files",
    "--others",
    "--exclude-standard",
    "--cached",
    "--sparse",
    "-t",
    "-z",
  ]);
  const tagged = (tag: string) => entries[0] === tag.charCodeAt(0) || entries.includes(`\0${tag} `);
  if (tagged("S")) return sparseDiagnostic;
  if (tagged("?")) return { kind: "retained", diagnostic: "target checkout has untracked files" };
  const unchanged = (tree: string) =>
    noDiff(
      repository,
      [
        "-C",
        path,
        "diff-index",
        "--cached",
        "--quiet",
        "--ita-invisible-in-index",
        "--ignore-submodules=none",
        tree,
        "--",
      ],
      { GIT_OPTIONAL_LOCKS: "0" },
    );
  const tree = (await unchanged(after)) ? after : (await unchanged(before)) ? before : undefined;
  if (tree === undefined) return { kind: "retained", diagnostic: "target index matches neither complete tree" };

  // A fresh index seeded from the matching tree sees final bytes, not caller stat or skip flags.
  const exact = await withPrivateGitIndex(async (env) => {
    const git = [
      "-C",
      path,
      "-c",
      "core.splitIndex=false",
      "-c",
      "core.sparseCheckout=false",
      "-c",
      "index.sparse=false",
    ];
    await executeGit(repository, [...git, "read-tree", tree], undefined, env);
    await executeGit(repository, [...git, "add", "--all"], undefined, env);
    const captured = await executeGit(repository, [...git, "write-tree"], undefined, env);
    return (
      captured.toString("ascii").trim() === tree &&
      // Gitlink equality alone misses modifications and untracked files inside a submodule.
      (await noDiff(repository, [...git, "diff-files", "--quiet", "--ignore-submodules=none", "--"], {
        ...env,
        GIT_OPTIONAL_LOCKS: "0",
      }))
    );
  });
  if (!exact) return { kind: "retained", diagnostic: "target worktree does not match its index tree" };
  if (tree === after) return { kind: "complete" };
  const ignored = await ignoredContact(repository, path, changes);
  if (ignored !== undefined) return { kind: "retained", diagnostic: ignored };
  // Exact content and ignored custody do not prove that Git will accept the real index's stat data.
  try {
    await executeGit(repository, checkoutReadTree(path, movement, true));
  } catch (error) {
    if (!(error instanceof GitPlumbingError)) throw error;
    repository.signal?.throwIfAborted();
    return { kind: "retained", diagnostic: error.stderr.toString("utf8").trim() || error.message };
  }
  return { kind: "followable" };
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

/** Follow only the exact durable movement, under the caller's target fence. */
export async function recoverTargetPlacement(
  repository: GitRepository,
  state: ContractState,
  onPhysical?: (report: TargetPlacementPhysicalResult) => void,
): Promise<TargetPlacementPhysicalResult> {
  const { target } = state.coordinates;
  const integration = state.currentIntegration;
  const effects: TargetPlacementPhysicalResult["effects"][number][] = [];
  const lag: TargetPlacementPhysicalResult["lag"][number][] = [];
  if (state.terminal?.kind !== "claimed" || target === undefined || integration === null) return { effects, lag };
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
