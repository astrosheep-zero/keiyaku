import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { AuthorityCorruptionError } from "../core/facts/errors.js";
import { gitObjectId } from "./identity.js";
import {
  GIT_FORMAT_BYTES,
  GIT_FORMAT_PATH,
  GIT_REF,
  GitPlumbingError,
  readRef,
  readTreeEntries,
  type GitOid,
  type GitRepository,
  type GitSnapshot,
} from "./repository.js";

const gitReadObservationBrand: unique symbol = Symbol("GitReadObservation");

export type GitBlobResult =
  | Readonly<{ kind: "present"; bytes: Buffer }>
  | Readonly<{ kind: "missing" }>;

export type GitReadObservation = Readonly<{
  readonly [gitReadObservationBrand]: true;
  repository: GitRepository;
  snapshot: GitSnapshot;
  readBlobs(oids: readonly GitOid[]): Promise<ReadonlyMap<GitOid, GitBlobResult>>;
  resolveRef(ref: string): Promise<GitOid | null>;
}>;

type ObjectResult =
  | Readonly<{ kind: "present"; type: string; bytes: Buffer }>
  | Readonly<{ kind: "missing" }>;

class StreamCursor {
  readonly #iterator: AsyncIterator<string | Buffer>;
  #buffer = Buffer.alloc(0);

  constructor(stream: NodeJS.ReadableStream) {
    this.#iterator = (stream as NodeJS.ReadableStream & AsyncIterable<string | Buffer>)[Symbol.asyncIterator]();
  }

  async line(): Promise<Buffer> {
    for (;;) {
      const newline = this.#buffer.indexOf(0x0a);
      if (newline >= 0) {
        const value = this.#buffer.subarray(0, newline);
        this.#buffer = this.#buffer.subarray(newline + 1);
        return value;
      }
      await this.#pull("line");
    }
  }

  async exact(length: number): Promise<Buffer> {
    while (this.#buffer.length < length) await this.#pull(`${length} bytes`);
    const value = this.#buffer.subarray(0, length);
    this.#buffer = this.#buffer.subarray(length);
    return value;
  }

  async #pull(expected: string): Promise<void> {
    const next = await this.#iterator.next();
    if (next.done) throw new Error(`git cat-file --batch ended while reading ${expected}`);
    const chunk = Buffer.from(next.value);
    this.#buffer = this.#buffer.length === 0
      ? chunk
      : Buffer.concat([this.#buffer, chunk]);
  }
}

class BatchObjectReader {
  readonly #child: ChildProcessWithoutNullStreams;
  readonly #cursor: StreamCursor;
  readonly #cache = new Map<GitOid, Promise<ObjectResult>>();
  readonly #stderr: Buffer[] = [];
  readonly #closed: Promise<Readonly<{ code: number | null; signal: NodeJS.Signals | null }>>;
  #tail: Promise<void> = Promise.resolve();
  #spawnError: Error | null = null;
  #failure: GitPlumbingError | null = null;

  constructor(readonly repository: GitRepository) {
    this.#child = spawn("git", ["cat-file", "--batch"], {
      cwd: repository.effectiveCwd,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.#cursor = new StreamCursor(this.#child.stdout);
    this.#child.stderr.on("data", (chunk: Buffer) => this.#stderr.push(Buffer.from(chunk)));
    this.#child.on("error", (error) => { this.#spawnError = error; });
    this.#child.stdin.on("error", (error) => { this.#spawnError ??= error; });
    this.#closed = new Promise((resolve) => {
      this.#child.once("close", (code, signal) => resolve({ code, signal }));
    });
  }

