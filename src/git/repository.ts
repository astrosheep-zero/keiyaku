import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { AuthorityCorruptionError } from "../core/facts/errors.js";
import { gitObjectId } from "./identity.js";
import {
  parseTreeObject,
  prepareTreeUpdate,
  treeUpdate,
  validPath,
  type PreparedTree,
  type TreeChange,
  type TreeEntry,
} from "./tree.js";
export type { TreeChange } from "./tree.js";

export const GIT_REF = "refs/heads/keiyaku-state";
export const DELIVERY_REF_NAMESPACE = "refs/heads/keiyaku-delivery";
export const CANDIDATE_PIN_REF_NAMESPACE = "refs/heads/keiyaku-candidate";
export const GIT_FORMAT_PATH = "meta/format.json";
const CURRENT_FORMAT_VERSION = 3;
export const GIT_FORMAT_BYTES = `{"version":${CURRENT_FORMAT_VERSION}}\n`;

export function isKeiyakuOwnedRef(ref: string): boolean {
  return ref === GIT_REF
    || ref === DELIVERY_REF_NAMESPACE
    || ref.startsWith(`${DELIVERY_REF_NAMESPACE}/`)
    || ref === CANDIDATE_PIN_REF_NAMESPACE
    || ref.startsWith(`${CANDIDATE_PIN_REF_NAMESPACE}/`);
}

export function normalizeTargetBranch(repository: GitRepository, input: string): string | null {
  if (input.includes("\0")) return null;
  const prefix = "refs/heads/";
  if (input.startsWith("refs/") && !input.startsWith(prefix)) return null;
  const branch = input.startsWith(prefix) ? input.slice(prefix.length) : input;
  const target = `${prefix}${branch}`;
  if (branch.length === 0 || branch.startsWith("-") || isKeiyakuOwnedRef(target)) return null;
  try {
    const checked = runGit(repository, ["check-ref-format", "--branch", branch]).toString("utf8").trim();
    return checked === branch ? target : null;
  } catch (error) {
    if (error instanceof GitPlumbingError && error.status !== null) return null;
    throw error;
  }
}

export type GitOid = string;

export type RefPublication =
  | Readonly<{ readonly kind: "published" }>
  | Readonly<{ readonly kind: "non-published"; readonly error: unknown }>
  | Readonly<{ readonly kind: "unknown" }>;

export type GitRepository = Readonly<{
  /** The invocation's effective working directory, including a caller -C worktree. */
  readonly effectiveCwd: string;
  /** The canonical primary worktree root for this repository. */
  readonly primaryWorktree: string;
}>;

export type GitSnapshot = Readonly<{
  readonly commit: GitOid | null;
  readonly tree: GitOid | null;
  readonly paths: ReadonlyMap<string, TreeEntry>;
}>;

export class NoGitWorldError extends Error {
  readonly path: string;

  constructor(path: string) {
    super(`no Git world at: ${path}`);
    this.name = "NoGitWorldError";
    this.path = path;
  }
}

class GitPlumbingError extends Error {
  readonly stderr: Buffer;
  readonly status: number | null;
  readonly pid: number | null;

  constructor(input: Readonly<{
    stderr: string | Uint8Array;
    status: number | null;
    message: string;
    pid?: number | null;
  }>) {
    super(input.message);
    this.name = "GitPlumbingError";
    this.stderr = Buffer.from(input.stderr);
    this.status = input.status;
    this.pid = input.pid ?? null;
  }
}

