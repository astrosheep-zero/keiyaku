import { access, lstat, realpath, rm } from "node:fs/promises";
import { isAbsolute, relative, sep } from "node:path";
import type { ContractId } from "../core/facts/types.js";
import { nukeEmptyPlaceAuthority, readPlaceRegister, releaseManagedWorktrees } from "../workspace-place.js";
import type { WorldRoot } from "../world.js";
import { nukeWorktreeHookResidue } from "./hooks.js";
import { runGit, type GitRepository } from "./process.js";
import {
  CANDIDATE_PIN_REF_NAMESPACE,
  DELIVERY_REF_NAMESPACE,
  GIT_REF,
  MIGRATION_CANDIDATE_PIN_REF_NAMESPACE,
  MIGRATION_DELIVERY_REF_NAMESPACE,
  NoGitWorldError,
  readRef,
  registeredWorktrees,
  repositoryAt,
  worktreeGitDirectory,
} from "./repository.js";
import { worktreePath } from "./workspace.js";

type ManagedEntry = Readonly<{ contract: ContractId; path: string }>;

async function managedCustody(repository: GitRepository): Promise<Readonly<{ entries: readonly ManagedEntry[] }>> {
  const register = await readPlaceRegister(repository);
  return {
    entries: register.appointments.map((appointment) => ({
      contract: appointment.contract,
      path: worktreePath(repository, appointment.place),
    })),
  };
}

function underCommonDirectory(commonDirectory: string, administrationDirectory: string): boolean {
  const suffix = relative(commonDirectory, administrationDirectory);
  return suffix.length > 0 && suffix !== ".." && !suffix.startsWith(`..${sep}`) && !isAbsolute(suffix);
}

async function unregisteredResidueBelongsToRepository(repository: GitRepository, path: string): Promise<boolean> {
  let physical;
  try {
    physical = await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
    throw error;
  }
  if (!physical.isDirectory() || physical.isSymbolicLink()) return false;
  let administrationDirectory: string;
  try {
    administrationDirectory = await worktreeGitDirectory(repository, path);
  } catch {
    return false;
  }
  try {
    const [common, administration] = await Promise.all([
      realpath(repository.commonDirectory),
      realpath(administrationDirectory),
    ]);
    return underCommonDirectory(common, administration);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function removeUnregisteredResidue(repository: GitRepository, entry: ManagedEntry): Promise<boolean> {
  let present = true;
  try {
    await access(entry.path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") present = false;
    else throw error;
  }
  if (!present) return true;
  if (!(await unregisteredResidueBelongsToRepository(repository, entry.path))) {
    throw new Error(`managed Place path has foreign custody: ${entry.path}`);
  }
  const administrationDirectory = await worktreeGitDirectory(repository, entry.path);
  await nukeWorktreeHookResidue(administrationDirectory);
  await rm(entry.path, { recursive: true, force: true });
  try {
    await access(entry.path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
    throw error;
  }
  throw new Error(`managed Place worktree remains present: ${entry.path}`);
}

async function removeManagedWorktree(repository: GitRepository, entry: ManagedEntry): Promise<boolean> {
  const registered = (await registeredWorktrees(repository)).find((candidate) => candidate.path === entry.path);
  if (registered === undefined) return await removeUnregisteredResidue(repository, entry);
  if (registered.branch !== null) return false;
  await nukeWorktreeHookResidue(await worktreeGitDirectory(repository, entry.path));
  await runGit(repository, ["worktree", "remove", "--force", entry.path]);
  if ((await registeredWorktrees(repository)).some((candidate) => candidate.path === entry.path)) {
    throw new Error(`managed Place worktree remains registered: ${entry.path}`);
  }
  try {
    await access(entry.path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
    throw error;
  }
  throw new Error(`managed Place worktree remains present: ${entry.path}`);
}

async function deleteRefAt(repository: GitRepository, ref: string, expectedOid: string): Promise<void> {
  await runGit(repository, ["update-ref", "--no-deref", "-d", ref, expectedOid]);
}

async function removeOwnedRefs(repository: GitRepository): Promise<void> {
  const roots = [
    DELIVERY_REF_NAMESPACE,
    CANDIDATE_PIN_REF_NAMESPACE,
    MIGRATION_DELIVERY_REF_NAMESPACE,
    MIGRATION_CANDIDATE_PIN_REF_NAMESPACE,
  ] as const;
  for (const root of roots) {
    const refs = (await runGit(repository, ["for-each-ref", "--format=%(refname)", root]))
      .toString("utf8")
      .split("\n")
      .filter((ref) => ref.length > root.length && ref.startsWith(`${root}/`));
    for (const ref of refs) {
      const oid = await readRef(repository, ref);
      if (oid !== null) await deleteRefAt(repository, ref, oid);
    }
  }
}

export async function nukeGit(world: WorldRoot, gitPath = "git"): Promise<void> {
  let repository: GitRepository;
  try {
    repository = await repositoryAt(world, gitPath);
  } catch (error) {
    if (error instanceof NoGitWorldError) return;
    throw error;
  }
  const state = await readRef(repository, GIT_REF);
  if (state !== null) await deleteRefAt(repository, GIT_REF, state);

  const custody = await managedCustody(repository);
  for (const entry of custody.entries) {
    if (await removeManagedWorktree(repository, entry)) await releaseManagedWorktrees(repository, [entry.contract]);
  }
  await nukeEmptyPlaceAuthority(repository);
  await removeOwnedRefs(repository);
}
