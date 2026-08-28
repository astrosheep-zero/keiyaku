/* eslint-disable max-lines */
import { isAbsolute, resolve } from "node:path";
import { AuthorityCorruptionError } from "../core/facts/errors.js";
import { gitObjectId } from "./identity.js";
import { GitPlumbingError, runGit, runGitWithEnvironment, type GitRepository } from "./process.js";
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
export const MIGRATION_DELIVERY_REF_NAMESPACE = "refs/keiyaku/delivery";
export const MIGRATION_CANDIDATE_PIN_REF_NAMESPACE = "refs/keiyaku/candidate";
export const GIT_FORMAT_PATH = "meta/format.json";
const CURRENT_FORMAT_VERSION = 4;
export const GIT_FORMAT_BYTES = `{"version":${CURRENT_FORMAT_VERSION}}\n`;
export const STATE_COMMIT_SUBJECT = "keiyaku authority - do not delete or rewrite";
export function isKeiyakuOwnedRef(ref: string): boolean {
  return (
    ref === GIT_REF ||
    ref === DELIVERY_REF_NAMESPACE ||
    ref.startsWith(`${DELIVERY_REF_NAMESPACE}/`) ||
    ref === CANDIDATE_PIN_REF_NAMESPACE ||
    ref.startsWith(`${CANDIDATE_PIN_REF_NAMESPACE}/`) ||
    ref === MIGRATION_DELIVERY_REF_NAMESPACE ||
    ref.startsWith(`${MIGRATION_DELIVERY_REF_NAMESPACE}/`) ||
    ref === MIGRATION_CANDIDATE_PIN_REF_NAMESPACE ||
    ref.startsWith(`${MIGRATION_CANDIDATE_PIN_REF_NAMESPACE}/`)
  );
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
export class NoGitWorldError extends Error {
  readonly path: string;

  constructor(path: string) {
    super(`no Git world at: ${path}`);
    this.name = "NoGitWorldError";
    this.path = path;
  }
}
export type RegisteredWorktree = Readonly<{ path: string; branch: string | null }>;

function worktreesFromPorcelain(output: Buffer): readonly RegisteredWorktree[] {
  const fields = output.toString("utf8").split("\0");
  const worktrees: RegisteredWorktree[] = [];
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
    worktrees.push({ path: resolve(path), branch });
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
  return worktreesFromPorcelain(await runGit(repository, ["worktree", "list", "--porcelain", "-z"]));
}

export async function registeredWorktreePaths(repository: GitRepository): Promise<readonly string[]> {
  return (await registeredWorktrees(repository)).map((worktree) => worktree.path);
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
  const value = (await runGit(repository, ["rev-parse", "--path-format=absolute", ...args])).toString("utf8").trim();
  if (value.length === 0) throw new Error(`${label} is empty`);
  return resolve(isAbsolute(value) ? value : resolve(repository.effectiveCwd, value));
}

export function commonGitDirectory(repository: GitRepository): string {
  return repository.commonDirectory;
}

export async function worktreeGitDirectory(repository: GitRepository, worktree: string): Promise<string> {
  const scoped = { ...repository, effectiveCwd: worktree };
  return await absoluteGitPath(scoped, ["--git-dir"], "worktree Git directory");
}

export async function worktreeRoot(repository: GitRepository): Promise<string> {
  return await absoluteGitPath(repository, ["--show-toplevel"], "worktree root");
}

function assertRef(ref: string): void {
  if (!ref.startsWith("refs/") || /[\s\0]/.test(ref) || ref.endsWith("/") || ref.includes("..")) {
    throw new Error(`invalid Git ref: ${ref}`);
  }
}
function assertAssertionRef(ref: string): void {
  if (ref !== "HEAD") assertRef(ref);
}
export async function readRef(repository: GitRepository, ref: string): Promise<GitOid | null> {
  assertAssertionRef(ref);
  try {
    const oid = (await runGit(repository, ["rev-parse", "--verify", "--quiet", ref])).toString("utf8").trim();
    return oid.length === 0 ? null : gitObjectId(oid, `ref ${ref}`);
  } catch (error) {
    if (error instanceof GitPlumbingError && error.status === 1) return null;
    throw error;
  }
}

/** Read an explicit set of asserted refs from one fresh Git observation. */
export async function readRefs(repository: GitRepository, refs: readonly string[]) {
  const refsToRead = [...new Set(refs)];
  for (const ref of refsToRead) assertAssertionRef(ref);
  if (refsToRead.length === 0) return new Map();
  const output = (
    await runGit(repository, ["cat-file", "--batch-check=%(objectname)"], `${refsToRead.join("\n")}\n`)
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

async function readTreeForCommit(repository: GitRepository, commit: GitOid): Promise<GitOid> {
  gitObjectId(commit, "Git commit");
  const tree = (await runGit(repository, ["show", "-s", "--format=%T", commit])).toString("utf8").trim();
  gitObjectId(tree, "Git tree");
  return tree;
}

function parseTreeEntries(output: Buffer): Map<string, TreeEntry> {
  const entries = new Map<string, TreeEntry>();
  for (const record of output.toString("utf8").split("\0")) {
    if (record.length === 0) continue;
    const separator = record.indexOf("\t");
    if (separator < 0)
      throw new GitPlumbingError({ stderr: record, status: null, message: `malformed ls-tree record: ${record}` });
    const [mode, type, oid] = record.slice(0, separator).split(" ");
    const path = record.slice(separator + 1);
    if (mode === undefined || type === undefined || oid === undefined || path.length === 0) {
      throw new GitPlumbingError({ stderr: record, status: null, message: `malformed ls-tree record: ${record}` });
    }
    gitObjectId(oid, `tree entry ${path}`);
    entries.set(path, { mode, type, oid });
  }
  return entries;
}

export async function readTreeEntries(repository: GitRepository, tree: GitOid): Promise<Map<string, TreeEntry>> {
  gitObjectId(tree, "tree");
  const output = await runGit(repository, ["ls-tree", "-r", "-z", "--full-tree", tree]);
  return parseTreeEntries(output);
}

export async function readGit(repository: GitRepository): Promise<GitSnapshot> {
  const commit = await readRef(repository, GIT_REF);
  if (commit === null) {
    return { commit: null, tree: null, paths: new Map() };
  }
  const tree = await readTreeForCommit(repository, commit);
  const paths = await readTreeEntries(repository, tree);
  await validateGitFormat(repository, paths);
  return { commit, tree, paths };
}

/** Read only the requested private Git paths from one immutable Git tree. */
export async function readGitPaths(repository: GitRepository, requestedPaths: readonly string[]): Promise<GitSnapshot> {
  for (const path of requestedPaths) validPath(path);
  const commit = await readRef(repository, GIT_REF);
  if (commit === null) return { commit: null, tree: null, paths: new Map() };

  const tree = await readTreeForCommit(repository, commit);
  const paths = parseTreeEntries(
    await runGit(repository, ["ls-tree", "-z", "--full-tree", tree, "--", GIT_FORMAT_PATH, ...requestedPaths]),
  );
  await validateGitFormat(repository, paths);
  return { commit, tree, paths };
}

export async function writeBlob(repository: GitRepository, bytes: string | Uint8Array): Promise<GitOid> {
  const oid = (await runGit(repository, ["hash-object", "-w", "--stdin"], bytes)).toString("utf8").trim();
  gitObjectId(oid, "written blob");
  return oid;
}

export async function readBlob(repository: GitRepository, oid: GitOid): Promise<Buffer> {
  gitObjectId(oid, "blob");
  return await runGit(repository, ["cat-file", "blob", oid]);
}

function malformedBatchOutput(detail: string): never {
  throw new GitPlumbingError({
    stderr: Buffer.alloc(0),
    status: null,
    message: `malformed cat-file --batch output: ${detail}`,
  });
}

type GitObject = Readonly<{ type: string; bytes: Buffer }>;

async function readObjects(
  repository: GitRepository,
  oids: readonly GitOid[],
): Promise<ReadonlyMap<GitOid, GitObject>> {
  const unique = [...new Set(oids)];
  for (const oid of unique) gitObjectId(oid, "Git object");
  if (unique.length === 0) return new Map();

  const output = await runGit(repository, ["cat-file", "--batch"], `${unique.join("\n")}\n`);
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

async function validateGitFormat(repository: GitRepository, paths: ReadonlyMap<string, TreeEntry>): Promise<void> {
  const format = paths.get(GIT_FORMAT_PATH);
  if (format === undefined) throw new AuthorityCorruptionError(`Git is missing ${GIT_FORMAT_PATH}`);
  if (format.type !== "blob") throw new AuthorityCorruptionError(`Git format is not a blob: ${GIT_FORMAT_PATH}`);
  const bytes = await readBlob(repository, format.oid);
  if (bytes.toString("utf8") !== GIT_FORMAT_BYTES) {
    throw new AuthorityCorruptionError(`Git format is not current: ${GIT_FORMAT_PATH}`);
  }
}

async function baseTreeEntries(
  repository: GitRepository,
  baseTree: GitOid | null,
  changedPaths: readonly string[],
  nodePaths: readonly string[],
): Promise<ReadonlyMap<string, Map<string, TreeEntry>>> {
  const byPath = new Map<string, Map<string, TreeEntry>>();
  if (baseTree === null) return byPath;

  const ancestry = parseTreeEntries(
    await runGit(repository, [
      "ls-tree",
      "-z",
      "-t",
      "-r",
      "--full-tree",
      baseTree,
      "--",
      ...changedPaths.map((path) => `:(literal)${path}`),
    ]),
  );
  const treeByPath = new Map<string, GitOid>([["", baseTree]]);
  for (const path of nodePaths) {
    if (path.length === 0) continue;
    const entry = ancestry.get(path);
    if (entry === undefined) continue;
    if (entry.type !== "tree") throw new Error(`Git path is both file and directory: ${path}`);
    treeByPath.set(path, entry.oid);
  }

  const objects = await readObjects(repository, [...treeByPath.values()]);
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

async function writePreparedTrees(repository: GitRepository, prepared: readonly PreparedTree[]): Promise<void> {
  const output = await runGit(
    repository,
    ["mktree", "--batch"],
    prepared.map(({ records }) => `${records}\n`).join(""),
  );
  const written = output.toString("ascii").trimEnd().split("\n");
  if (written.length !== prepared.length) {
    throw new GitPlumbingError({ stderr: output, status: null, message: "malformed mktree --batch output" });
  }
  for (let index = 0; index < prepared.length; index += 1) {
    const expected = prepared[index]!.oid;
    const actual = written[index]!;
    gitObjectId(actual, "written tree");
    if (actual !== expected) {
      throw new GitPlumbingError({ stderr: output, status: null, message: `mktree wrote unexpected tree: ${actual}` });
    }
  }
}

/** Copy only the changed paths' tree ancestors, preserving untouched subtrees by object ID. */
export async function updateGitTree(
  repository: GitRepository,
  baseTree: GitOid | null,
  changes: ReadonlyMap<string, TreeChange>,
): Promise<GitOid> {
  const update = treeUpdate(changes);
  const bases = await baseTreeEntries(repository, baseTree, [...changes.keys()], update.nodePaths);
  const representativeOid = baseTree ?? [...changes.values()].find((change) => change !== null)?.oid;
  if (representativeOid === undefined) throw new Error("cannot write an empty Git tree without an object format");
  const prepared = prepareTreeUpdate({ update, bases, oidBytes: representativeOid.length / 2 });
  await writePreparedTrees(repository, prepared.trees);
  return prepared.root;
}

/** Write a tree update from directory entries frozen with the admitted base tree. */
export async function updateGitTreeFromFrozenDirectories(
  repository: GitRepository,
  baseTree: GitOid | null,
  directories: ReadonlyMap<string, ReadonlyMap<string, TreeEntry>>,
  changes: ReadonlyMap<string, TreeChange>,
): Promise<GitOid> {
  const update = treeUpdate(changes);
  const representativeOid = baseTree ?? [...changes.values()].find((change) => change !== null)?.oid;
  if (representativeOid === undefined) throw new Error("cannot write an empty Git tree without an object format");
  const prepared = prepareTreeUpdate({
    update,
    bases: directories,
    oidBytes: representativeOid.length / 2,
  });
  await writePreparedTrees(repository, prepared.trees);
  return prepared.root;
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
    await runGitWithEnvironment(repository, args, `${message}\n`, {
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
  return `${assertion.ref === "HEAD" ? "" : "option no-deref\n"}verify ${assertion.ref} ${assertion.oid}`;
}

function refUpdateLine(
  update: { readonly ref: string; readonly newOid: GitOid; readonly expectedOid: GitOid | null },
  index: number,
): string {
  assertRef(update.ref);
  if (index > 0 && update.ref === GIT_REF) throw new Error(`duplicate ref update: ${update.ref}`);
  if (index > 0 && update.expectedOid === null) throw new Error("target ref updates require non-null OIDs");
  gitObjectId(update.newOid, `new oid for ${update.ref}`);
  if (update.expectedOid !== null) gitObjectId(update.expectedOid, `expected oid for ${update.ref}`);
  return `option no-deref\nupdate ${update.ref} ${update.newOid} ${update.expectedOid ?? "0".repeat(update.newOid.length)}`;
}

export async function updateRefsAtomically(
  repository: GitRepository,
  updates: readonly (
    | { readonly ref: typeof GIT_REF; readonly newOid: GitOid; readonly expectedOid: GitOid | null }
    | { readonly ref: string; readonly newOid: GitOid; readonly expectedOid: GitOid }
  )[],
  assertions: readonly GitRefAssertion[] = [],
): Promise<RefPublication> {
  if (updates.length === 0) throw new Error("an atomic ref transaction needs a Git update");
  if (updates.length > 2) throw new Error("an atomic ref transaction accepts at most one target ref update");
  const git = updates[0];
  if (git === undefined || git.ref !== GIT_REF) {
    throw new Error(`the first atomic update must be the Git ref: ${GIT_REF}`);
  }
  const lines = ["start", ...assertions.map(refAssertionLine), ...updates.map(refUpdateLine), "prepare", "commit", ""];
  try {
    await runGit(repository, ["update-ref", "--stdin"], lines.join("\n"));
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

export type GitDiffStat = Readonly<{ filesChanged: number; insertions: number; deletions: number }>;

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
