import { KeiyakuError } from "../errors.js";
import { AuthorityCorruptionError } from "../core/facts/errors.js";
import { lstat, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import type { ContractId, SnapshotId } from "../core/facts/types.js";
import { contractPhysicalName, gitObjectId, gitObjectIdForSnapshot } from "./identity.js";
import { executeGit, executeLiteralGit, GitPlumbingError, withPrivateGitIndex, type GitRepository } from "./process.js";
import {
  assertAssertionRef,
  assertRef,
  GIT_REF,
  withGitDecodeChannel,
  withGitTargetedReadObservation,
  readRef,
} from "./read-observation.js";
import { parseTreeEntries, validPath, type TreeChange, type TreeEntry } from "./tree.js";
export { GIT_REF, GIT_FORMAT_PATH, GIT_FORMAT_BYTES, readRef } from "./read-observation.js";
export type { TreeChange } from "./tree.js";
export const DELIVERY_REF_NAMESPACE = "refs/keiyaku/delivery";
export const CANDIDATE_PIN_REF_NAMESPACE = "refs/keiyaku/candidate";
export const VERIFICATION_REF_NAMESPACE = "refs/keiyaku/verification";
export const HANDOFF_RECEIPT_REF_NAMESPACE = "refs/keiyaku/handoff";
const STATE_COMMIT_SUBJECT = "keiyaku authority - do not delete or rewrite";
export function isKeiyakuOwnedRef(ref: string): boolean {
  return (
    ref === GIT_REF ||
    ref === DELIVERY_REF_NAMESPACE ||
    ref.startsWith(`${DELIVERY_REF_NAMESPACE}/`) ||
    ref === CANDIDATE_PIN_REF_NAMESPACE ||
    ref.startsWith(`${CANDIDATE_PIN_REF_NAMESPACE}/`) ||
    ref === VERIFICATION_REF_NAMESPACE ||
    ref.startsWith(`${VERIFICATION_REF_NAMESPACE}/`) ||
    ref === HANDOFF_RECEIPT_REF_NAMESPACE ||
    ref.startsWith(`${HANDOFF_RECEIPT_REF_NAMESPACE}/`)
  );
}

export function verificationSnapshotRef(contract: ContractId, snapshot: SnapshotId): string {
  return `${VERIFICATION_REF_NAMESPACE}/${contractPhysicalName(contract)}/${gitObjectIdForSnapshot(snapshot)}`;
}

export type GitOid = string;
export type RefPublication =
  | Readonly<{ readonly kind: "published" }>
  | Readonly<{ readonly kind: "non-published"; readonly error: unknown }>
  | Readonly<{ readonly kind: "unknown" }>;
export type GitRefAssertion = Readonly<{
  readonly ref: string;
  readonly oid: GitOid;
}>;
export type GitSnapshot = Readonly<{
  readonly commit: GitOid | null;
  readonly tree: GitOid | null;
  readonly paths: ReadonlyMap<string, TreeEntry>;
}>;
export class NoGitWorldError extends KeiyakuError {
  readonly path: string;

  constructor(path: string) {
    super("internal", `no Git world at: ${path}`);
    this.path = path;
  }
}
type RegisteredWorktree = Readonly<{ path: string; branch: string | null }>;
type PorcelainWorktree = RegisteredWorktree & Readonly<{ prunable: boolean }>;

async function readWorktreeTopology(repository: GitRepository): Promise<readonly PorcelainWorktree[]> {
  const output = await executeGit(repository, ["worktree", "list", "--porcelain", "-z"]);
  const fields = output.toString("utf8").split("\0");
  const worktrees: PorcelainWorktree[] = [];
  let record: string[] = [];
  const finishRecord = (): void => {
    if (record.length === 0) return;
    const worktree = record[0];
    if (worktree === undefined || !worktree.startsWith("worktree ")) {
      throw new Error("Git worktree porcelain output is missing a worktree path");
    }
    const path = worktree.slice("worktree ".length);
    if (path.length === 0) throw new Error("Git worktree porcelain output has an empty worktree path");
    const branchField = record.find((field) => field.startsWith("branch "));
    const branch = branchField === undefined ? null : branchField.slice("branch ".length);
    if (branch !== null && !branch.startsWith("refs/"))
      throw new Error("Git worktree porcelain output has an invalid branch");
    worktrees.push({
      path: resolve(path),
      branch,
      prunable: record.some((field) => field.startsWith("prunable ")),
    });
    record = [];
  };
  for (const field of fields) {
    if (field.length === 0) {
      finishRecord();
      continue;
    }
    record.push(field);
  }
  finishRecord();
  if (worktrees.length === 0) throw new Error("Git worktree porcelain output has no worktrees");
  return worktrees;
}

export async function registeredWorktrees(repository: GitRepository): Promise<readonly RegisteredWorktree[]> {
  return await Promise.all(
    (await readWorktreeTopology(repository)).map(async ({ prunable, ...registered }) => {
      try {
        return { ...registered, path: await realpath(registered.path) };
      } catch (error) {
        if (prunable || (error as NodeJS.ErrnoException).code === "ENOENT") return registered;
        throw error;
      }
    }),
  );
}

export async function registeredWorktreePaths(repository: GitRepository): Promise<readonly string[]> {
  return (await registeredWorktrees(repository)).map((worktree) => worktree.path);
}

async function registrationPath(repository: GitRepository, path: string): Promise<string> {
  const parent = dirname(path);
  // Git permits a missing leaf; reconstruct any absent ancestors before worktree creation.
  if (parent !== path && !(await pathExists(parent)))
    return join(await registrationPath(repository, parent), basename(path));
  const args = [`--work-tree=${path}`, "rev-parse", "--show-toplevel"];
  return resolve((await executeGit(repository, args)).toString("utf8").slice(0, -1));
}

/** Names Git treats as registered in this directory, even when a checkout is missing. */
export async function registeredWorktreeNames(repository: GitRepository, directory: string): Promise<string[]> {
  const args = ["config", "--type=bool", "--default=false", "--get", "core.ignoreCase"];
  const ignoreCase = (await executeGit(repository, args)).toString("utf8").trim() === "true";
  const key = (path: string) => (ignoreCase ? path.replace(/[A-Z]/gu, (letter) => letter.toLowerCase()) : path);
  const parent = key(await registrationPath(repository, directory));
  const names: string[] = [];
  for (const { path } of await readWorktreeTopology(repository)) {
    const entry = await pathExists(path).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOTDIR") return null;
      throw error;
    });
    if (entry === null) continue;
    const canonical = await registrationPath(repository, path);
    if (key(dirname(canonical)) === parent) names.push(key(basename(canonical)));
  }
  return names;
}

