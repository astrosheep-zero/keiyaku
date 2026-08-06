import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { gitObjectId } from "./identity.js";

export const CARRIER_REF = "refs/heads/keiyaku-state";
export const CARRIER_FORMAT_PATH = "meta/format.json";
const CURRENT_FORMAT_VERSION = 1;
export const CARRIER_FORMAT_BYTES = `{"version":${CURRENT_FORMAT_VERSION}}\n`;

export type GitOid = string;

export type RefPublication =
  | Readonly<{ readonly kind: "published" }>
  | Readonly<{ readonly kind: "non-published"; readonly error: unknown }>
  | Readonly<{ readonly kind: "unknown" }>;

export interface GitRepository {
  /** The invocation's effective working directory, including a caller -C worktree. */
  readonly effectiveCwd: string;
  /** The canonical primary worktree root for this repository. */
  readonly primaryWorktree: string;
}

interface TreeEntry {
  readonly path: string;
  readonly mode: string;
  readonly type: "blob" | "commit" | "tree" | string;
  readonly oid: GitOid;
}

export interface CarrierSnapshot {
  readonly commit: GitOid | null;
  readonly tree: GitOid;
  readonly paths: ReadonlyMap<string, TreeEntry>;
}

export interface TreeChange {
  readonly oid: GitOid | null;
  readonly mode?: string;
  readonly type?: "blob" | "commit" | string;
}

export class GitPlumbingError extends Error {
  readonly command: readonly string[];
  readonly stderr: Buffer;
  readonly status: number | null;
  readonly pid: number | null;
  readonly signal: string | null;
  readonly code: string | number | null;

  constructor(input: Readonly<{
    command: readonly string[];
    stderr: string | Uint8Array;
    status: number | null;
    message: string;
    pid?: number | null;
    signal?: string | null;
    code?: string | number | null;
  }>) {
    super(input.message);
    this.name = "GitPlumbingError";
    this.command = input.command;
    this.stderr = Buffer.from(input.stderr);
    this.status = input.status;
    this.pid = input.pid ?? null;
    this.signal = input.signal ?? null;
    this.code = input.code ?? null;
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
      throw new TypeError("Git worktree porcelain output is missing a worktree path");
    }
    const path = worktree.slice("worktree ".length);
    if (path.length === 0) throw new TypeError("Git worktree porcelain output has an empty worktree path");
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
  if (paths.length === 0) throw new TypeError("Git worktree porcelain output has no worktrees");
  return paths;
}

export function registeredWorktreePaths(repository: GitRepository): readonly string[] {
  return worktreePathsFromPorcelain(runGit(repository, ["worktree", "list", "--porcelain", "-z"]));
}

export function repositoryAt(cwd: string): GitRepository {
  if (typeof cwd !== "string" || cwd.length === 0) {
    throw new TypeError("repository path must be a nonempty string");
  }
  const effectiveCwd = resolve(cwd);
  const provisional = { effectiveCwd, primaryWorktree: effectiveCwd } satisfies GitRepository;
  const primaryWorktree = registeredWorktreePaths(provisional)[0]!;
  return { effectiveCwd, primaryWorktree };
}

