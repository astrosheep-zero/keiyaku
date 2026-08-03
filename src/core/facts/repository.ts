import { execFileSync } from "node:child_process";
import { resolve } from "node:path";

export const CARRIER_REF = "refs/heads/keiyaku-state";
export const CARRIER_FORMAT_PATH = "meta/format.json";
export const CURRENT_FORMAT_VERSION = 1;
export const CARRIER_FORMAT_BYTES = `{"version":${CURRENT_FORMAT_VERSION}}\n`;

export type GitOid = string;

export interface GitRepository {
  readonly cwd: string;
}

export interface TreeEntry {
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
  readonly stderr: string;
  readonly status: number | null;
  readonly pid: number | null;
  readonly signal: string | null;
  readonly code: string | number | null;

  constructor(
    command: readonly string[],
    stderr: string,
    status: number | null,
    message: string,
    pid: number | null = null,
    signal: string | null = null,
    code: string | number | null = null,
  ) {
    super(message);
    this.name = "GitPlumbingError";
    this.command = command;
    this.stderr = stderr;
    this.status = status;
    this.pid = pid;
    this.signal = signal;
    this.code = code;
  }
}

export function repositoryAt(cwd: string = process.cwd()): GitRepository {
  return { cwd: resolve(cwd) };
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
  const stderr = candidate.stderr === undefined ? "" : Buffer.from(candidate.stderr).toString("utf8").trim();
  const detail = stderr.length === 0 ? candidate.message ?? "git command failed" : stderr;
  return new GitPlumbingError(
    command,
    stderr,
    candidate.status ?? null,
    `${command.join(" ")}: ${detail}`,
    candidate.pid ?? null,
    candidate.signal ?? null,
    candidate.code ?? null,
  );
}

export function runGit(repository: GitRepository, args: readonly string[], input?: string | Uint8Array): Buffer {
  try {
    const output = execFileSync("git", [...args], {
      cwd: repository.cwd,
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
      cwd: repository.cwd,
      input,
      env: { ...process.env, ...environment },
      stdio: ["pipe", "pipe", "pipe"],
    });
    return Buffer.isBuffer(output) ? output : Buffer.from(output);
  } catch (error) {
    throw commandError(args, error);
  }
}

function objectFormat(repository: GitRepository): "sha1" | "sha256" {
  const format = runGit(repository, ["rev-parse", "--show-object-format"]).toString("utf8").trim();
  if (format !== "sha1" && format !== "sha256") {
    throw new GitPlumbingError(["rev-parse", "--show-object-format"], format, null, `unsupported Git object format: ${format}`);
  }
  return format;
}

export function zeroOid(repository: GitRepository): GitOid {
  return "0".repeat(objectFormat(repository) === "sha256" ? 64 : 40);
}

function validOid(oid: string): boolean {
  return /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(oid);
}

function assertOid(oid: string, label: string): void {
  if (!validOid(oid)) {
    throw new TypeError(`${label} is not a Git object id: ${oid}`);
  }
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

export function readTreeEntries(repository: GitRepository, tree: GitOid): Map<string, TreeEntry> {
  assertOid(tree, "tree");
  const output = runGit(repository, ["ls-tree", "-r", "-z", "--full-tree", tree]);
  const entries = new Map<string, TreeEntry>();
  for (const record of output.toString("utf8").split("\0")) {
    if (record.length === 0) continue;
    const separator = record.indexOf("\t");
    if (separator < 0) throw new GitPlumbingError(["ls-tree"], record, null, `malformed ls-tree record: ${record}`);
    const [mode, type, oid] = record.slice(0, separator).split(" ");
    const path = record.slice(separator + 1);
    if (mode === undefined || type === undefined || oid === undefined || path.length === 0) {
      throw new GitPlumbingError(["ls-tree"], record, null, `malformed ls-tree record: ${record}`);
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

export function writeTree(repository: GitRepository, records: readonly string[]): GitOid {
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

export function writeCommit(
  repository: GitRepository,
  tree: GitOid,
  parent: GitOid | null,
  message = "keiyaku facts transaction",
): GitOid {
  assertOid(tree, "commit tree");
  if (parent !== null) assertOid(parent, "commit parent");
  const args = ["commit-tree", tree];
  if (parent !== null) args.push("-p", parent);
  const commit = runGitWithEnvironment(
    repository,
    args,
    `${message}\n`,
    {
      GIT_AUTHOR_NAME: "Keiyaku",
      GIT_AUTHOR_EMAIL: "keiyaku@localhost",
      GIT_COMMITTER_NAME: "Keiyaku",
      GIT_COMMITTER_EMAIL: "keiyaku@localhost",
    },
  )
    .toString("utf8")
    .trim();
  assertOid(commit, "written carrier commit");
  return commit;
}

export function updateRefsAtomically(
  repository: GitRepository,
  updates: readonly { readonly ref: string; readonly newOid: GitOid | null; readonly expectedOid: GitOid | null }[],
): void {
  if (updates.length === 0) throw new TypeError("an atomic ref transaction needs at least one update");
  const seen = new Set<string>();
  const zero = zeroOid(repository);
  const lines = ["start"];
  for (const update of updates) {
    assertRef(update.ref);
    if (seen.has(update.ref)) throw new TypeError(`duplicate ref update: ${update.ref}`);
    seen.add(update.ref);
    if (update.newOid !== null) assertOid(update.newOid, `new oid for ${update.ref}`);
    if (update.expectedOid !== null) assertOid(update.expectedOid, `expected oid for ${update.ref}`);
    const newOid = update.newOid ?? zero;
    const expectedOid = update.expectedOid ?? zero;
    lines.push(`update ${update.ref} ${newOid} ${expectedOid}`);
  }
  lines.push("prepare", "commit", "");
  runGit(repository, ["update-ref", "--stdin", "--no-deref"], lines.join("\n"));
}