/** Absence is ENOENT on the path entry itself: a dangling symlink is present residue, not a missing path. */
export async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}
export async function repositoryAt(cwd: string, gitPath = "git"): Promise<GitRepository> {
  if (typeof cwd !== "string" || cwd.length === 0) {
    throw new Error("repository path must be a nonempty string");
  }
  const effectiveCwd = resolve(cwd);
  const provisional = {
    gitPath,
    effectiveCwd,
    invocationWorktree: effectiveCwd,
    primaryWorktree: effectiveCwd,
    commonDirectory: effectiveCwd,
  } satisfies GitRepository;
  let invocationWorktree: string;
  let primaryWorktree: string;
  let commonDirectory: string;
  try {
    primaryWorktree = (await registeredWorktreePaths(provisional))[0]!;
    invocationWorktree = await worktreeRoot(provisional);
    commonDirectory = await absoluteGitPath(provisional, ["--git-common-dir"], "common Git directory");
  } catch (error) {
    if (error instanceof GitPlumbingError && error.status === 128) {
      throw new NoGitWorldError(effectiveCwd);
    }
    throw error;
  }
  return { gitPath, effectiveCwd, invocationWorktree, primaryWorktree, commonDirectory };
}

async function absoluteGitPath(repository: GitRepository, args: readonly string[], label: string): Promise<string> {
  const value = (await executeGit(repository, ["rev-parse", "--path-format=absolute", ...args]))
    .toString("utf8")
    .trim();
  if (value.length === 0) throw new Error(`${label} is empty`);
  return await realpath(resolve(isAbsolute(value) ? value : resolve(repository.effectiveCwd, value)));
}

export function commonGitDirectory(repository: GitRepository): string {
  return repository.commonDirectory;
}

/** Read one worktree's attached branch, or null for detached HEAD. */
export async function currentBranch(repository: GitRepository, path?: string): Promise<string | null> {
  try {
    const ref = (
      await executeGit(repository, [...(path === undefined ? [] : ["-C", path]), "symbolic-ref", "--quiet", "HEAD"])
    )
      .toString("utf8")
      .trim();
    return ref.startsWith("refs/heads/") ? ref : null;
  } catch (error) {
    if (error instanceof GitPlumbingError && error.status === 1) return null;
    throw error;
  }
}

export async function worktreeGitDirectory(repository: GitRepository, worktree: string): Promise<string> {
  const scoped = { ...repository, effectiveCwd: worktree };
  return await absoluteGitPath(scoped, ["--git-dir"], "worktree Git directory");
}

