import { execFileSync } from "node:child_process";
import { appendFileSync, chmodSync, cpSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Repo } from "../../src/index.js";
import { readManagedWorktreeAppointment } from "../../src/workspace-place.js";
import type { ContractId } from "../../src/core/facts/types.js";
import { observeContractAt } from "../../src/git/observe.js";
import { withGitDecodeChannel } from "../../src/git/read-observation.js";
import type { GitRepository } from "../../src/git/process.js";
import { repositoryAt as productionRepositoryAt } from "../../src/git/repository.js";

const repositoryCapabilities = new Map<string, Promise<GitRepository>>();
const repositoryTemplateHasTrackedEntries = new WeakMap<TestGitRepository, boolean>();
const repos = new Map<string, Promise<Repo>>();

export function cachedRepoAt(path: string, gitPath = "git"): Promise<Repo> {
  const key = `${resolve(path)}\0${gitPath}`;
  const existing = repos.get(key);
  if (existing !== undefined) return existing;

  const repo = Repo.at({ path, gitPath });
  repos.set(key, repo);
  void repo.catch(() => {
    if (repos.get(key) === repo) repos.delete(key);
  });
  return repo;
}

export function cachedRepositoryAt(cwd: string, gitPath = "git"): Promise<GitRepository> {
  const key = `${resolve(cwd)}\0${gitPath}`;
  const existing = repositoryCapabilities.get(key);
  if (existing !== undefined) return existing;

  const capability = productionRepositoryAt(cwd, gitPath);
  repositoryCapabilities.set(key, capability);
  void capability.catch(() => {
    if (repositoryCapabilities.get(key) === capability) repositoryCapabilities.delete(key);
  });
  return capability;
}

export interface TestGitRepository {
  readonly path: string;
  readonly run: (args: readonly string[], input?: string | Uint8Array) => string;
}

export function gitExecutablePath(): string {
  const locator = process.platform === "win32" ? "where.exe" : "which";
  return execFileSync(locator, ["git"], { encoding: "utf8" }).split(/\r?\n/u)[0]!.trim();
}

export function withGitShim<T>(
  body: string,
  variables: Readonly<Record<string, string>>,
  action: (gitPath: string) => Promise<T>,
): Promise<T>;
export function withGitShim<T>(
  body: string,
  variables: Readonly<Record<string, string>>,
  action: (gitPath: string) => T,
): T;
export function withGitShim<T>(
  body: string,
  variables: Readonly<Record<string, string>>,
  action: (gitPath: string) => T | Promise<T>,
): T | Promise<T> {
  const directory = mkdtempSync(join(tmpdir(), "keiyaku-v4-git-shim-"));
  const realGit = gitExecutablePath();
  const shimPath = join(directory, "git");
  const shellQuote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;
  const assignments = Object.entries({ KEIYAKU_REAL_GIT: realGit, ...variables })
    .map(([key, value]) => `${key}=${shellQuote(value)}`)
    .join("\n");
  writeFileSync(
    shimPath,
    `#!/bin/sh\n${assignments}\nexport ${Object.keys({ KEIYAKU_REAL_GIT: realGit, ...variables }).join(" ")}\n${body}\n`,
    { mode: 0o755 },
  );
  chmodSync(shimPath, 0o755);
  try {
    return action(shimPath);
  } catch (error) {
    throw error;
  }
}

function initializedGitRepository(): TestGitRepository {
  const path = mkdtempSync(join(tmpdir(), "keiyaku-v4-"));
  execFileSync("git", ["init", "--quiet", "--initial-branch=main", path]);
  appendFileSync(
    join(path, ".git", "config"),
    "\n[user]\n\tname = Keiyaku Test\n\temail = keiyaku-test@example.invalid\n[core]\n\tautocrlf = false\n",
  );
  const run = (args: readonly string[], input?: string | Uint8Array): string =>
    execFileSync("git", ["-C", path, ...args], { input, encoding: "utf8" }).toString();
  return { path, run };
}

let emptyRepositoryTemplate: TestGitRepository | undefined;

export function makeGitRepository(): TestGitRepository {
  const template = (emptyRepositoryTemplate ??= initializedGitRepository());
  return snapshotGitRepository(template);
}

export function snapshotGitRepository(source: TestGitRepository): TestGitRepository {
  const directory = mkdtempSync(join(tmpdir(), "keiyaku-v4-snapshot-"));
  const path = join(directory, "repository");
  cpSync(source.path, path, { recursive: true, dereference: false, preserveTimestamps: true, verbatimSymlinks: true });
  let hasTrackedEntries = repositoryTemplateHasTrackedEntries.get(source);
  if (hasTrackedEntries === undefined) {
    hasTrackedEntries = source.run(["ls-files", "--cached", "-z"]) !== "";
    repositoryTemplateHasTrackedEntries.set(source, hasTrackedEntries);
  }
  if (hasTrackedEntries) {
    execFileSync("git", ["-C", path, "update-index", "--refresh", "-q"]);
  }
  const run = (args: readonly string[], input?: string | Uint8Array): string =>
    execFileSync("git", ["-C", path, ...args], { input, encoding: "utf8" }).toString();
  return { path, run };
}

export function cloneGitRepository(source: TestGitRepository): TestGitRepository {
  const path = mkdtempSync(join(tmpdir(), "keiyaku-v4-clone-"));
  execFileSync("git", ["clone", "--quiet", source.path, path]);
  execFileSync("git", ["-C", path, "fetch", "--quiet", "origin", "refs/heads/keiyaku-state:refs/heads/keiyaku-state"]);
  const run = (args: readonly string[], input?: string | Uint8Array): string =>
    execFileSync("git", ["-C", path, ...args], { input, encoding: "utf8" }).toString();
  return { path, run };
}

export function gitRepositoryPath(): string {
  return mkdtempSync(join(tmpdir(), "keiyaku-v4-"));
}

export function observeContract(repository: GitRepository, id: ContractId) {
  return withGitDecodeChannel(repository, (channel) => observeContractAt(repository, channel, id));
}

export async function appointedWorktreePath(repository: GitRepository, contract: ContractId): Promise<string> {
  const appointment = await readManagedWorktreeAppointment(repository, contract);
  if (appointment.kind !== "appointed") {
    throw new Error(`expected appointed Place for ${contract}, got ${appointment.kind}`);
  }
  return appointment.path;
}
