import { createHash } from "node:crypto";
import { z } from "zod";
import { readFile, realpath, stat } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { contractId, type ContractId, type ContractTarget, type SnapshotId } from "../core/facts/types.js";
import { appointmentFor, readPlaceRegister } from "../workspace-place.js";
import { contractIdSchema, mintSnapshotId } from "./identity.js";
import { executeGit, GitPlumbingError, type GitRepository } from "./process.js";
import { commonGitDirectory, currentBranch, registeredWorktrees, worktreeGitDirectory } from "./repository.js";
import { workspaceMergeStatePresent, worktreePath } from "./workspace.js";

export type ContractDestination = Exclude<ContractTarget, string>;
export const targetWorkspaceRefusalSchema = z
  .object({
    kind: z.literal("target-workspace-unavailable"),
    contractId: contractIdSchema,
    reason: z.enum(["unappointed", "missing", "association", "replaced", "attached", "uncommitted", "operation"]),
  })
  .strict();
export type TargetWorkspaceRefusal = z.infer<typeof targetWorkspaceRefusalSchema>;
type TargetWorkspaceReason = TargetWorkspaceRefusal["reason"];
type TargetResolution =
  | Readonly<{ kind: "resolved"; target: ContractDestination; path: string; head: SnapshotId }>
  | Readonly<{ kind: "refused"; refusal: TargetWorkspaceRefusal }>;

export function targetRepository(repository: GitRepository, target: ContractTarget): GitRepository {
  return typeof target === "string" ? repository : { ...repository, effectiveCwd: repository.primaryWorktree };
}

export function targetRef(target: ContractTarget): string {
  return typeof target === "string" ? target : `worktrees/${target.worktree.id}/HEAD`;
}

async function fingerprint(root: string, admin: string): Promise<string> {
  const [a, b] = await Promise.all([stat(root, { bigint: true }), stat(admin, { bigint: true })]);
  const identity = [a, b].map((entry) => `${entry.dev}:${entry.ino}:${entry.birthtimeNs}`).join("|");
  return createHash("sha256").update(identity).digest("hex");
}

/** Prove only the existing Place and its linked-worktree incarnation; never create or adopt it. */
export async function resolveContractTarget(
  repository: GitRepository,
  id: ContractId,
  expected?: ContractDestination,
): Promise<TargetResolution> {
  const refuse = (reason: TargetWorkspaceReason): TargetResolution => ({
    kind: "refused",
    refusal: { kind: "target-workspace-unavailable", contractId: id, reason },
  });
  const place = appointmentFor(await readPlaceRegister(repository), contractId(id));
  if (place === undefined) return refuse("unappointed");
  const path = worktreePath(repository, place.place);
  try {
    const root = await realpath(path);
    if (root !== resolve(path)) return refuse("association");
    const registered = (await registeredWorktrees(repository)).find((worktree) => worktree.path === root);
    if (registered === undefined) return refuse("association");
    const admin = await worktreeGitDirectory(repository, root);
    const parent = await realpath(join(commonGitDirectory(repository), "worktrees"));
    if (dirname(admin) !== parent) return refuse("association");
    const adminId = basename(admin);
    const reverse = (await readFile(join(admin, "gitdir"), "utf8")).trim();
    if ((await realpath(reverse)) !== (await realpath(join(root, ".git")))) return refuse("association");
    const identity = await fingerprint(root, admin);
    if (expected !== undefined && (expected.worktree.id !== adminId || expected.worktree.identity !== identity))
      return refuse("replaced");
    if (registered.branch !== null || (await currentBranch(repository, root)) !== null) return refuse("attached");
    if (await workspaceMergeStatePresent(repository, root)) return refuse("operation");
    let head: SnapshotId;
    try {
      head = mintSnapshotId(
        (await executeGit(repository, ["-C", root, "rev-parse", "--verify", "HEAD^{commit}"])).toString("utf8").trim(),
      );
    } catch (error) {
      if (error instanceof GitPlumbingError && error.status !== null) return refuse("uncommitted");
      throw error;
    }
    return {
      kind: "resolved",
      target: { kind: "contract", contractId: id, worktree: { id: adminId, identity } },
      path: root,
      head,
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return refuse("missing");
    if (error instanceof GitPlumbingError && error.status !== null) return refuse("association");
    throw error;
  }
}