async function worktreeRoot(repository: GitRepository): Promise<string> {
  return await absoluteGitPath(repository, ["--show-toplevel"], "worktree root");
}

export async function updateSnapshotRef(
  repository: GitRepository,
  ref: string,
  desired: SnapshotId | null,
  expected?: GitOid | null,
) {
  const before = expected === undefined ? await readRef(repository, ref) : expected;
  if (before === desired) return undefined;
  const update =
    desired === null
      ? ["-d", ref, before!]
      : [ref, gitObjectIdForSnapshot(desired), before ?? "0".repeat(desired.length)];
  await executeGit(repository, ["update-ref", "--no-deref", ...update]);
  return { kind: "ref" as const, name: ref, before, after: desired };
}

/** Prepare or repair the exact evidence root. Live callers supply their owned attempt anchor. */
export async function associateVerificationSnapshot(
  repository: GitRepository,
  contract: ContractId,
  snapshot: SnapshotId,
  intent: "repair" | Readonly<{ anchor: string; reuse: boolean }>,
) {
  const anchor = intent === "repair" ? undefined : intent.anchor;
  const oid = gitObjectIdForSnapshot(snapshot);
  const diagnostic = `Verification snapshot unavailable: ${snapshot}`;
  let present = false;
  try {
    const object = await executeLiteralGit(
      repository,
      [...(anchor === undefined ? [] : ["-C", anchor]), "cat-file", "--batch-check=%(objectname) %(objecttype)"],
      `${anchor === undefined ? oid : "HEAD"}\n`,
    );
    const literal = object.toString("ascii");
    if (literal !== `${oid} commit\n`) {
      if (anchor === undefined && literal !== `${oid} missing\n`)
        throw new AuthorityCorruptionError(`Verification snapshot is not a commit: ${snapshot}`);
      return { kind: "candidate-unavailable" as const, diagnostic };
    }
    present = true;
    const ref = verificationSnapshotRef(contract, snapshot);
    const expectedOid = await readRef(repository, ref);
    if (intent !== "repair" && !intent.reuse)
      return { kind: "companion" as const, update: { ref, newOid: oid, expectedOid } };
    return { kind: "associated" as const, effect: await updateSnapshotRef(repository, ref, snapshot, expectedOid) };
  } catch (error) {
    if (!(error instanceof GitPlumbingError) || repository.signal?.aborted) throw error;
    return present
      ? { kind: "publication-failed" as const, diagnostic: error.message }
      : { kind: "candidate-unavailable" as const, diagnostic: `${diagnostic}: ${error.message}` };
  }
}

/** Read an explicit set of asserted refs from one fresh Git observation. */
export async function readRefs(repository: GitRepository, refs: readonly string[]) {
  const refsToRead = [...new Set(refs)];
  for (const ref of refsToRead) assertAssertionRef(ref);
  if (refsToRead.length === 0) return new Map();
  const output = (
    await executeGit(repository, ["cat-file", "--batch-check=%(objectname)"], `${refsToRead.join("\n")}\n`)
  ).toString("utf8");
  const records = output.split("\n");
  if (records.pop() !== "" || records.length !== refsToRead.length)
    throw new Error("Git ref batch output is malformed");
  return new Map(
    refsToRead.map((ref, index) => {
      const oid = records[index]!;
      if (oid === `${ref} missing`) return [ref, null];
      gitObjectId(oid, `ref ${ref}`);
      return [ref, oid];
    }),
  );
}

/** Read selected paths through the same frozen authority capability as product reads. */
export function readGitPaths(repository: GitRepository, paths: readonly string[]): Promise<GitSnapshot> {
  return withGitDecodeChannel(repository, (channel) =>
    withGitTargetedReadObservation(repository, channel, { paths }, ({ snapshot }) => snapshot),
  );
}

export async function writeBlob(repository: GitRepository, bytes: string | Uint8Array): Promise<GitOid> {
  const oid = (await executeGit(repository, ["hash-object", "-w", "--stdin"], bytes)).toString("utf8").trim();
  gitObjectId(oid, "written blob");
  return oid;
}

export async function readBlob(repository: GitRepository, oid: GitOid): Promise<Buffer> {
  gitObjectId(oid, "blob");
  return await executeGit(repository, ["cat-file", "blob", oid]);
}