function worktreePathsFromPorcelain(output: Buffer): readonly string[] {
  const fields = output.toString("utf8").split("\0");
  const paths: string[] = [];
  let record: string[] = [];
  const finishRecord = (): void => {
    if (record.length === 0) return;
    const worktree = record[0];
    if (worktree === undefined || !worktree.startsWith("worktree ")) {
      throw new Error("Git worktree porcelain output is missing a worktree path");
    }
    const path = worktree.slice("worktree ".length);
    if (path.length === 0) throw new Error("Git worktree porcelain output has an empty worktree path");
    paths.push(resolve(path));
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
  if (paths.length === 0) throw new Error("Git worktree porcelain output has no worktrees");
  return paths;
}

export function registeredWorktreePaths(repository: GitRepository): readonly string[] {
  return worktreePathsFromPorcelain(runGit(repository, ["worktree", "list", "--porcelain", "-z"]));
}

export function repositoryAt(cwd: string): GitRepository {
  if (typeof cwd !== "string" || cwd.length === 0) {
    throw new Error("repository path must be a nonempty string");
  }
  const effectiveCwd = resolve(cwd);
  const provisional = { effectiveCwd, primaryWorktree: effectiveCwd } satisfies GitRepository;
  let primaryWorktree: string;
  try {
    primaryWorktree = registeredWorktreePaths(provisional)[0]!;
  } catch (error) {
    if (error instanceof GitPlumbingError && error.status === 128) {
      throw new NoGitWorldError(effectiveCwd);
    }
    throw error;
  }
  return { effectiveCwd, primaryWorktree };
}

function commandError(command: readonly string[], error: unknown): GitPlumbingError {
  const candidate = error as {
    message?: string;
    stderr?: Buffer | string;
    status?: number | null;
    pid?: number;
  };
  const stderr = candidate.stderr === undefined ? Buffer.alloc(0) : Buffer.from(candidate.stderr);
  const detail = stderr.length === 0 ? candidate.message ?? "git command failed" : stderr.toString("utf8");
  return new GitPlumbingError({
    stderr,
    status: candidate.status ?? null,
    message: `${command.join(" ")}: ${detail}`,
    pid: candidate.pid ?? null,
  });
}

export function runGit(repository: GitRepository, args: readonly string[], input?: string | Uint8Array): Buffer {
  try {
    const output = execFileSync("git", [...args], {
      cwd: repository.effectiveCwd,
      input,
      stdio: ["pipe", "pipe", "pipe"],
    });
    return Buffer.isBuffer(output) ? output : Buffer.from(output);
  } catch (error) {
    throw commandError(args, error);
  }
}

export function runGitWithEnvironment(
  repository: GitRepository,
  args: readonly string[],
  input: string | Uint8Array | undefined,
  environment: NodeJS.ProcessEnv,
): Buffer {
  try {
    const output = execFileSync("git", [...args], {
      cwd: repository.effectiveCwd,
      input,
      env: { ...process.env, ...environment },
      stdio: ["pipe", "pipe", "pipe"],
    });
    return Buffer.isBuffer(output) ? output : Buffer.from(output);
  } catch (error) {
    throw commandError(args, error);
  }
}

function assertOid(oid: string, label: string): void {
  gitObjectId(oid, label);
}

function assertRef(ref: string): void {
  if (!ref.startsWith("refs/") || /[\s\0]/.test(ref) || ref.endsWith("/") || ref.includes("..")) {
    throw new Error(`invalid Git ref: ${ref}`);
  }
}

export function readRef(repository: GitRepository, ref: string): GitOid | null {
  assertRef(ref);
  try {
    const oid = runGit(repository, ["rev-parse", "--verify", "--quiet", ref]).toString("utf8").trim();
    if (oid.length === 0) return null;
    assertOid(oid, `ref ${ref}`);
    return oid;
  } catch (error) {
    if (error instanceof GitPlumbingError && error.status === 1) return null;
    throw error;
  }
}

function readTreeForCommit(repository: GitRepository, commit: GitOid): GitOid {
  assertOid(commit, "Git commit");
  const tree = runGit(repository, ["rev-parse", "--verify", `${commit}^{tree}`]).toString("utf8").trim();
  assertOid(tree, "Git tree");
  return tree;
}

function parseTreeEntries(output: Buffer): Map<string, TreeEntry> {
  const entries = new Map<string, TreeEntry>();
  for (const record of output.toString("utf8").split("\0")) {
    if (record.length === 0) continue;
    const separator = record.indexOf("\t");
    if (separator < 0) throw new GitPlumbingError({ stderr: record, status: null, message: `malformed ls-tree record: ${record}` });
    const [mode, type, oid] = record.slice(0, separator).split(" ");
    const path = record.slice(separator + 1);
    if (mode === undefined || type === undefined || oid === undefined || path.length === 0) {
      throw new GitPlumbingError({ stderr: record, status: null, message: `malformed ls-tree record: ${record}` });
    }
    assertOid(oid, `tree entry ${path}`);
    entries.set(path, { mode, type, oid });
  }
  return entries;
}

function readTreeEntries(repository: GitRepository, tree: GitOid): Map<string, TreeEntry> {
  assertOid(tree, "tree");
  const output = runGit(repository, ["ls-tree", "-r", "-z", "--full-tree", tree]);
  return parseTreeEntries(output);
}

export function readGit(repository: GitRepository): GitSnapshot {
  const commit = readRef(repository, GIT_REF);
  if (commit === null) {
    return { commit: null, tree: null, paths: new Map() };
  }
  const tree = readTreeForCommit(repository, commit);
  const paths = readTreeEntries(repository, tree);
  validateGitFormat(repository, paths);
  return { commit, tree, paths };
}

/** Read only the requested private Git paths from one immutable Git tree. */
export function readGitPaths(
  repository: GitRepository,
  requestedPaths: readonly string[],
): GitSnapshot {
  for (const path of requestedPaths) validPath(path);
  const commit = readRef(repository, GIT_REF);
  if (commit === null) return { commit: null, tree: null, paths: new Map() };

  const tree = readTreeForCommit(repository, commit);
  const paths = parseTreeEntries(runGit(repository, [
    "ls-tree",
    "-z",
    "--full-tree",
    tree,
    "--",
    GIT_FORMAT_PATH,
    ...requestedPaths,
  ]));
  validateGitFormat(repository, paths);
  return { commit, tree, paths };
}

/** Add paths from the same immutable Git tree without rereading its ref. */
export function extendGitPaths(
  repository: GitRepository,
  snapshot: GitSnapshot,
  requestedPaths: readonly string[],
): GitSnapshot {
  for (const path of requestedPaths) validPath(path);
  if (snapshot.tree === null || requestedPaths.length === 0) return snapshot;
  const additions = parseTreeEntries(runGit(repository, [
    "ls-tree",
    "-z",
    "--full-tree",
    snapshot.tree,
    "--",
    ...requestedPaths,
  ]));
  return { ...snapshot, paths: new Map([...snapshot.paths, ...additions]) };
}

export function writeBlob(repository: GitRepository, bytes: string | Uint8Array): GitOid {
  const oid = runGit(repository, ["hash-object", "-w", "--stdin"], bytes).toString("utf8").trim();
  assertOid(oid, "written blob");
  return oid;
}

export function readBlob(repository: GitRepository, oid: GitOid): Buffer {
  assertOid(oid, "blob");
  return runGit(repository, ["cat-file", "blob", oid]);
}

function malformedBatchOutput(detail: string): never {
  throw new GitPlumbingError({
    stderr: Buffer.alloc(0),
    status: null,
    message: `malformed cat-file --batch output: ${detail}`,
  });
}

type GitObject = Readonly<{ type: string; bytes: Buffer }>;

function readObjects(repository: GitRepository, oids: readonly GitOid[]): ReadonlyMap<GitOid, GitObject> {
  const unique = [...new Set(oids)];
  for (const oid of unique) assertOid(oid, "Git object");
  if (unique.length === 0) return new Map();

  const output = runGit(repository, ["cat-file", "--batch"], `${unique.join("\n")}\n`);
  const objects = new Map<GitOid, GitObject>();
  let offset = 0;
  for (const oid of unique) {
    const headerEnd = output.indexOf(0x0a, offset);
    if (headerEnd < 0) malformedBatchOutput(`missing header for ${oid}`);
    const fields = output.subarray(offset, headerEnd).toString("ascii").split(" ");
    offset = headerEnd + 1;
    if (fields.length === 2 && fields[0] === oid && fields[1] === "missing") {
      throw new GitPlumbingError({
        stderr: `missing Git object: ${oid}`,
        status: 1,
        message: `cat-file --batch: missing Git object ${oid}`,
      });
    }
    if (fields.length !== 3 || fields[0] !== oid || fields[1] === undefined || fields[2] === undefined) {
      malformedBatchOutput(`unexpected header for ${oid}`);
    }
    if (!/^(0|[1-9][0-9]*)$/.test(fields[2])) malformedBatchOutput(`invalid size for ${oid}`);
    const size = Number(fields[2]);
    if (!Number.isSafeInteger(size) || size < 0 || size > output.length - offset) {
      malformedBatchOutput(`invalid content length for ${oid}`);
    }
    const bytes = output.subarray(offset, offset + size);
    offset += size;
    if (output[offset] !== 0x0a) malformedBatchOutput(`missing content delimiter for ${oid}`);
    offset += 1;
    objects.set(oid, { type: fields[1], bytes });
  }
  if (offset !== output.length) malformedBatchOutput("trailing bytes");
  return objects;
}

/** Read immutable Git objects through one structured, length-delimited batch. */
export function readBlobs(repository: GitRepository, oids: readonly GitOid[]): ReadonlyMap<GitOid, Buffer> {
  const blobs = new Map<GitOid, Buffer>();
  for (const [oid, object] of readObjects(repository, oids)) {
    if (object.type !== "blob") malformedBatchOutput(`expected blob for ${oid}, found ${object.type}`);
    blobs.set(oid, object.bytes);
  }
  return blobs;
}

function validateGitFormat(repository: GitRepository, paths: ReadonlyMap<string, TreeEntry>): void {
  const format = paths.get(GIT_FORMAT_PATH);
  if (format === undefined) throw new AuthorityCorruptionError(`Git is missing ${GIT_FORMAT_PATH}`);
  if (format.type !== "blob") throw new AuthorityCorruptionError(`Git format is not a blob: ${GIT_FORMAT_PATH}`);
  const bytes = readBlob(repository, format.oid);
  if (bytes.toString("utf8") !== GIT_FORMAT_BYTES) {
    throw new AuthorityCorruptionError(`Git format is not current: ${GIT_FORMAT_PATH}`);
  }
}

function baseTreeEntries(
  repository: GitRepository,
  baseTree: GitOid | null,
  changedPaths: readonly string[],
  nodePaths: readonly string[],
): ReadonlyMap<string, Map<string, TreeEntry>> {
  const byPath = new Map<string, Map<string, TreeEntry>>();
  if (baseTree === null) return byPath;

  const ancestry = parseTreeEntries(runGit(repository, [
    "ls-tree",
    "-z",
    "-t",
    "-r",
    "--full-tree",
    baseTree,
    "--",
    ...changedPaths.map((path) => `:(literal)${path}`),
  ]));
  const treeByPath = new Map<string, GitOid>([["", baseTree]]);
  for (const path of nodePaths) {
    if (path.length === 0) continue;
    const entry = ancestry.get(path);
    if (entry === undefined) continue;
    if (entry.type !== "tree") throw new Error(`Git path is both file and directory: ${path}`);
    treeByPath.set(path, entry.oid);
  }

  const objects = readObjects(repository, [...treeByPath.values()]);
  const oidBytes = baseTree.length / 2;
  for (const [path, oid] of treeByPath) {
    const object = objects.get(oid);
    if (object === undefined || object.type !== "tree") {
      throw new GitPlumbingError({ stderr: oid, status: null, message: `Git tree is not a tree: ${path || "/"}` });
    }
    byPath.set(path, parseTreeObject(object.bytes, oidBytes));
  }
  return byPath;
}

function writePreparedTrees(repository: GitRepository, prepared: readonly PreparedTree[]): void {
  const output = runGit(repository, ["mktree", "--batch"], prepared.map(({ records }) => `${records}\n`).join(""));
  const written = output.toString("ascii").trimEnd().split("\n");
  if (written.length !== prepared.length) {
    throw new GitPlumbingError({ stderr: output, status: null, message: "malformed mktree --batch output" });
  }
  for (let index = 0; index < prepared.length; index += 1) {
    const expected = prepared[index]!.oid;
    const actual = written[index]!;
    assertOid(actual, "written tree");
    if (actual !== expected) {
      throw new GitPlumbingError({ stderr: output, status: null, message: `mktree wrote unexpected tree: ${actual}` });
    }
  }
}

/** Copy only the changed paths' tree ancestors, preserving untouched subtrees by object ID. */
export function updateGitTree(
  repository: GitRepository,
  baseTree: GitOid | null,
  changes: ReadonlyMap<string, TreeChange>,
): GitOid {
  const update = treeUpdate(changes);
  const bases = baseTreeEntries(repository, baseTree, [...changes.keys()], update.nodePaths);
  const representativeOid = baseTree ?? changes.values().next().value?.oid;
  if (representativeOid === undefined) throw new Error("cannot write an empty Git tree without an object format");
  const prepared = prepareTreeUpdate({ update, bases, oidBytes: representativeOid.length / 2 });
  writePreparedTrees(repository, prepared.trees);
  return prepared.root;
}

function writeCommitObject(input: Readonly<{
  repository: GitRepository;
  tree: GitOid;
  parents: readonly GitOid[];
  message: string;
  actor: string;
  email: string;
  at?: string;
}>): GitOid {
  const { repository, tree, parents, message, actor, email, at } = input;
  assertOid(tree, "commit tree");
  for (const parent of parents) assertOid(parent, "commit parent");
  const args = ["commit-tree", tree];
  for (const parent of parents) args.push("-p", parent);
  const commit = runGitWithEnvironment(
    repository,
    args,
    `${message}\n`,
    {
      GIT_AUTHOR_NAME: actor,
      GIT_AUTHOR_EMAIL: email,
      GIT_COMMITTER_NAME: actor,
      GIT_COMMITTER_EMAIL: email,
      ...(at === undefined ? {} : { GIT_AUTHOR_DATE: at, GIT_COMMITTER_DATE: at }),
    },
  )
    .toString("utf8")
    .trim();
  assertOid(commit, "written Git commit");
  return commit;
}

export function writeCommit(input: Readonly<{
  repository: GitRepository;
  tree: GitOid;
  parent: GitOid | null;
  message?: string;
  actor?: string;
  at?: string;
}>): GitOid {
  return writeCommitObject({
    repository: input.repository,
    tree: input.tree,
    parents: input.parent === null ? [] : [input.parent],
    message: input.message ?? "keiyaku facts transaction",
    actor: input.actor ?? "Keiyaku Git",
    email: "keiyaku@localhost",
    ...(input.at === undefined ? {} : { at: input.at }),
  });
}

export function updateRefsAtomically(
  repository: GitRepository,
  updates: readonly (
    | { readonly ref: typeof GIT_REF; readonly newOid: GitOid; readonly expectedOid: GitOid | null }
    | { readonly ref: string; readonly newOid: GitOid; readonly expectedOid: GitOid }
  )[],
): RefPublication {
  if (updates.length === 0) throw new Error("an atomic ref transaction needs a Git update");
  if (updates.length > 2) throw new Error("an atomic ref transaction accepts at most one target ref update");
  const git = updates[0];
  if (git === undefined || git.ref !== GIT_REF) {
    throw new Error(`the first atomic update must be the Git ref: ${GIT_REF}`);
  }
  const lines = ["start"];
  for (const [index, update] of updates.entries()) {
    assertRef(update.ref);
    if (index > 0 && update.ref === GIT_REF) {
      throw new Error(`duplicate ref update: ${update.ref}`);
    }
    if (index > 0 && (update.newOid === null || update.expectedOid === null)) {
      throw new Error("target ref updates require non-null OIDs");
    }
    assertOid(update.newOid, `new oid for ${update.ref}`);
    if (update.expectedOid !== null) assertOid(update.expectedOid, `expected oid for ${update.ref}`);
    const expectedOid = update.expectedOid ?? "0".repeat(update.newOid.length);
    lines.push(`update ${update.ref} ${update.newOid} ${expectedOid}`);
  }
  lines.push("prepare", "commit", "");
  try {
    runGit(repository, ["update-ref", "--stdin", "--no-deref"], lines.join("\n"));
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
