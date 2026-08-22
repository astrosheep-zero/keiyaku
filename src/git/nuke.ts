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

async function managedCustody(repository: GitRepository): Promise<
  Readonly<{
    entries: readonly ManagedEntry[];
  }>
> {
  const register = await readPlaceRegister(repository);
  const entries: ManagedEntry[] = [];
  for (const appointment of register.appointments) {
    const path = worktreePath(repository, appointment.place);
    entries.push({ contract: appointment.contract, path });
  }
  return { entries };
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

async function removeUnregisteredResidue(repository: GitRepository, entry: ManagedEntry): Promise<void> {
  let present = true;
  try {
    await access(entry.path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") present = false;
    else throw error;
  }
  if (!present) return;
  if (!(await unregisteredResidueBelongsToRepository(repository, entry.path))) {
    throw new Error(`managed Place path has foreign custody: ${entry.path}`);
  }
  const administrationDirectory = await worktreeGitDirectory(repository, entry.path);
  await nukeWorktreeHookResidue(administrationDirectory);
  await rm(entry.path, { recursive: true, force: true });
  try {
    await access(entry.path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  throw new Error(`managed Place worktree remains present: ${entry.path}`);
}

async function removeManagedWorktree(repository: GitRepository, entry: ManagedEntry): Promise<boolean> {
  const topology = await registeredWorktrees(repository);
  const registered = topology.find((candidate) => candidate.path === entry.path);
  if (registered === undefined) {
    await removeUnregisteredResidue(repository, entry);
    return true;
  }
  if (registered.branch !== null) return false;
  await nukeWorktreeHookResidue(await worktreeGitDirectory(repository, entry.path));
  await runGit(repository, ["worktree", "remove", "--force", entry.path]);
  if ((await registeredWorktrees(repository)).some((candidate) => candidate.path === entry.path)) {
    throw new Error(`managed Place worktree remains registered: ${entry.path}`);
  }
  try {
    await access(entry.path);
  } catch {
    return true;
  }
  throw new Error(`managed Place worktree remains present: ${entry.path}`);
}

async function removeOwnedRefs(repository: GitRepository): Promise<unknown | undefined> {
  let firstFailure: unknown;
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
      try {
        const oid = await readRef(repository, ref);
        if (oid !== null) await runGit(repository, ["update-ref", "--no-deref", "-d", ref, oid]);
      } catch (error) {
        firstFailure ??= error;
      }
    }
  }
  return firstFailure;
}

export async function nukeGit(world: WorldRoot): Promise<void> {
  let repository: GitRepository;
  try {
    repository = await repositoryAt(world);
  } catch (error) {
    if (error instanceof NoGitWorldError) return;
    throw error;
  }
  // The state ref is the journal root. Remove it before reading or deleting any
  // topology that a concurrent writer could regenerate from that root.
  const state = await readRef(repository, GIT_REF);
  if (state !== null) await runGit(repository, ["update-ref", "--no-deref", "-d", GIT_REF, state]);

  const custody = await managedCustody(repository);
  let firstFailure: unknown;
  for (const entry of custody.entries) {
    try {
      if (await removeManagedWorktree(repository, entry)) await releaseManagedWorktrees(repository, [entry.contract]);
    } catch (error) {
      firstFailure ??= error;
    }
  }
  firstFailure ??= await removeOwnedRefs(repository);
  try {
    await nukeEmptyPlaceAuthority(repository);
  } catch (error) {
    firstFailure ??= error;
  }
  if (firstFailure !== undefined) throw firstFailure;
}
