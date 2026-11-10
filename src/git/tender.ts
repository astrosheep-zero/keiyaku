import { z } from "zod";
import { access } from "node:fs/promises";
import type { Preparation } from "../core/decide.js";
import type { ActorId, ContractCoordinates, ContractId, SnapshotId } from "../core/facts/types.js";
import { gitObjectIdForSnapshot, mintSnapshotId, type GitObjectId } from "./identity.js";
import { registeredWorktreePaths } from "./repository.js";
import { executeGit, GitPlumbingError, type GitRepository } from "./process.js";
import { captureWorkspaceTree, workspaceMergeHead, worktreePath } from "./workspace.js";

type TenderCaptureCoordinates = Readonly<{
  contractId: ContractId;
  coordinates: ContractCoordinates;
  place?: string;
  workspacePath?: string;
  captureMergeState?: boolean;
}>;

export const worktreeMissingRefusalSchema = z
  .object({ kind: z.literal("worktree-missing") })
  .strict()
  .readonly();
type WorktreeMissingRefusal = z.infer<typeof worktreeMissingRefusalSchema>;
export const dirtyWorkspaceRefusalSchema = z
  .object({
    kind: z.literal("dirty-workspace"),
    paths: z
      .array(z.string().refine((value) => value.trim() !== ""))
      .readonly()
      .exactOptional(),
    submodules: z
      .array(z.string().refine((value) => value.trim() !== ""))
      .readonly()
      .exactOptional(),
  })
  .strict()
  .readonly();
export type DirtyWorkspaceRefusal = z.infer<typeof dirtyWorkspaceRefusalSchema>;
export type TenderCapture = Readonly<{
  tree: GitObjectId;
  head: SnapshotId;
  mergeHead?: SnapshotId;
  at: string;
  dirty: boolean;
  changes: Awaited<ReturnType<typeof captureWorkspaceTree>>["changes"];
}>;

async function workspaceExists(repository: GitRepository, path: string): Promise<boolean> {
  const exists = await access(path).then(
    () => true,
    () => false,
  );
  return exists && (await registeredWorktreePaths(repository)).includes(path);
}

function workspaceFor(repository: GitRepository, input: TenderCaptureCoordinates): string | undefined {
  if (input.workspacePath !== undefined) return input.workspacePath;
  return input.place === undefined ? undefined : worktreePath(repository, input.place);
}

/** Capture the complete workspace tree through Git's private index mechanics. */
export async function captureTender(
  repository: GitRepository,
  input: TenderCaptureCoordinates,
): Promise<Preparation<TenderCapture, WorktreeMissingRefusal>> {
  const workspace = workspaceFor(repository, input);
  if (workspace === undefined || !(await workspaceExists(repository, workspace))) {
    return { kind: "refused", refusal: { kind: "worktree-missing" } };
  }
  const captured = await captureWorkspaceTree(repository, workspace);
  const mergeHead = input.captureMergeState === true ? await workspaceMergeHead(repository, workspace) : undefined;
  return {
    kind: "prepared",
    data: { ...captured, ...(mergeHead === undefined ? {} : { mergeHead }) },
  };
}

export function dirtyTenderRefusal(tender: TenderCapture): DirtyWorkspaceRefusal {
  const paths = [...new Set([...tender.changes.staged, ...tender.changes.unstaged, ...tender.changes.untracked])];
  return {
    kind: "dirty-workspace",
    ...(paths.length === 0 ? {} : { paths }),
    ...(tender.changes.submodules.length === 0 ? {} : { submodules: tender.changes.submodules }),
  };
}

type GitCommitIdentity = Readonly<{ name: string; email: string }>;

export type DeliveryCommitMetadata = Readonly<{
  message: string;
  at: string;
  identity: GitCommitIdentity;
}>;

async function effectiveConfig(
  repository: GitRepository,
  key: "user.name" | "user.email",
): Promise<string | undefined> {
  try {
    const value = (await executeGit(repository, ["config", "--get", key])).toString("utf8").trim();
    return value.length === 0 ? undefined : value;
  } catch (error) {
    if (error instanceof GitPlumbingError && error.status === 1) return undefined;
    throw error;
  }
}

function contractBody(bytes: string): string {
  return `${bytes.replace(/(?:\r\n|\r|\n)+$/u, "")}\n`;
}

export async function prepareDeliveryCommitMetadata(
  repository: GitRepository,
  input: Readonly<{
    contractId: ContractId;
    title: string;
    document: string;
    at: string;
    actor?: ActorId;
    message?: string;
  }>,
): Promise<DeliveryCommitMetadata> {
  let identity: GitCommitIdentity;
  if (input.actor !== undefined) {
    identity = { name: input.actor, email: "keiyaku@localhost" };
  } else {
    const [name, email] = await Promise.all([
      effectiveConfig(repository, "user.name"),
      effectiveConfig(repository, "user.email"),
    ]);
    identity =
      name !== undefined && email !== undefined ? { name, email } : { name: "Keiyaku", email: "keiyaku@localhost" };
  }
  const subject = input.message ?? `${input.contractId}: ${input.title}`;
  return {
    message: `${subject}\n\n${contractBody(input.document)}\nKeiyaku-Contract: ${input.contractId}\n`,
    at: input.at,
    identity,
  };
}

/** The Git identity environment for one delivery snapshot commit. */
export function deliveryEnvironment(commit: DeliveryCommitMetadata): NodeJS.ProcessEnv {
  return {
    GIT_AUTHOR_NAME: commit.identity.name,
    GIT_AUTHOR_EMAIL: commit.identity.email,
    GIT_COMMITTER_NAME: commit.identity.name,
    GIT_COMMITTER_EMAIL: commit.identity.email,
    GIT_AUTHOR_DATE: commit.at,
    GIT_COMMITTER_DATE: commit.at,
  };
}

/** Materialize one delivery snapshot commit over the given parents. */
export async function materializeSnapshotCommit(
  repository: GitRepository,
  tree: GitObjectId,
  parents: readonly SnapshotId[],
  message: string | Uint8Array,
  environment: NodeJS.ProcessEnv,
): Promise<SnapshotId> {
  const args = parents.flatMap((parent) => ["-p", gitObjectIdForSnapshot(parent)]);
  const oid = (await executeGit(repository, ["commit-tree", tree, ...args], message, environment))
    .toString("utf8")
    .trim();
  return mintSnapshotId(oid);
}

/** Materialize the tender tree when it contains admitted dirty workspace bytes. */
export async function materializeTenderSnapshot(
  repository: GitRepository,
  tender: TenderCapture,
  commit: DeliveryCommitMetadata,
): Promise<SnapshotId> {
  if (!tender.dirty && tender.mergeHead === undefined) return tender.head;
  const parents = tender.mergeHead === undefined ? [tender.head] : [tender.head, tender.mergeHead];
  return await materializeSnapshotCommit(repository, tender.tree, parents, commit.message, deliveryEnvironment(commit));
}