function validateTreeChanges(changes: ReadonlyMap<string, TreeChange>): ReadonlySet<string> {
  const addressed = new Set<string>();
  for (const [path, change] of changes) {
    validPath(path);
    const parts = path.split("/");
    for (let length = 1; length <= parts.length; length += 1) {
      addressed.add(parts.slice(0, length).join("/"));
    }
    if (change === null) continue;
    gitObjectId(change.oid, `tree entry ${path}`);
    const mode = change.mode ?? "100644";
    if (!["100644", "100755", "120000", "160000"].includes(mode)) {
      throw new Error(`invalid Git leaf mode: ${mode}`);
    }
    if (change.type !== undefined && change.type !== (mode === "160000" ? "commit" : "blob")) {
      throw new Error(`invalid Git leaf type: ${path}`);
    }
  }
  return addressed;
}

/** Serialize a complete private tree through an isolated native Git index. */
export async function updateGitTree(
  repository: GitRepository,
  baseTree: GitOid | null,
  changes: ReadonlyMap<string, TreeChange>,
): Promise<GitOid> {
  if (baseTree !== null) gitObjectId(baseTree, "base tree");
  const addressed = validateTreeChanges(changes);
  const existing =
    baseTree === null || addressed.size === 0
      ? new Map<string, TreeEntry>()
      : parseTreeEntries(
          await executeGit(repository, [
            "ls-tree",
            "-z",
            "-t",
            "-r",
            "--full-tree",
            baseTree,
            "--",
            ...[...addressed].map((path) => `:(literal)${path}`),
          ]),
        );
  for (const [path, change] of changes) {
    if (change !== null && existing.get(path)?.type === "tree") {
      throw new Error(`Git path is both file and directory: ${path}`);
    }
    const parts = path.split("/");
    for (let length = 1; length < parts.length; length += 1) {
      const ancestor = parts.slice(0, length).join("/");
      const entry = existing.get(ancestor);
      if ((entry !== undefined && entry.type !== "tree") || changes.has(ancestor)) {
        throw new Error(`Git path is both file and directory: ${path}`);
      }
    }
  }
  const format = (await executeGit(repository, ["rev-parse", "--show-object-format"])).toString("ascii").trim();
  const width = format === "sha1" ? 40 : format === "sha256" ? 64 : 0;
  if (width === 0) throw new Error(`unsupported Git object format: ${format}`);
  const records: string[] = [];
  for (const [path, change] of changes) {
    if (change !== null && change.oid.length !== width) {
      throw new Error(`invalid Git object ID width: ${path}`);
    }
    records.push(
      change === null ? `0 ${"0".repeat(width)}\t${path}\0` : `${change.mode ?? "100644"} ${change.oid}\t${path}\0`,
    );
  }
  return await withPrivateGitIndex(async (environment) => {
    const config = ["-c", "core.splitIndex=false", "-c", "core.sparseCheckout=false", "-c", "index.sparse=false"];
    await executeGit(repository, [...config, "read-tree", baseTree ?? "--empty"], undefined, environment);
    await executeGit(repository, [...config, "update-index", "-z", "--index-info"], records.join(""), environment);
    const tree = (await executeGit(repository, [...config, "write-tree"], undefined, environment))
      .toString("ascii")
      .trim();
    gitObjectId(tree, "written tree");
    if (tree.length !== width) throw new Error("written tree has an invalid Git object ID width");
    return tree;
  });
}

async function writeCommitObject(
  input: Readonly<{
    repository: GitRepository;
    tree: GitOid;
    parents: readonly GitOid[];
    message: string;
    actor: string;
    email: string;
    at?: string;
  }>,
): Promise<GitOid> {
  const { repository, tree, parents, message, actor, email, at } = input;
  gitObjectId(tree, "commit tree");
  for (const parent of parents) gitObjectId(parent, "commit parent");
  const args = ["commit-tree", tree];
  for (const parent of parents) args.push("-p", parent);
  const commit = (
    await executeGit(repository, args, `${message}\n`, {
      GIT_AUTHOR_NAME: actor,
      GIT_AUTHOR_EMAIL: email,
      GIT_COMMITTER_NAME: actor,
      GIT_COMMITTER_EMAIL: email,
      ...(at === undefined ? {} : { GIT_AUTHOR_DATE: at, GIT_COMMITTER_DATE: at }),
    })
  )
    .toString("utf8")
    .trim();
  gitObjectId(commit, "written Git commit");
  return commit;
}

type WriteCommitInput = Readonly<{
  repository: GitRepository;
  tree: GitOid;
  parent: GitOid | null;
  message?: string;
  actor?: string;
  at?: string;
}>;

export async function writeCommit(input: WriteCommitInput): Promise<GitOid> {
  return await writeCommitObject({
    repository: input.repository,
    tree: input.tree,
    parents: input.parent === null ? [] : [input.parent],
    message: input.message ?? "keiyaku facts transaction",
    actor: input.actor ?? "Keiyaku Git",
    email: "keiyaku@localhost",
    ...(input.at === undefined ? {} : { at: input.at }),
  });
}

