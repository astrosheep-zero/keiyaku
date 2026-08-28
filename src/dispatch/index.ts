import { createHash } from "node:crypto";
import { AuthorityCorruptionError } from "../core/facts/errors.js";
import { contractId, type ContractId } from "../core/facts/types.js";
import { parseAkuId, type AkuId } from "../akuma/identity.js";
import { confirmPrivateStatePublication, withPrivateStatePublicationSeat } from "../git/private-state-seat.js";
import {
  GIT_FORMAT_BYTES,
  GIT_FORMAT_PATH,
  GIT_REF,
  readBlob,
  readGitPaths,
  updateGitTree,
  updateRefsAtomically,
  writeBlob,
  writeStateCommit,
  type GitSnapshot,
  type TreeChange,
} from "../git/repository.js";
import type { GitRepository } from "../git/process.js";
import { withGitDecodeChannel, withGitReadObservation, type GitReadObservation } from "../git/read-observation.js";

const DISPATCH_ROOT = "dispatch";
const DISPATCH_PREFIX = `${DISPATCH_ROOT}/`;
const DISPATCH_SUFFIX = ".json";

export type Dispatch = Readonly<{
  akuId: AkuId;
  contractId: ContractId;
  dispatchedAt: string;
}>;

export type DispatchFailure =
  | Readonly<{ kind: "conflict"; current: Dispatch }>
  | Readonly<{ kind: "publication-failed"; diagnostic: string }>;

export type DispatchPublication =
  | Readonly<{ kind: "dispatched"; dispatch: Dispatch }>
  | Readonly<{ kind: "failed"; failure: DispatchFailure }>;

function pathFor(akuId: AkuId): string {
  return `${DISPATCH_PREFIX}${createHash("sha256").update(akuId).digest("hex")}${DISPATCH_SUFFIX}`;
}

function bytesFor(dispatch: Dispatch): Uint8Array {
  return Buffer.from(`${JSON.stringify(dispatch)}\n`);
}

function corruption(message: string, cause?: unknown): never {
  throw new AuthorityCorruptionError(message, cause === undefined ? {} : { cause });
}

