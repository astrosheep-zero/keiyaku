import { access } from "node:fs/promises";
import type { ContractId } from "../core/facts/types.js";
import { nukeEmptyPlaceAuthority, readPlaceRegister, releaseManagedWorktrees } from "../workspace-place.js";
import type { WorldRoot } from "../world.js";
import { nukeWorktreeHookResidue } from "./hooks.js";
import { runGit, type GitRepository } from "./process.js";
import { NoGitWorldError, registeredWorktrees, repositoryAt, worktreeGitDirectory } from "./repository.js";
import { worktreePath } from "./workspace.js";

type ManagedEntry = Readonly<{ contract: ContractId; path: string }>;

async function managedCustody(repository: GitRepository): Promise<
  Readonly<{
    entries: readonly ManagedEntry[];
    refs: readonly string[];
    state: boolean;
  }>
> {
  const register = await readPlaceRegister(repository);
  const topology = new Map((await registeredWorktrees(repository)).map((entry) => [entry.path, entry]));
  const entries: ManagedEntry[] = [];
  for (const appointment of register.appointments) {
    const path = worktreePath(repository, appointment.place);
    const registered = topology.get(path);
    if (registered === undefined) {
      try {
        await access(path);
      } catch {
        entries.push({ contract: appointment.contract, path });
        continue;
      }
      throw new Error(`managed Place path has foreign custody: ${path}`);
    }
    if (registered.branch !== null) throw new Error(`managed Place path has a branch: ${path}`);
    entries.push({ contract: appointment.contract, path });
  }
  const refs = (
    await runGit(repository, [
      "for-each-ref",
      "--format=%(refname)",
      "refs/heads/keiyaku-delivery",
      "refs/heads/keiyaku-candidate",
    ])
  )
    .toString("utf8")
    .split("\n")
    .filter((ref) => ref.length > 0);
  const state = await runGit(repository, ["show-ref", "--verify", "--quiet", "refs/heads/keiyaku-state"]).then(
    () => true,
    () => false,
  );
  return { entries, refs, state };
}

async function removeManagedWorktree(repository: GitRepository, entry: ManagedEntry): Promise<void> {
  const topology = await registeredWorktrees(repository);
  const registered = topology.find((candidate) => candidate.path === entry.path);
  if (registered === undefined) {
    try {
      await access(entry.path);
    } catch {
      return;
    }
    throw new Error(`managed Place path has foreign custody: ${entry.path}`);
  }
  if (registered.branch !== null) throw new Error(`managed Place path has a branch: ${entry.path}`);
  await nukeWorktreeHookResidue(await worktreeGitDirectory(repository, entry.path));
  await runGit(repository, ["worktree", "remove", "--force", entry.path]);
  if ((await registeredWorktrees(repository)).some((candidate) => candidate.path === entry.path)) {
    throw new Error(`managed Place worktree remains registered: ${entry.path}`);
  }
  try {
    await access(entry.path);
  } catch {
    return;
  }
  throw new Error(`managed Place worktree remains present: ${entry.path}`);
}

async function removeOwnedRefs(repository: GitRepository, refs: readonly string[]): Promise<void> {
  for (const ref of refs) {
    const oid = (await runGit(repository, ["rev-parse", "--verify", "--quiet", ref])).toString("utf8").trim();
    if (oid.length > 0) await runGit(repository, ["update-ref", "--no-deref", "-d", ref, oid]);
  }
}

export async function nukeGit(world: WorldRoot): Promise<void> {
  let repository: GitRepository;
  try {
    repository = await repositoryAt(world);
  } catch (error) {
    if (error instanceof NoGitWorldError) return;
    throw error;
  }
  const custody = await managedCustody(repository);
  for (const entry of custody.entries) {
    await removeManagedWorktree(repository, entry);
    await releaseManagedWorktrees(repository, [entry.contract]);
  }
  await nukeEmptyPlaceAuthority(repository);
  await removeOwnedRefs(repository, custody.refs);
  if (custody.state) {
    const oid = (await runGit(repository, ["rev-parse", "--verify", "refs/heads/keiyaku-state"]))
      .toString("utf8")
      .trim();
    await runGit(repository, ["update-ref", "--no-deref", "-d", "refs/heads/keiyaku-state", oid]);
  }
}