/** Write a commit that will become the canonical keiyaku-state tip. */
export async function writeStateCommit(input: WriteCommitInput): Promise<GitOid> {
  const detail = input.message;
  const message =
    detail === undefined || detail.length === 0 ? STATE_COMMIT_SUBJECT : `${STATE_COMMIT_SUBJECT}\n\n${detail}`;
  return await writeCommit({ ...input, message });
}

function refAssertionLine(assertion: GitRefAssertion): string {
  assertAssertionRef(assertion.ref);
  gitObjectId(assertion.oid, `expected oid for ${assertion.ref}`);
  if (assertion.ref.startsWith("worktrees/")) {
    // Git accepts a cross-worktree HEAD as an update but not as a verify command.
    return `option no-deref\nupdate ${assertion.ref} ${assertion.oid} ${assertion.oid}`;
  }
  return `${assertion.ref === "HEAD" ? "" : "option no-deref\n"}verify ${assertion.ref} ${assertion.oid}`;
}

export type GitRefUpdate = Readonly<{ ref: string; newOid: GitOid; expectedOid: GitOid | null }>;

function refUpdateLine(update: GitRefUpdate, index: number): string {
  assertRef(update.ref);
  if (index > 0 && update.ref === GIT_REF) throw new Error(`duplicate ref update: ${update.ref}`);
  if (index === 1 && update.expectedOid === null && !update.ref.startsWith(`${VERIFICATION_REF_NAMESPACE}/`)) {
    throw new Error("target ref updates require non-null OIDs");
  }
  if (index === 2 && !update.ref.startsWith(`${CANDIDATE_PIN_REF_NAMESPACE}/`))
    throw new Error("third atomic update must be a candidate pin");
  gitObjectId(update.newOid, `new oid for ${update.ref}`);
  if (update.expectedOid !== null) gitObjectId(update.expectedOid, `expected oid for ${update.ref}`);
  return `option no-deref\nupdate ${update.ref} ${update.newOid} ${update.expectedOid ?? "0".repeat(update.newOid.length)}`;
}

export async function updateRefsAtomically(
  repository: GitRepository,
  updates: readonly GitRefUpdate[],
  assertions: readonly GitRefAssertion[] = [],
): Promise<RefPublication> {
  if (updates.length === 0) throw new Error("an atomic ref transaction needs a Git update");
  if (updates.length > 3) throw new Error("an atomic ref transaction accepts at most two companion ref updates");
  const git = updates[0];
  if (git === undefined || git.ref !== GIT_REF) {
    throw new Error(`the first atomic update must be the Git ref: ${GIT_REF}`);
  }
  const lines = ["start", ...assertions.map(refAssertionLine), ...updates.map(refUpdateLine), "prepare", "commit", ""];
  try {
    await executeGit(repository, ["update-ref", "--stdin"], lines.join("\n"));
    return { kind: "published" };
  } catch (error) {
    if (!(error instanceof GitPlumbingError)) throw error;
    if (error.status !== null && error.status !== 0) {
      return { kind: "non-published", error };
    }
    if (error.pid !== null && error.pid > 0 && error.status === null) {
      return { kind: "unknown" };
    }
    throw error;
  }
}

type GitDiffStat = Readonly<{ filesChanged: number; insertions: number; deletions: number }>;

export function decodeGitNumstat(output: Buffer): GitDiffStat {
  const fields = output.toString("utf8").split("\0");
  if (fields.at(-1) !== "") throw new Error("Git numstat output is not NUL terminated");
  let filesChanged = 0;
  let insertions = 0;
  let deletions = 0;
  for (let index = 0; index < fields.length - 1; index += 1) {
    const field = fields[index]!;
    const [added, deleted, path, extra] = field.split("\t");
    if (added === undefined || deleted === undefined || path === undefined || extra !== undefined) {
      throw new Error("Git numstat output is malformed");
    }
    if (path.length === 0) {
      if (fields[index + 1] === undefined || fields[index + 2] === undefined) {
        throw new Error("Git rename numstat output is missing paths");
      }
      index += 2;
    }
    filesChanged += 1;
    insertions += added === "-" ? 0 : Number.parseInt(added, 10);
    deletions += deleted === "-" ? 0 : Number.parseInt(deleted, 10);
  }
  return { filesChanged, insertions, deletions };
}

export function decodeGitNameOnly(output: Buffer): readonly string[] {
  const names = output.toString("utf8").split("\0");
  if (names.at(-1) !== "") throw new Error("Git name-only output is not NUL terminated");
  return names.slice(0, -1);
}
