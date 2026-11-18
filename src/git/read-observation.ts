import { AuthorityCorruptionError } from "../core/facts/errors.js";
import { gitObjectId } from "./identity.js";
import { parseTreeEntries, validPath, type TreeEntry } from "./tree.js";
import type { GitOid, GitSnapshot } from "./repository.js";
import { executeGit, GitPlumbingError, type GitRepository } from "./process.js";

export const GIT_REF = "refs/heads/keiyaku-state";
export const GIT_FORMAT_PATH = "meta/format.json";
const CURRENT_FORMAT_VERSION = 4;
export const GIT_FORMAT_BYTES = `{"version":${CURRENT_FORMAT_VERSION}}\n`;

export function assertRef(ref: string): void {
  const linkedWorktreeHead = /^worktrees\/(?!\.)(?![^/]*\.lock\/)(?![^/]*\.\.)[^/\s\0~^:?*\[\\]+\/HEAD$/u.test(ref);
  if (
    !linkedWorktreeHead &&
    (!ref.startsWith("refs/") || /[\s\0]/.test(ref) || ref.endsWith("/") || ref.includes(".."))
  )
    throw new Error(`invalid Git ref: ${ref}`);
}

export function assertAssertionRef(ref: string): void {
  if (ref !== "HEAD") assertRef(ref);
}

export async function readRef(repository: GitRepository, ref: string): Promise<GitOid | null> {
  assertAssertionRef(ref);
  try {
    const oid = (await executeGit(repository, ["rev-parse", "--verify", "--quiet", ref])).toString("utf8").trim();
    return oid.length === 0 ? null : gitObjectId(oid, `ref ${ref}`);
  } catch (error) {
    if (error instanceof GitPlumbingError && error.status === 1) return null;
    throw error;
  }
}

const gitReadObservationBrand: unique symbol = Symbol("GitReadObservation");
const gitDecodeChannelBrand: unique symbol = Symbol("GitDecodeChannel");

export type GitBlobResult = Readonly<{ kind: "present"; bytes: Buffer }> | Readonly<{ kind: "missing" }>;

export type GitReadObservation = Readonly<{
  readonly [gitReadObservationBrand]: true;
  repository: GitRepository;
  snapshot: GitSnapshot;
  selectPaths(paths: readonly string[]): Promise<GitSnapshot["paths"]>;
  readBlobs(oids: readonly GitOid[]): Promise<ReadonlyMap<GitOid, GitBlobResult>>;
  resolveRef(ref: string): Promise<GitOid | null>;
}>;

export type GitObjectResult =
  | Readonly<{ kind: "present"; type: string; bytes: Buffer }>
  | Readonly<{ kind: "missing" }>;

export type GitTreeSelection = Readonly<{
  paths?: readonly string[];
  subtrees?: readonly string[];
}>;

export type GitDecodeChannel = Readonly<{
  readonly [gitDecodeChannelBrand]: true;
  readObjects(oids: readonly GitOid[]): Promise<ReadonlyMap<GitOid, GitObjectResult>>;
  readRef(ref: string): Promise<GitOid | null>;
  readTreeSelection(root: GitOid, selection: GitTreeSelection | null): Promise<GitSnapshot["paths"]>;
}>;

function parseBatch(output: Buffer, oids: readonly GitOid[]): ReadonlyMap<GitOid, GitObjectResult> {
  const malformed = (detail: string): never => {
    throw new GitPlumbingError({
      stderr: Buffer.alloc(0),
      status: null,
      message: `malformed cat-file --batch output: ${detail}`,
    });
  };
  const objects = new Map<GitOid, GitObjectResult>();
  let offset = 0;
  for (const oid of oids) {
    const end = output.indexOf(0x0a, offset);
    if (end < 0) malformed(`missing header for ${oid}`);
    const fields = output.subarray(offset, end).toString("utf8").split(" ");
    offset = end + 1;
    if (fields.length === 2 && fields[0] === oid && fields[1] === "missing") {
      objects.set(oid, { kind: "missing" });
      continue;
    }
    const [, type, length] = fields;
    if (fields.length !== 3 || fields[0] !== oid || !/^(blob|tree|commit|tag)$/.test(type ?? ""))
      malformed(`unexpected header for ${oid}`);
    if (!/^(0|[1-9][0-9]*)$/.test(length ?? "")) malformed(`invalid size for ${oid}`);
    const size = Number(length);
    if (!Number.isSafeInteger(size) || size > output.length - offset) malformed(`invalid content length for ${oid}`);
    const bytes = output.subarray(offset, offset + size);
    offset += size;
    if (output[offset] !== 0x0a) malformed(`missing content delimiter for ${oid}`);
    offset += 1;
    objects.set(oid, { kind: "present", type: type!, bytes });
  }
  if (offset !== output.length) malformed("trailing bytes");
  return objects;
}

async function allTrees(repository: GitRepository, oids: readonly GitOid[]): Promise<boolean> {
  const metadata = `${oids.join("\n")}\n`;
  const output = await executeGit(repository, ["cat-file", "--batch-check=%(objectname) %(objecttype)"], metadata);
  const lines = output.toString("utf8").split("\n");
  const typeLine = /^([0-9a-f]+) (tree|blob|commit|tag|missing)$/u;
  if (
    lines.pop() !== "" ||
    lines.length !== oids.length ||
    lines.some((line, index) => typeLine.exec(line)?.[1] !== oids[index])
  )
    throw new GitPlumbingError({ stderr: "", status: null, message: "malformed cat-file --batch-check output" });
  return lines.every((line) => line.endsWith(" tree"));
}

/** Native directory reads rooted only in an immutable tree, shared by later selections. */
function treeLoader(repository: GitRepository, root: GitOid) {
  const directoriesAreCorrupt = async (output: Buffer): Promise<boolean> => {
    try {
      const oids = new Set(
        [...parseTreeEntries(output).values()].filter((entry) => entry.type === "tree").map(({ oid }) => oid),
      );
      return oids.size > 0 && !(await allTrees(repository, [...oids]));
    } catch {
      // Partial listings and failed probes cannot prove the cause of the native failure.
      return false;
    }
  };
  const list = async (oid: GitOid, recursive = false): Promise<ReadonlyMap<string, TreeEntry>> => {
    if (!(await allTrees(repository, [oid])))
      throw new AuthorityCorruptionError(`Git directory object is missing or not a tree: ${oid}`);
    const args = ["ls-tree", "-z", ...(recursive ? ["-r", "-t"] : []), oid];
    const output = await executeGit(repository, args).catch(async (error: unknown) => {
      if (!recursive || !(error instanceof GitPlumbingError) || error.status === null || repository.signal?.aborted)
        throw error;
      if (await directoriesAreCorrupt(error.stdout))
        throw new AuthorityCorruptionError("Git directory object is missing or not a tree", { cause: error });
      throw error;
    });
    return parseTreeEntries(output);
  };
  const pending = new Map<string, Promise<ReadonlyMap<string, TreeEntry>>>();
  const directory = (path: string, oid: GitOid) => {
    const loaded = pending.get(path) ?? list(oid);
    pending.set(path, loaded);
    return loaded;
  };
  return async (selection: GitTreeSelection | null): Promise<GitSnapshot["paths"]> => {
    const paths = new Map<string, TreeEntry>();
    const select = async (path: string, subtree: boolean): Promise<void> => {
      validPath(path);
      let oid = root;
      let prefix = "";
      for (const name of path.split("/")) {
        const entry = (await directory(prefix, oid)).get(name);
        if (entry === undefined) return;
        prefix = prefix.length === 0 ? name : `${prefix}/${name}`;
        if (prefix === path || entry.type !== "tree") {
          paths.set(prefix, entry);
          if (prefix === path && subtree && entry.type === "tree") await enumerate(path, entry.oid);
          return;
        }
        oid = entry.oid;
      }
    };
    const enumerate = async (path: string, oid: GitOid): Promise<void> => {
      const entries = await list(oid, true);
      const loaded = new Map<string, Map<string, TreeEntry>>([[path, new Map()]]);
      for (const [relative, entry] of entries) {
        const full = path.length === 0 ? relative : `${path}/${relative}`;
        const slash = full.lastIndexOf("/");
        const parent = slash < 0 ? "" : full.slice(0, slash);
        loaded.get(parent)!.set(full.slice(slash + 1), entry);
        if (entry.type === "tree") loaded.set(full, new Map());
        else paths.set(full, entry);
      }
      for (const [parent, children] of loaded) pending.set(parent, Promise.resolve(children));
    };
    if (selection === null) await enumerate("", root);
    else {
      const subtrees = new Set(selection.subtrees);
      for (const path of new Set([GIT_FORMAT_PATH, ...(selection.paths ?? []), ...subtrees]))
        await select(path, subtrees.has(path));
    }
    return paths;
  };
}

export async function withGitDecodeChannel<Value>(
  repository: GitRepository,
  consume: (channel: GitDecodeChannel) => Value | PromiseLike<Value>,
): Promise<Value> {
  let active = true;
  const objects = new Map<GitOid, Promise<GitObjectResult>>();
  const trees = new Map<GitOid, ReturnType<typeof treeLoader>>();
  const pending = new Set<Promise<unknown>>();
  const own = <Result>(read: Promise<Result>): Promise<Result> => {
    pending.add(read);
    void read.then(
      () => pending.delete(read),
      () => pending.delete(read),
    );
    return read;
  };
  const assertActive = (): void => {
    if (!active) throw new Error("Git decode channel is closed");
  };
  const readObjects = async (oids: readonly GitOid[]): Promise<ReadonlyMap<GitOid, GitObjectResult>> => {
    assertActive();
    const unique = [...new Set(oids)];
    for (const oid of unique) gitObjectId(oid, "Git object");
    const uncached = unique.filter((oid) => !objects.has(oid));
    if (uncached.length > 0) {
      // Install every promise before starting IO so concurrent callers share the same batch.
      const batch = own(
        Promise.resolve().then(async () =>
          parseBatch(await executeGit(repository, ["cat-file", "--batch"], `${uncached.join("\n")}\n`), uncached),
        ),
      );
      for (const oid of uncached)
        objects.set(
          oid,
          batch.then((results) => results.get(oid)!),
        );
    }
    return new Map(await Promise.all(unique.map(async (oid) => [oid, await objects.get(oid)!] as const)));
  };
  const readTreeSelection = async (root: GitOid, selection: GitTreeSelection | null): Promise<GitSnapshot["paths"]> => {
    assertActive();
    gitObjectId(root, "Git tree");
    const load = trees.get(root) ?? treeLoader(repository, root);
    trees.set(root, load);
    return await load(selection);
  };
  const channel = {
    [gitDecodeChannelBrand]: true,
    readObjects: (oids) => own(readObjects(oids)),
    readRef: async (ref) => {
      assertActive();
      return await own(readRef(repository, ref));
    },
    readTreeSelection: (root, selection) => own(readTreeSelection(root, selection)),
  } satisfies GitDecodeChannel;
  let failure: unknown[] = [];
  try {
    return await consume(channel);
  } catch (error) {
    failure = [error];
    throw error;
  } finally {
    active = false;
    const retired = await Promise.allSettled(pending);
    objects.clear();
    trees.clear();
    const failures = new Set(retired.flatMap((read) => (read.status === "rejected" ? [read.reason] : [])));
    if (failure.length > 0) failures.delete(failure[0]);
    if (failures.size > 0)
      throw new AggregateError([...failure, ...failures], "Git read scope failed while awaiting outstanding reads", {
        cause: failure[0],
      });
  }
}

function commitTree(result: GitObjectResult, commit: GitOid): GitOid {
  if (result.kind === "missing") throw new AuthorityCorruptionError(`Git state commit is missing: ${commit}`);
  if (result.type !== "commit") throw new AuthorityCorruptionError(`Git state ref does not name a commit: ${commit}`);
  const newline = result.bytes.indexOf(0x0a);
  if (newline < 0) throw new AuthorityCorruptionError(`Git state commit has no headers: ${commit}`);
  const firstLine = result.bytes.subarray(0, newline).toString("utf8");
  if (!firstLine.startsWith("tree "))
    throw new AuthorityCorruptionError(`Git state commit has no root tree: ${commit}`);
  return gitObjectId(firstLine.slice("tree ".length), "Git state tree");
}

/** A present non-blob authority is corruption, never a silent skip. */
export async function readBlobResults(
  channel: GitDecodeChannel,
  oids: readonly GitOid[],
): Promise<ReadonlyMap<GitOid, GitBlobResult>> {
  const objects = await channel.readObjects(oids);
  const blobs = new Map<GitOid, GitBlobResult>();
  for (const [oid, object] of objects) {
    if (object.kind === "present" && object.type !== "blob")
      throw new AuthorityCorruptionError(`Git object is not a blob: ${oid}`);
    blobs.set(oid, object.kind === "missing" ? object : { kind: "present", bytes: object.bytes });
  }
  return blobs;
}

async function observeEpoch<Value>(
  repository: GitRepository,
  channel: GitDecodeChannel,
  selection: GitTreeSelection | null,
  consume: (observation: GitReadObservation) => Value | PromiseLike<Value>,
): Promise<Value> {
  let active = true;
  const refs = new Map<string, Promise<GitOid | null>>();
  const assertActive = (): void => {
    if (!active) throw new Error("Git read observation is closed");
  };
  const resolveRef = async (ref: string): Promise<GitOid | null> => {
    assertActive();
    const resolved = refs.get(ref) ?? channel.readRef(ref);
    refs.set(ref, resolved);
    return resolved;
  };
  try {
    for (const path of [...(selection?.paths ?? []), ...(selection?.subtrees ?? [])]) validPath(path);
    const commit = await resolveRef(GIT_REF);
    const tree = commit === null ? null : commitTree((await channel.readObjects([commit])).get(commit)!, commit);
    const paths = tree === null ? new Map() : await channel.readTreeSelection(tree, selection);
    const observation = {
      [gitReadObservationBrand]: true,
      repository,
      snapshot: { commit, tree, paths },
      selectPaths: async (requested) => {
        assertActive();
        return tree === null ? paths : channel.readTreeSelection(tree, { paths: requested });
      },
      readBlobs: async (oids) => {
        assertActive();
        return await readBlobResults(channel, oids);
      },
      resolveRef,
    } satisfies GitReadObservation;
    if (commit !== null) {
      const format = paths.get(GIT_FORMAT_PATH);
      if (format === undefined) throw new AuthorityCorruptionError(`Git is missing ${GIT_FORMAT_PATH}`);
      if (format.type !== "blob") throw new AuthorityCorruptionError(`Git format is not a blob: ${GIT_FORMAT_PATH}`);
      const result = (await observation.readBlobs([format.oid])).get(format.oid);
      if (result?.kind !== "present" || result.bytes.toString("utf8") !== GIT_FORMAT_BYTES)
        throw new AuthorityCorruptionError(`Git format is not current: ${GIT_FORMAT_PATH}`);
    }
    return await consume(observation);
  } finally {
    active = false;
    refs.clear();
  }
}

export function withGitReadObservation<Value>(
  repository: GitRepository,
  channel: GitDecodeChannel,
  consume: (observation: GitReadObservation) => Value | PromiseLike<Value>,
): Promise<Value> {
  return observeEpoch(repository, channel, null, consume);
}

export function withGitTargetedReadObservation<Value>(
  repository: GitRepository,
  channel: GitDecodeChannel,
  selection: GitTreeSelection,
  consume: (observation: GitReadObservation) => Value | PromiseLike<Value>,
): Promise<Value> {
  return observeEpoch(repository, channel, selection, consume);
}
