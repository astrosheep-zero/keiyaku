import { createHash } from "node:crypto";
import { gitObjectId } from "./identity.js";

export type TreeEntry = Readonly<{ mode: string; type: string; oid: string }>;
export type TreeChange = Readonly<{ oid: string; mode?: string; type?: string }> | null;

type MutableTreeNode = Readonly<{ files: Map<string, TreeChange>; directories: Map<string, MutableTreeNode> }>;

type TreeUpdate = Readonly<{
  root: MutableTreeNode;
  nodePaths: readonly string[];
}>;

export type PreparedTree = Readonly<{ oid: string; records: string }>;

export function validPath(path: string): void {
  if (
    path.length === 0 ||
    path.startsWith("/") ||
    path.endsWith("/") ||
    path.includes("\0") ||
    path.split("/").some((part) => part.length === 0 || part === "." || part === "..")
  )
    throw new Error(`invalid Git path: ${path}`);
}

function addEntry(root: MutableTreeNode, path: string, change: TreeChange): void {
  validPath(path);
  const parts = path.split("/");
  let node = root;
  for (const part of parts.slice(0, -1)) {
    if (node.files.has(part)) throw new Error(`Git path is both file and directory: ${path}`);
    let child = node.directories.get(part);
    if (child === undefined) {
      child = { files: new Map(), directories: new Map() };
      node.directories.set(part, child);
    }
    node = child;
  }
  const name = parts.at(-1);
  if (name === undefined || node.directories.has(name)) {
    throw new Error(`Git path is both file and directory: ${path}`);
  }
  node.files.set(name, change);
}

function nodePaths(node: MutableTreeNode, path = "", result: string[] = []): readonly string[] {
  result.push(path);
  for (const [name, child] of node.directories) {
    nodePaths(child, path.length === 0 ? name : `${path}/${name}`, result);
  }
  return result;
}

export function treeUpdate(changes: ReadonlyMap<string, TreeChange>): TreeUpdate {
  const root: MutableTreeNode = { files: new Map(), directories: new Map() };
  for (const [path, change] of changes) addEntry(root, path, change);
  return { root, nodePaths: nodePaths(root) };
}

function entryType(mode: string): string {
  return mode === "040000" || mode === "40000" ? "tree" : mode === "160000" ? "commit" : "blob";
}

export function parseTreeObject(bytes: Buffer, oidBytes: number): Map<string, TreeEntry> {
  const entries = new Map<string, TreeEntry>();
  let offset = 0;
  while (offset < bytes.length) {
    const modeEnd = bytes.indexOf(0x20, offset);
    const nameEnd = modeEnd < 0 ? -1 : bytes.indexOf(0, modeEnd + 1);
    if (modeEnd < 0 || nameEnd < 0 || nameEnd + 1 + oidBytes > bytes.length) {
      throw new Error("malformed Git tree object");
    }
    const rawMode = bytes.subarray(offset, modeEnd).toString("ascii");
    const mode = rawMode === "40000" ? "040000" : rawMode;
    const name = bytes.subarray(modeEnd + 1, nameEnd).toString("utf8");
    if (name.length === 0 || entries.has(name)) throw new Error("malformed Git tree object");
    const oid = bytes.subarray(nameEnd + 1, nameEnd + 1 + oidBytes).toString("hex");
    gitObjectId(oid, `tree entry ${name}`);
    entries.set(name, { mode, type: entryType(mode), oid });
    offset = nameEnd + 1 + oidBytes;
  }
  return entries;
}

function sortName(name: string, type: string): Buffer {
  return Buffer.concat([Buffer.from(name), Buffer.from([type === "tree" ? 0x2f : 0])]);
}

function objectId(entries: ReadonlyMap<string, TreeEntry>, oidBytes: number): string {
  const sorted = [...entries].sort((left, right) =>
    sortName(left[0], left[1].type).compare(sortName(right[0], right[1].type)),
  );
  const parts = sorted.flatMap(([name, entry]) => [
    Buffer.from(`${entry.mode === "040000" ? "40000" : entry.mode} ${name}\0`),
    Buffer.from(entry.oid, "hex"),
  ]);
  const bytes = Buffer.concat(parts);
  const algorithm = oidBytes === 20 ? "sha1" : oidBytes === 32 ? "sha256" : null;
  if (algorithm === null) throw new Error(`unsupported Git object ID width: ${oidBytes * 2}`);
  return createHash(algorithm).update(`tree ${bytes.length}\0`).update(bytes).digest("hex");
}

function record(name: string, change: Exclude<TreeChange, null>): string {
  gitObjectId(change.oid, `tree entry ${name}`);
  const mode = change.mode ?? "100644";
  const type = change.type ?? (mode === "160000" ? "commit" : "blob");
  return `${mode} ${type} ${change.oid}\t${name}\n`;
}

function prepareNode(
  node: MutableTreeNode,
  path: string,
  bases: ReadonlyMap<string, ReadonlyMap<string, TreeEntry>>,
  oidBytes: number,
  prepared: PreparedTree[],
): string {
  const entries = new Map(bases.get(path) ?? []);
  for (const [name, change] of node.files) {
    if (change === null) {
      entries.delete(name);
      continue;
    }
    entries.set(name, {
      oid: change.oid,
      mode: change.mode ?? "100644",
      type: change.type ?? (change.mode === "160000" ? "commit" : "blob"),
    });
  }
  for (const [name, child] of node.directories) {
    const prior = entries.get(name);
    if (prior !== undefined && prior.type !== "tree") {
      throw new Error(`Git path is both file and directory: ${name}`);
    }
    const childPath = path.length === 0 ? name : `${path}/${name}`;
    const oid = prepareNode(child, childPath, bases, oidBytes, prepared);
    entries.set(name, { mode: "040000", type: "tree", oid });
  }
  const oid = objectId(entries, oidBytes);
  prepared.push({ oid, records: [...entries].map(([name, entry]) => record(name, entry)).join("") });
  return oid;
}

export function prepareTreeUpdate(
  input: Readonly<{
    update: TreeUpdate;
    bases: ReadonlyMap<string, ReadonlyMap<string, TreeEntry>>;
    oidBytes: number;
  }>,
): Readonly<{ root: string; trees: readonly PreparedTree[] }> {
  const trees: PreparedTree[] = [];
  const root = prepareNode(input.update.root, "", input.bases, input.oidBytes, trees);
  return { root, trees };
}
