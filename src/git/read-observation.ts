import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { AuthorityCorruptionError } from "../core/facts/errors.js";
import { spawnCancellableProcess } from "../runtime/proc/run.js";
import { gitObjectId } from "./identity.js";
import { parseTreeObject, validPath, type TreeEntry } from "./tree.js";
import { GIT_FORMAT_BYTES, GIT_FORMAT_PATH, GIT_REF, readRef, type GitOid, type GitSnapshot } from "./repository.js";
import { GitPlumbingError, type GitRepository } from "./process.js";

const gitReadObservationBrand: unique symbol = Symbol("GitReadObservation");
const gitDecodeChannelBrand: unique symbol = Symbol("GitDecodeChannel");

export type GitBlobResult = Readonly<{ kind: "present"; bytes: Buffer }> | Readonly<{ kind: "missing" }>;

export type GitReadObservation = Readonly<{
  readonly [gitReadObservationBrand]: true;
  repository: GitRepository;
  snapshot: GitSnapshot;
  treeDirectories: ReadonlyMap<string, ReadonlyMap<string, TreeEntry>>;
  readBlobs(oids: readonly GitOid[]): Promise<ReadonlyMap<GitOid, GitBlobResult>>;
  resolveRef(ref: string): Promise<GitOid | null>;
}>;

export type GitObjectResult =
  | Readonly<{ kind: "present"; type: string; bytes: Buffer }>
  | Readonly<{ kind: "missing" }>;

export type GitDecodeChannel = Readonly<{
  readonly [gitDecodeChannelBrand]: true;
  readObjects(oids: readonly GitOid[]): Promise<ReadonlyMap<GitOid, GitObjectResult>>;
}>;

type StreamCursor = Readonly<{
  line(): Promise<Buffer>;
  exact(length: number): Promise<Buffer>;
}>;

function streamCursor(stream: NodeJS.ReadableStream): StreamCursor {
  const iterator = (stream as NodeJS.ReadableStream & AsyncIterable<string | Buffer>)[Symbol.asyncIterator]();
  let buffer = Buffer.alloc(0);
  const pull = async (expected: string): Promise<void> => {
    const next = await iterator.next();
    if (next.done) throw new Error(`git cat-file --batch ended while reading ${expected}`);
    const chunk = Buffer.from(next.value);
    buffer = buffer.length === 0 ? chunk : Buffer.concat([buffer, chunk]);
  };
  const line = async (): Promise<Buffer> => {
    for (;;) {
      const newline = buffer.indexOf(0x0a);
      if (newline >= 0) {
        const value = buffer.subarray(0, newline);
        buffer = buffer.subarray(newline + 1);
        return value;
      }
      await pull("line");
    }
  };
  const exact = async (length: number): Promise<Buffer> => {
    while (buffer.length < length) await pull(`${length} bytes`);
    const value = buffer.subarray(0, length);
    buffer = buffer.subarray(length);
    return value;
  };
  return { line, exact };
}

type BatchObjectReader = Readonly<{
  objects(oids: readonly GitOid[]): Promise<ReadonlyMap<GitOid, GitObjectResult>>;
  close(): Promise<void>;
}>;

async function batchObjects(
  oids: readonly GitOid[],
  object: (oid: GitOid) => Promise<GitObjectResult>,
): Promise<ReadonlyMap<GitOid, GitObjectResult>> {
  const unique = [...new Set(oids)];
  for (const oid of unique) gitObjectId(oid, "Git object");
  const entries = await Promise.all(unique.map(async (oid) => [oid, await object(oid)] as const));
  return new Map(entries);
}

function batchChild(repository: GitRepository) {
  return spawnCancellableProcess({
    argv: [repository.gitPath, "cat-file", "--batch"],
    cwd: repository.effectiveCwd,
    ...(repository.signal === undefined ? {} : { signal: repository.signal }),
  });
}

function batchError(
  child: ChildProcessWithoutNullStreams,
  stderr: readonly Buffer[],
  message: string,
  status: number | null,
): GitPlumbingError {
  return new GitPlumbingError({
    stderr: Buffer.concat(stderr),
    status,
    message: `git cat-file --batch: ${message}`,
    pid: child.pid ?? null,
  });
}

async function closeBatchProcess(
  process: ReturnType<typeof spawnCancellableProcess>,
  child: ChildProcessWithoutNullStreams,
  closed: Promise<Readonly<{ code: number | null; signal: NodeJS.Signals | null }>>,
  spawnError: Error | null,
  stderr: readonly Buffer[],
): Promise<void> {
  if (!child.stdin.destroyed) child.stdin.end();
  const outcome = await Promise.race([closed, process.terminationFailure]);
  await process.waitTermination();
  if (spawnError !== null || outcome.code !== 0) {
    throw batchError(
      child,
      stderr,
      process.cancelled() ? "git process cancelled" : "git cat-file --batch did not close cleanly",
      outcome.code,
    );
  }
}

