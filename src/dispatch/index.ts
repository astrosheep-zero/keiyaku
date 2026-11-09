import { createHash } from "node:crypto";
import { z } from "zod";
import { contractIdSchema } from "../git/identity.js";
import { AuthorityCorruptionError } from "../core/facts/errors.js";
import { contractId, type ContractId } from "../core/facts/types.js";
import { akumaIdSchema, parseAkumaId, type AkumaId } from "../akuma/identity.js";
import {
  appendPrivateStateSeatClose,
  confirmPrivateStatePublication,
  mergePrivateStateSeatClose,
  withPrivateStatePublicationSeat,
  type PrivateStateSeatCloseLag,
  type PrivateStateSeatOutcome,
} from "../git/private-state-seat.js";
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
import {
  withGitDecodeChannel,
  withGitReadObservation,
  withGitTargetedReadObservation,
  type GitReadObservation,
} from "../git/read-observation.js";
import { NO_DISPATCH_ASSOCIATION, type DispatchAssociation } from "../akuma/dispatch-association.js";

const DISPATCH_ROOT = "dispatch";
const DISPATCH_PREFIX = `${DISPATCH_ROOT}/`;
const DISPATCH_SUFFIX = ".json";

export const dispatchSchema = z
  .strictObject({ akumaId: akumaIdSchema, contractId: contractIdSchema, dispatchedAt: z.string() })
  .readonly();
export const dispatchFailureSchema = z.union([
  z.strictObject({ kind: z.literal("conflict"), current: dispatchSchema }).readonly(),
  z.strictObject({ kind: z.literal("publication-failed"), diagnostic: z.string() }).readonly(),
]);

export type Dispatch = Readonly<{
  akumaId: AkumaId;
  contractId: ContractId;
  dispatchedAt: string;
}>;

export type DispatchFailure =
  | Readonly<{ kind: "conflict"; current: Dispatch }>
  | Readonly<{ kind: "publication-failed"; diagnostic: string }>;

type DispatchPublication =
  | Readonly<{ kind: "dispatched"; dispatch: Dispatch; seatClose?: readonly PrivateStateSeatCloseLag[] }>
  | Readonly<{ kind: "failed"; failure: DispatchFailure }>;

function pathFor(akumaId: AkumaId): string {
  return `${DISPATCH_PREFIX}${createHash("sha256").update(akumaId).digest("hex")}${DISPATCH_SUFFIX}`;
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
  if (keys.length !== 3 || keys.some((key) => !["akumaId", "contractId", "dispatchedAt"].includes(key))) {
    corruption(`Dispatch has invalid fields: ${path}`);
  }
  if (
    typeof record.akumaId !== "string" ||
    typeof record.contractId !== "string" ||
    typeof record.dispatchedAt !== "string"
  ) {
    corruption(`Dispatch has invalid values: ${path}`);
  }
  let akumaId: AkumaId;
  let owner: ContractId;
  try {
    akumaId = parseAkumaId(record.akumaId).id;
    owner = contractId(record.contractId);
  } catch (error) {
    return corruption(`Dispatch identity is invalid: ${path}`, error);
  }
  const timestamp = new Date(record.dispatchedAt);
  if (!Number.isFinite(timestamp.getTime()) || timestamp.toISOString() !== record.dispatchedAt) {
    corruption(`Dispatch timestamp is invalid: ${path}`);
  }
  const dispatch: Dispatch = { akumaId, contractId: owner, dispatchedAt: record.dispatchedAt };
  if (pathFor(akumaId) !== path) corruption(`Dispatch path does not match akumaId: ${path}`);
  if (!Buffer.from(bytesFor(dispatch)).equals(Buffer.from(bytes))) {
    corruption(`Dispatch bytes are not canonical: ${path}`);
  }
  return dispatch;
}

async function dispatchFromSnapshot(
  repository: GitRepository,
  snapshot: GitSnapshot,
  akumaId: AkumaId,
): Promise<Dispatch | null> {
  const path = pathFor(akumaId);
  const entry = snapshot.paths.get(path);
  if (entry === undefined) return null;
  if (entry.type !== "blob") corruption(`Dispatch path is not a blob: ${path}`);
  return decode(path, await readBlob(repository, entry.oid));
}

export async function readDispatch(repository: GitRepository, value: AkumaId): Promise<Dispatch | null> {
  const akumaId = parseAkumaId(value).id;
  const path = pathFor(akumaId);
  return await dispatchFromSnapshot(repository, await readGitPaths(repository, [path]), akumaId);
}