  async objects(oids: readonly GitOid[]): Promise<ReadonlyMap<GitOid, ObjectResult>> {
    const unique = [...new Set(oids)];
    for (const oid of unique) gitObjectId(oid, "Git object");
    const entries = await Promise.all(unique.map(async (oid) => [oid, await this.#object(oid)] as const));
    return new Map(entries);
  }

  async close(): Promise<void> {
    await this.#tail.catch(() => undefined);
    if (!this.#child.stdin.destroyed) this.#child.stdin.end();
    const outcome = await this.#closed;
    if (this.#spawnError !== null || outcome.code !== 0) {
      throw this.#error("git cat-file --batch did not close cleanly", outcome.code);
    }
  }

  #object(oid: GitOid): Promise<ObjectResult> {
    const cached = this.#cache.get(oid);
    if (cached !== undefined) return cached;
    const requested = this.#tail.then(() => this.#read(oid));
    this.#tail = requested.then(() => undefined, () => undefined);
    this.#cache.set(oid, requested);
    return requested;
  }

  async #read(oid: GitOid): Promise<ObjectResult> {
    if (this.#failure !== null) throw this.#failure;
    try {
      await this.#write(`${oid}\n`);
      const header = (await this.#cursor.line()).toString("ascii").split(" ");
      if (header.length === 2 && header[0] === oid && header[1] === "missing") return { kind: "missing" };
      if (header.length !== 3 || header[0] !== oid || header[1] === undefined || header[2] === undefined) {
        throw new Error(`unexpected header for ${oid}`);
      }
      if (!/^(0|[1-9][0-9]*)$/.test(header[2])) throw new Error(`invalid size for ${oid}`);
      const size = Number(header[2]);
      if (!Number.isSafeInteger(size)) throw new Error(`unsafe size for ${oid}`);
      const bytes = await this.#cursor.exact(size);
      const delimiter = await this.#cursor.exact(1);
      if (delimiter[0] !== 0x0a) throw new Error(`missing content delimiter for ${oid}`);
      return { kind: "present", type: header[1], bytes };
    } catch (error) {
      if (this.#failure !== null) throw this.#failure;
      this.#child.kill();
      await this.#closed;
      this.#failure = this.#error(error instanceof Error ? error.message : String(error), this.#child.exitCode);
      throw this.#failure;
    }
  }

  async #write(value: string): Promise<void> {
    if (this.#spawnError !== null) throw this.#spawnError;
    await new Promise<void>((resolve, reject) => {
      this.#child.stdin.write(value, (error) => error === null || error === undefined ? resolve() : reject(error));
    });
  }

  #error(message: string, status: number | null): GitPlumbingError {
    return new GitPlumbingError({
      stderr: Buffer.concat(this.#stderr),
      status,
      message: `git cat-file --batch: ${message}`,
      pid: this.#child.pid ?? null,
    });
  }
}

function commitTree(result: ObjectResult, commit: GitOid): GitOid {
  if (result.kind === "missing") throw new AuthorityCorruptionError(`Git state commit is missing: ${commit}`);
  if (result.type !== "commit") throw new AuthorityCorruptionError(`Git state ref does not name a commit: ${commit}`);
  const newline = result.bytes.indexOf(0x0a);
  if (newline < 0) throw new AuthorityCorruptionError(`Git state commit has no headers: ${commit}`);
  const firstLine = result.bytes.subarray(0, newline).toString("ascii");
  if (!firstLine.startsWith("tree ")) throw new AuthorityCorruptionError(`Git state commit has no root tree: ${commit}`);
  return gitObjectId(firstLine.slice("tree ".length), "Git state tree");
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

export async function withGitReadObservation<Value>(
  repository: GitRepository,
  consume: (observation: GitReadObservation) => Value | PromiseLike<Value>,
): Promise<Value> {
  const commit = readRef(repository, GIT_REF);
  let reader: BatchObjectReader | null = null;
  let active = true;
  const refs = new Map<string, Promise<GitOid | null>>();
  const objectReader = (): BatchObjectReader => reader ??= new BatchObjectReader(repository);
  const closeReader = async (): Promise<void> => {
    if (reader !== null) await reader.close();
  };
  const assertActive = (): void => {
    if (!active) throw new Error("Git read observation is closed");
  };
  const resolveRef = async (ref: string): Promise<GitOid | null> => {
    assertActive();
    let resolved = refs.get(ref);
    if (resolved === undefined) {
      resolved = Promise.resolve().then(() => readRef(repository, ref));
      refs.set(ref, resolved);
    }
    return resolved;
  };
  const readBlobResults = async (oids: readonly GitOid[]): Promise<ReadonlyMap<GitOid, GitBlobResult>> => {
    assertActive();
    if (oids.length === 0) return new Map();
    const objects = await objectReader().objects(oids);
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
    if (commit === null) {
      snapshot = { commit: null, tree: null, paths: new Map() };
    } else {
      const commitObject = (await objectReader().objects([commit])).get(commit);
      if (commitObject === undefined) throw new Error(`missing state commit result: ${commit}`);
      const tree = commitTree(commitObject, commit);
      snapshot = { commit, tree, paths: readTreeEntries(repository, tree) };
    }
    const observation = {
      [gitReadObservationBrand]: true,
      repository,
      snapshot,
      readBlobs: readBlobResults,
      resolveRef,
    } satisfies GitReadObservation;
    if (commit !== null) await readFormat(observation);
    result = await consume(observation);
  } catch (error) {
    failure = error;
  }
  active = false;
  try {
    await closeReader();
  } catch (error) {
    failure ??= error;
  }
  if (failure !== undefined) throw failure;
  return result as Value;
}