function commandError(command: readonly string[], error: unknown): GitPlumbingError {
  const candidate = error as {
    message?: string;
    stderr?: Buffer | string;
    status?: number | null;
    pid?: number;
    signal?: string | null;
    code?: string | number | null;
  };
  const stderr = candidate.stderr === undefined ? Buffer.alloc(0) : Buffer.from(candidate.stderr);
  const detail = stderr.length === 0 ? candidate.message ?? "git command failed" : stderr.toString("utf8");
  return new GitPlumbingError({
    command,
    stderr,
    status: candidate.status ?? null,
    message: `${command.join(" ")}: ${detail}`,
    pid: candidate.pid ?? null,
    signal: candidate.signal ?? null,
    code: candidate.code ?? null,
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

function runGitWithEnvironment(
  repository: GitRepository,
  args: readonly string[],
  input: string | Uint8Array,
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
    throw new TypeError(`invalid Git ref: ${ref}`);
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
  assertOid(commit, "carrier commit");
  const tree = runGit(repository, ["rev-parse", "--verify", `${commit}^{tree}`]).toString("utf8").trim();
  assertOid(tree, "carrier tree");
  return tree;
}

function readTreeEntries(repository: GitRepository, tree: GitOid): Map<string, TreeEntry> {
  assertOid(tree, "tree");
  const output = runGit(repository, ["ls-tree", "-r", "-z", "--full-tree", tree]);
  const entries = new Map<string, TreeEntry>();
  for (const record of output.toString("utf8").split("\0")) {
    if (record.length === 0) continue;
    const separator = record.indexOf("\t");
    if (separator < 0) throw new GitPlumbingError({ command: ["ls-tree"], stderr: record, status: null, message: `malformed ls-tree record: ${record}` });
    const [mode, type, oid] = record.slice(0, separator).split(" ");
    const path = record.slice(separator + 1);
    if (mode === undefined || type === undefined || oid === undefined || path.length === 0) {
      throw new GitPlumbingError({ command: ["ls-tree"], stderr: record, status: null, message: `malformed ls-tree record: ${record}` });
    }
    assertOid(oid, `tree entry ${path}`);
    entries.set(path, { path, mode, type, oid });
  }
  return entries;
}

export function readCarrier(repository: GitRepository): CarrierSnapshot {
  const commit = readRef(repository, CARRIER_REF);
  if (commit === null) {
    const tree = writeTree(repository, []);
    return { commit: null, tree, paths: new Map() };
  }
  const tree = readTreeForCommit(repository, commit);
  const paths = readTreeEntries(repository, tree);
  validateCarrierFormat(repository, paths);
  return { commit, tree, paths };
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
    command: ["cat-file", "--batch"],
    stderr: Buffer.alloc(0),
    status: null,
    message: `malformed cat-file --batch output: ${detail}`,
  });
}

/** Read immutable Git objects through one structured, length-delimited batch. */
export function readBlobs(repository: GitRepository, oids: readonly GitOid[]): ReadonlyMap<GitOid, Buffer> {
  const unique = [...new Set(oids)];
  for (const oid of unique) assertOid(oid, "blob");
  if (unique.length === 0) return new Map();

  const output = runGit(repository, ["cat-file", "--batch"], `${unique.join("\n")}\n`);
  const blobs = new Map<GitOid, Buffer>();
  let offset = 0;
  for (const oid of unique) {
    const headerEnd = output.indexOf(0x0a, offset);
    if (headerEnd < 0) malformedBatchOutput(`missing header for ${oid}`);
    const fields = output.subarray(offset, headerEnd).toString("ascii").split(" ");
    offset = headerEnd + 1;
    if (fields.length === 2 && fields[0] === oid && fields[1] === "missing") {
      throw new GitPlumbingError({
        command: ["cat-file", "blob", oid],
        stderr: `missing Git object: ${oid}`,
        status: 1,
        message: `cat-file blob ${oid}: missing Git object`,
      });
    }
    if (fields.length !== 3 || fields[0] !== oid || fields[1] !== "blob" || fields[2] === undefined) {
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
    blobs.set(oid, bytes);
  }
  if (offset !== output.length) malformedBatchOutput("trailing bytes");
  return blobs;
}

function validateCarrierFormat(repository: GitRepository, paths: ReadonlyMap<string, TreeEntry>): void {
  const format = paths.get(CARRIER_FORMAT_PATH);
  if (format === undefined) throw new TypeError(`carrier is missing ${CARRIER_FORMAT_PATH}`);
  if (format.type !== "blob") throw new TypeError(`carrier format is not a blob: ${CARRIER_FORMAT_PATH}`);
  const bytes = readBlob(repository, format.oid);
  if (bytes.toString("utf8") !== CARRIER_FORMAT_BYTES) {
    throw new TypeError(`carrier format is not current: ${CARRIER_FORMAT_PATH}`);
  }
}

interface MutableTreeNode {
  readonly files: Map<string, TreeChange>;
  readonly directories: Map<string, MutableTreeNode>;
}

function validPath(path: string): void {
  if (
    path.length === 0 ||
    path.startsWith("/") ||
    path.endsWith("/") ||
    path.includes("\0") ||
    path.split("/").some((part) => part.length === 0 || part === "." || part === "..")
  ) {
    throw new TypeError(`invalid carrier path: ${path}`);
  }
}

function addEntry(root: MutableTreeNode, path: string, change: TreeChange): void {
  validPath(path);
  const parts = path.split("/");
  let node = root;
  for (const part of parts.slice(0, -1)) {
    if (node.files.has(part)) throw new TypeError(`carrier path is both file and directory: ${path}`);
    let child = node.directories.get(part);
    if (child === undefined) {
      child = { files: new Map(), directories: new Map() };
      node.directories.set(part, child);
    }
    node = child;
  }
  const name = parts[parts.length - 1];
  if (name === undefined || node.directories.has(name)) {
    throw new TypeError(`carrier path is both file and directory: ${path}`);
  }
  node.files.set(name, change);
}

function treeRecord(name: string, change: TreeChange): string {
  if (change.oid === null) throw new TypeError(`deleted carrier path reached tree builder: ${name}`);
  assertOid(change.oid, `tree entry ${name}`);
  const mode = change.mode ?? "100644";
  const type = change.type ?? (mode === "160000" ? "commit" : "blob");
  return `${mode} ${type} ${change.oid}\t${name}\n`;
}

function buildTreeNode(repository: GitRepository, node: MutableTreeNode): GitOid {
  const records: string[] = [];
  for (const [name, change] of node.files) records.push(treeRecord(name, change));
  for (const [name, child] of node.directories) {
    const oid = buildTreeNode(repository, child);
    records.push(`040000 tree ${oid}\t${name}\n`);
  }
  records.sort((left, right) => Buffer.from(left).compare(Buffer.from(right)));
  return writeTree(repository, records);
}

function writeTree(repository: GitRepository, records: readonly string[]): GitOid {
  const tree = runGit(repository, ["mktree"], records.join(""));
  const oid = tree.toString("utf8").trim();
  assertOid(oid, "written tree");
  return oid;
}

export function buildTree(
  repository: GitRepository,
  baseTree: GitOid,
  changes: ReadonlyMap<string, TreeChange>,
): GitOid {
  const entries = readTreeEntries(repository, baseTree);
  for (const [path, change] of changes) {
    validPath(path);
    if (change.oid === null) {
      entries.delete(path);
      continue;
    }
    entries.set(path, {
      path,
      oid: change.oid,
      mode: change.mode ?? "100644",
      type: change.type ?? (change.mode === "160000" ? "commit" : "blob"),
    });
  }

  const root: MutableTreeNode = { files: new Map(), directories: new Map() };
  for (const [path, entry] of entries) addEntry(root, path, entry);
  return buildTreeNode(repository, root);
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
  assertOid(commit, "written carrier commit");
  return commit;
}

export function writeCommit(
  repository: GitRepository,
  tree: GitOid,
  parent: GitOid | null,
  message = "keiyaku facts transaction",
  options: Readonly<{
    actor?: string;
    at?: string;
    additionalParents?: readonly GitOid[];
  }> = {},
): GitOid {
  return writeCommitObject({
    repository,
    tree,
    parents: parent === null ? options.additionalParents ?? [] : [parent, ...(options.additionalParents ?? [])],
    message,
    actor: options.actor ?? "Keiyaku carrier",
    email: "keiyaku@localhost",
    ...(options.at === undefined ? {} : { at: options.at }),
  });
}

export function updateRefsAtomically(
  repository: GitRepository,
  updates: readonly (
    | { readonly ref: typeof CARRIER_REF; readonly newOid: GitOid; readonly expectedOid: GitOid | null }
    | { readonly ref: string; readonly newOid: GitOid; readonly expectedOid: GitOid }
  )[],
): RefPublication {
  if (updates.length === 0) throw new TypeError("an atomic ref transaction needs a carrier update");
  if (updates.length > 2) throw new TypeError("an atomic ref transaction accepts at most one target ref update");
  const carrier = updates[0];
  if (carrier === undefined || carrier.ref !== CARRIER_REF) {
    throw new TypeError(`the first atomic update must be the carrier ref: ${CARRIER_REF}`);
  }
  const lines = ["start"];
  for (const [index, update] of updates.entries()) {
    assertRef(update.ref);
    if (index > 0 && update.ref === CARRIER_REF) {
      throw new TypeError(`duplicate ref update: ${update.ref}`);
    }
    if (index > 0 && (update.newOid === null || update.expectedOid === null)) {
      throw new TypeError("target ref updates require non-null OIDs");
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