export async function readDispatchesAt(observation: GitReadObservation): Promise<readonly Dispatch[]> {
  const entries = [...observation.snapshot.paths].filter(
    ([path, entry]) => path.startsWith(DISPATCH_PREFIX) && entry.type === "blob",
  );
  const blobs = await observation.readBlobs(entries.map(([, entry]) => entry.oid));
  const dispatches: Dispatch[] = [];
  const seen = new Set<AkumaId>();
  for (const [path, entry] of observation.snapshot.paths) {
    if (path === DISPATCH_ROOT) corruption(`Dispatch authority root is not a tree: ${path}`);
    if (!path.startsWith(DISPATCH_PREFIX)) continue;
    if (!path.endsWith(DISPATCH_SUFFIX)) corruption(`unexpected Dispatch authority path: ${path}`);
    if (entry.type !== "blob") corruption(`Dispatch path is not a blob: ${path}`);
    const result = blobs.get(entry.oid);
    if (result?.kind !== "present") corruption(`missing Dispatch Git object: ${path}`);
    const dispatch = decode(path, result.bytes);
    if (seen.has(dispatch.akumaId)) corruption(`duplicate Dispatch identity: ${dispatch.akumaId}`);
    seen.add(dispatch.akumaId);
    dispatches.push(dispatch);
  }
  return dispatches.sort((left, right) => Buffer.compare(Buffer.from(left.akumaId), Buffer.from(right.akumaId)));
}

export async function readDispatches(repository: GitRepository): Promise<readonly Dispatch[]> {
  return await withGitDecodeChannel(repository, (channel) =>
    withGitReadObservation(repository, channel, readDispatchesAt),
  );
}

async function observedPublication(
  repository: GitRepository,
  akumaId: AkumaId,
  owner: ContractId,
): Promise<DispatchPublication | null> {
  const current = await readDispatch(repository, akumaId);
  if (current === null) return null;
  return current.contractId === owner
    ? { kind: "dispatched", dispatch: current }
    : { kind: "failed", failure: { kind: "conflict", current } };
}

function diagnostic(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function dispatchPublicationWithSeatClose(outcome: PrivateStateSeatOutcome<DispatchPublication>): DispatchPublication {
  return mergePrivateStateSeatClose(outcome, (value, closeLag) => {
    if (value.kind !== "dispatched") throw new Error(closeLag.diagnostic);
    return { ...value, seatClose: appendPrivateStateSeatClose(value.seatClose, closeLag) };
  });
}

export async function publishDispatch(
  input: Readonly<{
    repository: GitRepository;
    akumaId: AkumaId;
    contractId: ContractId;
  }>,
): Promise<DispatchPublication> {
  const akumaId = parseAkumaId(input.akumaId).id;
  const owner = contractId(input.contractId);
  const intended: Dispatch = { akumaId, contractId: owner, dispatchedAt: new Date().toISOString() };
  const path = pathFor(akumaId);
  return dispatchPublicationWithSeatClose(
    await withPrivateStatePublicationSeat(input.repository, async (seat) => {
      const snapshot = await readGitPaths(input.repository, [path]);
      const current = await dispatchFromSnapshot(input.repository, snapshot, akumaId);
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
        message: `dispatch ${akumaId}`,
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

      const observed = await observedPublication(input.repository, akumaId, owner);
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
    }),
  );
}

/** Read selected associations in one targeted observation, isolating per-identity decoding failures. */
export async function observeDispatchAssociations(
  repository: GitRepository | undefined,
  akuIds: readonly AkumaId[],
): Promise<ReadonlyMap<AkumaId, DispatchAssociation>> {
  const requested = [...new Set(akuIds.map((akumaId) => parseAkumaId(akumaId).id))];
  const associations = new Map<AkumaId, DispatchAssociation>(
    requested.map((akumaId) => [akumaId, NO_DISPATCH_ASSOCIATION]),
  );
  if (repository === undefined || requested.length === 0) return associations;
  try {
    await withGitDecodeChannel(repository, (channel) =>
      withGitTargetedReadObservation(repository, channel, { paths: requested.map(pathFor) }, async (observation) => {
        const entries = requested.map((akumaId) => {
          const path = pathFor(akumaId);
          return [akumaId, path, observation.snapshot.paths.get(path)] as const;
        });
        const blobs = await observation.readBlobs(
          entries.flatMap(([, , entry]) => (entry?.type === "blob" ? [entry.oid] : [])),
        );
        for (const [akumaId, path, entry] of entries) {
          if (entry === undefined) continue;
          try {
            if (entry.type !== "blob") corruption(`Dispatch path is not a blob: ${path}`);
            const result = blobs.get(entry.oid);
            if (result?.kind !== "present") corruption(`missing Dispatch Git object: ${path}`);
            associations.set(akumaId, { kind: "associated", contractId: decode(path, result.bytes).contractId });
          } catch (error) {
            associations.set(akumaId, { kind: "failed", diagnostic: diagnostic(error) });
          }
        }
      }),
    );
  } catch (error) {
    const message = diagnostic(error);
    for (const akumaId of requested) associations.set(akumaId, { kind: "failed", diagnostic: message });
  }
  return associations;
}