function decode(path: string, bytes: Uint8Array): Dispatch {
  let value: unknown;
  try {
    const text = Buffer.from(bytes).toString("utf8");
    if (!text.endsWith("\n") || text.slice(0, -1).includes("\n")) {
      corruption(`Dispatch is not one canonical JSON line: ${path}`);
    }
    value = JSON.parse(text);
  } catch (error) {
    if (error instanceof AuthorityCorruptionError) throw error;
    return corruption(`invalid Dispatch JSON: ${path}`, error);
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    corruption(`Dispatch must be an object: ${path}`);
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  if (keys.length !== 3 || keys.some((key) => !["akuId", "contractId", "dispatchedAt"].includes(key))) {
    corruption(`Dispatch has invalid fields: ${path}`);
  }
  if (
    typeof record.akuId !== "string" ||
    typeof record.contractId !== "string" ||
    typeof record.dispatchedAt !== "string"
  ) {
    corruption(`Dispatch has invalid values: ${path}`);
  }
  let akuId: AkuId;
  let owner: ContractId;
  try {
    akuId = parseAkuId(record.akuId).id;
    owner = contractId(record.contractId);
  } catch (error) {
    return corruption(`Dispatch identity is invalid: ${path}`, error);
  }
  const timestamp = new Date(record.dispatchedAt);
  if (!Number.isFinite(timestamp.getTime()) || timestamp.toISOString() !== record.dispatchedAt) {
    corruption(`Dispatch timestamp is invalid: ${path}`);
  }
  const dispatch: Dispatch = { akuId, contractId: owner, dispatchedAt: record.dispatchedAt };
  if (pathFor(akuId) !== path) corruption(`Dispatch path does not match akuId: ${path}`);
  if (!Buffer.from(bytesFor(dispatch)).equals(Buffer.from(bytes))) {
    corruption(`Dispatch bytes are not canonical: ${path}`);
  }
  return dispatch;
}

async function dispatchFromSnapshot(
  repository: GitRepository,
  snapshot: GitSnapshot,
  akuId: AkuId,
): Promise<Dispatch | null> {
  const path = pathFor(akuId);
  const entry = snapshot.paths.get(path);
  if (entry === undefined) return null;
  if (entry.type !== "blob") corruption(`Dispatch path is not a blob: ${path}`);
  return decode(path, await readBlob(repository, entry.oid));
}

export async function readDispatch(repository: GitRepository, value: AkuId): Promise<Dispatch | null> {
  const akuId = parseAkuId(value).id;
  const path = pathFor(akuId);
  return await dispatchFromSnapshot(repository, await readGitPaths(repository, [path]), akuId);
}

export async function readDispatchesAt(observation: GitReadObservation): Promise<readonly Dispatch[]> {
  const entries = [...observation.snapshot.paths].filter(
    ([path, entry]) => path.startsWith(DISPATCH_PREFIX) && entry.type === "blob",
  );
  const blobs = await observation.readBlobs(entries.map(([, entry]) => entry.oid));
  const dispatches: Dispatch[] = [];
  const seen = new Set<AkuId>();
  for (const [path, entry] of observation.snapshot.paths) {
    if (path === DISPATCH_ROOT) corruption(`Dispatch authority root is not a tree: ${path}`);
    if (!path.startsWith(DISPATCH_PREFIX)) continue;
    if (!path.endsWith(DISPATCH_SUFFIX)) corruption(`unexpected Dispatch authority path: ${path}`);
    if (entry.type !== "blob") corruption(`Dispatch path is not a blob: ${path}`);
    const result = blobs.get(entry.oid);
    if (result?.kind !== "present") corruption(`missing Dispatch Git object: ${path}`);
    const dispatch = decode(path, result.bytes);
    if (seen.has(dispatch.akuId)) corruption(`duplicate Dispatch identity: ${dispatch.akuId}`);
    seen.add(dispatch.akuId);
    dispatches.push(dispatch);
  }
  return dispatches.sort((left, right) => Buffer.compare(Buffer.from(left.akuId), Buffer.from(right.akuId)));
}

export async function readDispatches(repository: GitRepository): Promise<readonly Dispatch[]> {
  return await withGitDecodeChannel(repository, (channel) =>
    withGitReadObservation(repository, channel, readDispatchesAt),
  );
}

async function observedPublication(
  repository: GitRepository,
  akuId: AkuId,
  owner: ContractId,
): Promise<DispatchPublication | null> {
  const current = await readDispatch(repository, akuId);
  if (current === null) return null;
  return current.contractId === owner
    ? { kind: "dispatched", dispatch: current }
    : { kind: "failed", failure: { kind: "conflict", current } };
}

function diagnostic(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function publishDispatch(
  input: Readonly<{
    repository: GitRepository;
    akuId: AkuId;
    contractId: ContractId;
  }>,
): Promise<DispatchPublication> {
  const akuId = parseAkuId(input.akuId).id;
  const owner = contractId(input.contractId);
  const intended: Dispatch = { akuId, contractId: owner, dispatchedAt: new Date().toISOString() };
  const path = pathFor(akuId);
  return await withPrivateStatePublicationSeat(input.repository, async (seat) => {
    const snapshot = await readGitPaths(input.repository, [path]);
    const current = await dispatchFromSnapshot(input.repository, snapshot, akuId);
    if (current !== null) {
      if (current.contractId === owner) confirmPrivateStatePublication(seat);
      return current.contractId === owner
        ? { kind: "dispatched", dispatch: current }
        : { kind: "failed", failure: { kind: "conflict", current } };
    }

    const changes = new Map<string, TreeChange>();
    if (snapshot.commit === null) {
      changes.set(GIT_FORMAT_PATH, { oid: await writeBlob(input.repository, GIT_FORMAT_BYTES) });
    }
    changes.set(path, { oid: await writeBlob(input.repository, bytesFor(intended)) });
    const tree = await updateGitTree(input.repository, snapshot.tree, changes);
    const commit = await writeStateCommit({
      repository: input.repository,
      tree,
      parent: snapshot.commit,
      message: `dispatch ${akuId}`,
      at: intended.dispatchedAt,
    });
    const publication = await updateRefsAtomically(input.repository, [
      {
        ref: GIT_REF,
        newOid: commit,
        expectedOid: snapshot.commit,
      },
    ]);
    if (publication.kind === "published") {
      confirmPrivateStatePublication(seat);
      return { kind: "dispatched", dispatch: intended };
    }

    const observed = await observedPublication(input.repository, akuId, owner);
    if (observed !== null) {
      if (observed.kind === "dispatched") confirmPrivateStatePublication(seat);
      return observed;
    }
    if (publication.kind === "non-published") {
      const fresh = await readGitPaths(input.repository, [path]);
      if (fresh.commit === snapshot.commit) {
        return {
          kind: "failed",
          failure: { kind: "publication-failed", diagnostic: diagnostic(publication.error) },
        };
      }
    }
    return {
      kind: "failed",
      failure: { kind: "publication-failed", diagnostic: "Dispatch publication outcome is unknown" },
    };
  });
}