function batchObjectReader(repository: GitRepository): BatchObjectReader {
  const process = batchChild(repository);
  const child = process.child as ChildProcessWithoutNullStreams;
  const cursor = streamCursor(child.stdout);
  const cache = new Map<GitOid, Promise<GitObjectResult>>();
  const stderr: Buffer[] = [];
  const closed = new Promise<Readonly<{ code: number | null; signal: NodeJS.Signals | null }>>((resolve) => {
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
  let tail: Promise<void> = Promise.resolve();
  let spawnError: Error | null = null;
  let failure: GitPlumbingError | null = null;
  child.stderr.on("data", (chunk: Buffer) => stderr.push(Buffer.from(chunk)));
  child.on("error", (error) => {
    spawnError = error;
  });
  child.stdin.on("error", (error) => {
    spawnError ??= error;
  });

  const write = async (value: string): Promise<void> => {
    if (spawnError !== null) throw spawnError;
    await new Promise<void>((resolve, reject) => {
      child.stdin.write(value, (error) => (error === null || error === undefined ? resolve() : reject(error)));
    });
  };
  const read = async (oid: GitOid): Promise<GitObjectResult> => {
    if (failure !== null) throw failure;
    try {
      await write(`${oid}\n`);
      const header = (await cursor.line()).toString("ascii").split(" ");
      if (header.length === 2 && header[0] === oid && header[1] === "missing") return { kind: "missing" };
      if (header.length !== 3 || header[0] !== oid || header[1] === undefined || header[2] === undefined) {
        throw new Error(`unexpected header for ${oid}`);
      }
      if (!/^(0|[1-9][0-9]*)$/.test(header[2])) throw new Error(`invalid size for ${oid}`);
      const size = Number(header[2]);
      if (!Number.isSafeInteger(size)) throw new Error(`unsafe size for ${oid}`);
      const bytes = await cursor.exact(size);
      const delimiter = await cursor.exact(1);
      if (delimiter[0] !== 0x0a) throw new Error(`missing content delimiter for ${oid}`);
      return { kind: "present", type: header[1], bytes };
    } catch (error) {
      if (failure !== null) throw failure;
      await process.terminate(true);
      await closed;
      await process.waitTermination();
      failure = batchError(
        child,
        stderr,
        process.cancelled() ? "git process cancelled" : error instanceof Error ? error.message : String(error),
        process.cancelled() ? null : child.exitCode,
      );
      throw failure;
    }
  };
  const object = (oid: GitOid): Promise<GitObjectResult> => {
    const cached = cache.get(oid);
    if (cached !== undefined) return cached;
    const requested = tail.then(async () => await read(oid));
    tail = requested.then(
      () => undefined,
      () => undefined,
    );
    cache.set(oid, requested);
    return requested;
  };
  const objects = (oids: readonly GitOid[]) => batchObjects(oids, object);
  const close = async (): Promise<void> => {
    await tail.catch(() => undefined);
    if (failure !== null) {
      await process.waitTermination();
      return;
    }
    await closeBatchProcess(process, child, closed, spawnError, stderr);
  };
  return { objects, close };
}

function commitTree(result: GitObjectResult, commit: GitOid): GitOid {
  if (result.kind === "missing") throw new AuthorityCorruptionError(`Git state commit is missing: ${commit}`);
  if (result.type !== "commit") throw new AuthorityCorruptionError(`Git state ref does not name a commit: ${commit}`);
  const newline = result.bytes.indexOf(0x0a);
  if (newline < 0) throw new AuthorityCorruptionError(`Git state commit has no headers: ${commit}`);
  const firstLine = result.bytes.subarray(0, newline).toString("ascii");
  if (!firstLine.startsWith("tree "))
    throw new AuthorityCorruptionError(`Git state commit has no root tree: ${commit}`);
  return gitObjectId(firstLine.slice("tree ".length), "Git state tree");
}

async function completeTree(
  channel: GitDecodeChannel,
  root: GitOid,
): Promise<
  Readonly<{
    paths: ReadonlyMap<string, TreeEntry>;
    directories: ReadonlyMap<string, ReadonlyMap<string, TreeEntry>>;
  }>
> {
  const paths = new Map<string, TreeEntry>();
  const directories = new Map<string, ReadonlyMap<string, TreeEntry>>();
  let level = [{ path: "", oid: root }];
  while (level.length > 0) {
    const objects = await channel.readObjects(level.map(({ oid }) => oid));
    const next: Array<{ path: string; oid: GitOid }> = [];
    for (const tree of level) {
      const object = objects.get(tree.oid);
      if (object?.kind !== "present") throw new AuthorityCorruptionError(`Git tree is missing: ${tree.oid}`);
      if (object.type !== "tree") throw new AuthorityCorruptionError(`Git object is not a tree: ${tree.oid}`);
      const entries = parseTreeObject(object.bytes, tree.oid.length / 2);
      directories.set(tree.path, entries);
      for (const [name, entry] of entries) {
        const path = tree.path.length === 0 ? name : `${tree.path}/${name}`;
        if (entry.type === "tree") next.push({ path, oid: entry.oid });
        else paths.set(path, entry);
      }
    }
    level = next;
  }
  return { paths, directories };
}

type TreeSelectionNode = {
  exact: boolean;
  subtree: boolean;
  children: Map<string, TreeSelectionNode>;
};

export type GitTreeSelection = Readonly<{
  paths?: readonly string[];
  subtrees?: readonly string[];
}>;

function selectionTree(selection: GitTreeSelection): TreeSelectionNode {
  const root: TreeSelectionNode = { exact: false, subtree: false, children: new Map() };
  const add = (path: string, kind: "exact" | "subtree"): void => {
    validPath(path);
    let node = root;
    for (const segment of path.split("/")) {
      let child = node.children.get(segment);
      if (child === undefined) {
        child = { exact: false, subtree: false, children: new Map() };
        node.children.set(segment, child);
      }
      node = child;
    }
    node[kind] = true;
  };
  add(GIT_FORMAT_PATH, "exact");
  for (const path of selection.paths ?? []) add(path, "exact");
  for (const path of selection.subtrees ?? []) add(path, "subtree");
  return root;
}

export async function readGitTreeSelection(
  channel: GitDecodeChannel,
  root: GitOid,
  selection: GitTreeSelection,
): Promise<
  Readonly<{
    paths: ReadonlyMap<string, TreeEntry>;
    directories: ReadonlyMap<string, ReadonlyMap<string, TreeEntry>>;
  }>
> {
  const paths = new Map<string, TreeEntry>();
  const directories = new Map<string, ReadonlyMap<string, TreeEntry>>();
  const readDirectory = async (path: string, oid: GitOid): Promise<ReadonlyMap<string, TreeEntry>> => {
    const object = (await channel.readObjects([oid])).get(oid);
    if (object?.kind !== "present") throw new AuthorityCorruptionError(`Git tree is missing: ${oid}`);
    if (object.type !== "tree") throw new AuthorityCorruptionError(`Git object is not a tree: ${oid}`);
    const entries = parseTreeObject(object.bytes, oid.length / 2);
    directories.set(path, entries);
    return entries;
  };
  const enumerate = async (path: string, oid: GitOid): Promise<void> => {
    const entries = await readDirectory(path, oid);
    await Promise.all(
      [...entries].map(async ([name, entry]) => {
        const childPath = path.length === 0 ? name : `${path}/${name}`;
        if (entry.type === "tree") await enumerate(childPath, entry.oid);
        else paths.set(childPath, entry);
      }),
    );
  };
  const visit = async (path: string, oid: GitOid, node: TreeSelectionNode): Promise<void> => {
    const entries = await readDirectory(path, oid);
    await Promise.all(
      [...node.children].map(async ([name, child]) => {
        const entry = entries.get(name);
        if (entry === undefined) return;
        const childPath = path.length === 0 ? name : `${path}/${name}`;
        if (entry.type !== "tree") {
          paths.set(childPath, entry);
          return;
        }
        if (child.exact || child.subtree) paths.set(childPath, entry);
        if (child.exact && child.children.size === 0 && !child.subtree) {
          paths.set(childPath, entry);
          return;
        }
        if (child.subtree) await enumerate(childPath, entry.oid);
        else if (child.children.size > 0) await visit(childPath, entry.oid, child);
      }),
    );
  };
  await visit("", root, selectionTree(selection));
  return { paths, directories };
}

async function readFormat(observation: GitReadObservation): Promise<void> {
  const entry = observation.snapshot.paths.get(GIT_FORMAT_PATH);
  if (entry === undefined) throw new AuthorityCorruptionError(`Git is missing ${GIT_FORMAT_PATH}`);
  if (entry.type !== "blob") throw new AuthorityCorruptionError(`Git format is not a blob: ${GIT_FORMAT_PATH}`);
  const result = (await observation.readBlobs([entry.oid])).get(entry.oid);
  if (result?.kind !== "present" || result.bytes.toString("utf8") !== GIT_FORMAT_BYTES) {
    throw new AuthorityCorruptionError(`Git format is not current: ${GIT_FORMAT_PATH}`);
  }
}

export async function withGitDecodeChannel<Value>(
  repository: GitRepository,
  consume: (channel: GitDecodeChannel) => Value | PromiseLike<Value>,
): Promise<Value> {
  const transport: { reader: BatchObjectReader | null } = { reader: null };
  let active = true;
  const objectReader = (): BatchObjectReader => (transport.reader ??= batchObjectReader(repository));
  const channel = {
    [gitDecodeChannelBrand]: true,
    readObjects: (oids: readonly GitOid[]) => {
      if (!active) throw new Error("Git decode channel is closed");
      return oids.length === 0 ? Promise.resolve(new Map()) : objectReader().objects(oids);
    },
  } satisfies GitDecodeChannel;

  let result: Value | undefined;
  let failure: unknown;
  try {
    result = await consume(channel);
  } catch (error) {
    failure = error;
  }
  active = false;
  try {
    if (transport.reader !== null) await transport.reader.close();
  } catch (error) {
    failure ??= error;
  }
  if (failure !== undefined) throw failure;
  return result as Value;
}

async function observeEpoch<Value>(
  repository: GitRepository,
  channel: GitDecodeChannel,
  selection: GitTreeSelection | null,
  consume: (observation: GitReadObservation) => Value | PromiseLike<Value>,
): Promise<Value> {
  const commit = await readRef(repository, GIT_REF);
  let active = true;
  const refs = new Map<string, Promise<GitOid | null>>();
  const assertActive = (): void => {
    if (!active) throw new Error("Git read observation is closed");
  };
  const resolveRef = async (ref: string): Promise<GitOid | null> => {
    assertActive();
    let resolved = refs.get(ref);
    if (resolved === undefined) {
      resolved = readRef(repository, ref);
      refs.set(ref, resolved);
    }
    return await resolved;
  };
  const readBlobResults = async (oids: readonly GitOid[]): Promise<ReadonlyMap<GitOid, GitBlobResult>> => {
    assertActive();
    if (oids.length === 0) return new Map();
    const objects = await channel.readObjects(oids);
    const blobs = new Map<GitOid, GitBlobResult>();
    for (const [oid, object] of objects) {
      if (object.kind === "missing") blobs.set(oid, object);
      else {
        if (object.type !== "blob") throw new AuthorityCorruptionError(`Git object is not a blob: ${oid}`);
        blobs.set(oid, { kind: "present", bytes: object.bytes });
      }
    }
    return blobs;
  };

  let result: Value | undefined;
  let failure: unknown;
  try {
    let snapshot: GitSnapshot;
    let treeDirectories: ReadonlyMap<string, ReadonlyMap<string, TreeEntry>>;
    if (commit === null) {
      snapshot = { commit: null, tree: null, paths: new Map() };
      treeDirectories = new Map();
    } else {
      const commitObject = (await channel.readObjects([commit])).get(commit);
      if (commitObject === undefined) throw new Error(`missing state commit result: ${commit}`);
      const tree = await commitTree(commitObject, commit);
      const observed =
        selection === null ? await completeTree(channel, tree) : await readGitTreeSelection(channel, tree, selection);
      snapshot = { commit, tree, paths: observed.paths };
      treeDirectories = observed.directories;
    }
    const observation = {
      [gitReadObservationBrand]: true,
      repository,
      snapshot,
      treeDirectories,
      readBlobs: readBlobResults,
      resolveRef,
    } satisfies GitReadObservation;
    if (commit !== null) await readFormat(observation);
    result = await consume(observation);
  } catch (error) {
    failure = error;
  }
  active = false;
  if (failure !== undefined) throw failure;
  return result as Value;
}

export async function withGitReadObservation<Value>(
  repository: GitRepository,
  channel: GitDecodeChannel,
  consume: (observation: GitReadObservation) => Value | PromiseLike<Value>,
): Promise<Value> {
  return await observeEpoch(repository, channel, null, consume);
}

export async function withGitTargetedReadObservation<Value>(
  repository: GitRepository,
  channel: GitDecodeChannel,
  selection: GitTreeSelection,
  consume: (observation: GitReadObservation) => Value | PromiseLike<Value>,
): Promise<Value> {
  return await observeEpoch(repository, channel, selection, consume);
}
